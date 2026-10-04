/**
 * 人格页 —— **在控制台里写她**（T32 欠的那条写路径）。
 *
 * ## 为什么这一页必须存在
 *
 * 出厂的 `persona/` 是空模板（公开包里那句人格由运营者写）。在此之前改人格只有一条路：
 * 手改 `$DSH_HOME/yanxin/persona/*.md` → 跑 `node scripts/build-presets.mjs` → 重装 preset。
 * 三步都靠人记得做，漏掉任何一步的症状都是**"她说话和她的人格里写的不一样"** ——
 * 而那会被归因成"模型不行"。这一页把三步并成一次保存。
 *
 * ## 三条纪律
 *
 *   · **人格源是运营者的，preset 是产物**：这里只写 `yanxin/persona/` 下的源，
 *     然后请 `installPresets` 重新嵌入。**不手改 `.agent-presets/` 里的文件** ——
 *     那是产物，手改会在下一次安装时被覆盖。
 *   · **一次请求只认三个键**（`base` / `profile` / `world`）：照 OneBot 页的白名单写法。
 *     不收整份 body 是为了不让"这张表单只改了背景"却顺手把基底也写了这种事发生。
 *   · **不接受空人格**：清空她的 system prompt 应该是一件要到文件系统里明确做的事，
 *     不该由一次误提交完成（三个框都预填了内容，清空再提交几乎必然是手滑）。
 *
 * ## 生效时机（如实告诉用户）
 *
 * DSH 的 preset 装载器每条消息都重新读盘、按内容戳判定，所以保存后**新建的会话**用的就是
 * 新人格；而**已经活着的会话**复用内存里的 agent 句柄，不会中途换人 —— 这一条由桥的
 * `dropIdleAgents()` 处理：只释放**当下不在处理消息**的会话，正在跑的那一轮绝不打断。
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  defaultPackageRoot,
  dshHome,
  effectivePersonaSources,
  installPresets,
  personaDir,
  writeAtomic,
  type InstallPaths,
} from '../../setup/install.ts'
import {
  isPersonaDraftTemplate,
  PERSONA_SOURCE_NAMES,
  type PersonaSources,
} from '../../preset/render.ts'
import type { Block } from '../logic.ts'

/** 装配纪律（ADR 0004）：命名导出 + `inject`，**不写 default**。 */
export const name = 'yanxin-console-persona-page'
export const inject = ['console']

/** 桥的软查接口（不在时这一页照常能存，只是没人立刻换人格）。 */
interface BridgeLike {
  /**
   * ⚠️ 返回 promise：桥必须**等句柄真的从 store 里摘掉**才算释放完成。
   * 不 await 的话下一条消息会撞在还没摘掉的条目上（`session "…" already exists`，
   * 那一轮静默丢掉）—— 2026-10-04 线上 50 次即为此。
   */
  dropIdleAgents?: (reason: string) => Promise<number>
}

/** 三个键就是这一页的全部可写面。 */
const SOURCE_KEYS = ['base', 'profile', 'world'] as const

type SourceKey = (typeof SOURCE_KEYS)[number]

const LABELS: Record<SourceKey, string> = {
  base: '人格基底（base）',
  profile: '背景资料（profile）',
  world: '世界定义（world）',
}

/** 装页与接口。 */
export function apply(ctx: Context): void {
  ctx.console.page({
    slug: 'persona',
    title: '人格',
    async render({ base }) {
      return renderPersonaBlocks(await readSources(), base)
    },
  })

  ctx.console.api({
    route: 'persona/save',
    method: 'POST',
    async handler({ body }) {
      return savePersona(ctx, body)
    },
  })
}

/** 人格源：装了用装的，没装过用包内的 —— 与装载时同一套解析，两处不会读到两份东西。 */
async function readSources(): Promise<PersonaSources> {
  return effectivePersonaSources(packagePaths())
}

function packagePaths(): InstallPaths {
  return { home: dshHome(), packageRoot: defaultPackageRoot() }
}

function renderPersonaBlocks(sources: PersonaSources, base: string): readonly Block[] {
  const blocks: Block[] = [
    {
      kind: 'p',
      text:
        '这三段就是她 system prompt 的全部来源。保存后会**立刻重新嵌入**三个 preset —— ' +
        '新开的会话用新人格，正在进行的会话说完这一句再换。',
    },
  ]

  if (stillDraft(sources)) {
    blocks.push({
      kind: 'notice',
      tone: 'warn',
      text: '现在装着的还是**出厂空模板**（里面全是 TODO）。初始化向导会等这一步做完 —— 在空模板上创世，她会用说明书的口吻说话。',
    })
  }

  blocks.push({
    kind: 'form',
    action: `${base}/api/persona/save`,
    submit: '保存并重新嵌入',
    fields: SOURCE_KEYS.map((key) => ({
      name: key,
      label: LABELS[key],
      type: 'textarea' as const,
      value: sources[key],
      hint: `yanxin/persona/${PERSONA_SOURCE_NAMES[key]}`,
    })),
  })

  blocks.push({
    kind: 'ul',
    items: [
      '三段是**叠加**的：群聊与管理员用「基底 + 背景」，世界模式在其后再加一段"你在自己的世界里"与「世界定义」。',
      '管理员私聊比群聊多的只是工具（shell / 文件 / 子代理），人格完全相同。',
      '想回滚：把文本改回去再保存就行 —— 源文件是纯文本，不在这一页也能改。',
    ],
  })

  return blocks
}

/**
 * 保存：写源 → 重新嵌入 → 让空闲会话换人。
 *
 * 返回形状沿用各页约定：成功 `{ detail, … }`，失败 `{ error }`（客户端读 `data.error` 显示，
 * 而控制台的审计把带 `error` 的响应记成**失败**）。
 */
async function savePersona(ctx: Context, body: unknown): Promise<unknown> {
  const input = (body ?? {}) as Record<string, unknown>

  // 白名单外的一律不看（宁可拒，也不要"看起来只改了这一栏"却动了别的）
  const extras = Object.keys(input).filter(
    (key) => !(SOURCE_KEYS as readonly string[]).includes(key) && input[key] !== undefined && input[key] !== '',
  )
  if (extras.length > 0) return { error: `这一页不接受：${extras.join(' / ')}` }

  const given = SOURCE_KEYS.filter((key) => typeof input[key] === 'string')
  if (given.length === 0) return { error: '没收到任何人格文本' }

  // 空文本 = 把她的 system prompt 清空。这条路径**不存在**比"能走但没人想走"好。
  const emptied = given.filter((key) => (input[key] as string).trim() === '')
  if (emptied.length > 0) {
    return { error: `这几段是空的：${emptied.map((key) => LABELS[key]).join(' / ')} —— 这一页不接受空人格` }
  }

  const paths = packagePaths()
  const written: string[] = []
  for (const key of given) {
    const fileName = PERSONA_SOURCE_NAMES[key]
    // 统一补一个尾换行：md 文件少这一个字节，diff 里就是"整篇被重写"的噪音
    await writeAtomic(join(personaDir(paths.home), fileName), `${(input[key] as string).trimEnd()}\n`)
    written.push(`yanxin/persona/${fileName}`)
  }

  // 重新嵌入三个 preset（结构仍来自包内文件，这里只换 persona 那一段）
  const presets = await installPresets(paths)

  // 已活着的会话：只放手空闲的，正在跑的那一轮不打断
  const dropped = await releaseIdleAgents(ctx)

  return {
    // 客户端只会把 `detail` 显示成一行状态，所以"什么时候生效"必须**在这句话里**，
    // 不能另开一个字段（那等于写了但没人读 —— 用户看到的仍是"保存了"三个字）。
    detail:
      `已保存 ${written.length} 段并重新嵌入 preset（${presets.detail}）。` +
      (dropped === 0
        ? '新会话立刻用新人格；老会话下一条消息自然换（正在说的那句说完）。'
        : `已释放 ${dropped} 个空闲会话，它们下一条消息就换人。`),
    written,
    droppedIdleAgents: dropped,
  }
}

/** 桥在不在都存得下去 —— 释放句柄是锦上添花，不是前置条件。 */
async function releaseIdleAgents(ctx: Context): Promise<number> {
  const bridge = ctx.get('onebot-bridge') as BridgeLike | undefined
  return (await bridge?.dropIdleAgents?.('人格已在控制台保存')) ?? 0
}

/** 三段都还是出厂空模板吗（判据与初始化向导的证据读取同一条）。 */
function stillDraft(sources: PersonaSources): boolean {
  return SOURCE_KEYS.every((key) => isPersonaDraftTemplate(sources[key]))
}
