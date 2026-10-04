/**
 * 向导的**落地动作**与**证据读取**（T28c，spec §6.11）。
 *
 * 两类函数，都不含判定逻辑（判定在 `logic.ts`）：
 *
 *   · `install*` —— 把包内的 `persona/*.md` 与 `presets/*` 装到 `$DSH_HOME`。
 *     **这是"人格真的生效"那一步**：只写 `$DSH_HOME/yanxin/persona/base.md` 而没装 preset，
 *     agent 挂上的是没有这一行的 preset —— 人格等于没装。
 *   · `readEvidence` —— 从磁盘如实读现场（文件在不在、世界创世没有、账号注册了几个）。
 *     它**只回答事实**，不替判定做决定。
 *
 * ## 路径惯例
 *
 * 全部落在 `$DSH_HOME/yanxin/` 下（与 `memory-outbox/`、`audit/`、`reme/` 同一套惯例）：
 *
 * ```
 * $DSH_HOME/yanxin/persona/{base,profile,world}.md   # 源（运营者可以改）
 * $DSH_HOME/yanxin/world/                            # 世界（clock.json + 事务日志 + notes/）
 * $DSH_HOME/yanxin/setup.json                        # 向导进度
 * $DSH_HOME/.agent-presets/<id>/                     # 生成产物（DSH 从这里挂载）
 * ```
 *
 * ## 原子写入
 *
 * 一律临时文件 + rename：预设与人格是 agent 每次启动都会读的东西，
 * 读到**半个文件**会让挂载失败（而失败信息会很难指向真正的原因）。
 */
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { embedPersonaText } from '../preset/persona-embed.ts'
import {
  composePersona,
  isPersonaDraftTemplate,
  MODE_BY_PRESET_ID,
  PERSONA_SOURCE_NAMES,
  type PersonaSources,
} from '../preset/render.ts'
import type { SetupEvidence } from './logic.ts'
import type { SetupStep } from './types.ts'

/** `$DSH_HOME`（与 `memory/outbox.ts`、`net/url-guard.ts` 同一套回退）。 */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 我们的数据根：`$DSH_HOME/yanxin`。 */
export function yanxinDir(home: string = dshHome()): string {
  return join(home, 'yanxin')
}

/** 人格源目录。 */
export function personaDir(home: string = dshHome()): string {
  return join(yanxinDir(home), 'persona')
}

/** 世界目录（T21 的 clock、T20 的内核日志、笔记都在这里）。 */
export function worldDir(home: string = dshHome()): string {
  return join(yanxinDir(home), 'world')
}

/** 向导进度的落盘位置。 */
export function setupFile(home: string = dshHome()): string {
  return join(yanxinDir(home), 'setup.json')
}

/** DSH 的用户 preset 根（agent 从这里挂载）。 */
export function presetRoot(home: string = dshHome()): string {
  return join(home, '.agent-presets')
}

/**
 * 步骤 → 它要装的人格源文件（`persona/` 里的文件名）。
 *
 * ⚠️ `accounts` 没有源文件：它绑的是账号，源在 onebot 行的部署配置里（见 `index.ts`）。
 */
export const PERSONA_SOURCE_FILES: Partial<Record<SetupStep, string>> = {
  persona: PERSONA_SOURCE_NAMES.base,
  background: PERSONA_SOURCE_NAMES.profile,
  world: PERSONA_SOURCE_NAMES.world,
}

/** 内置的包根（`persona/`、`presets/` 所在）—— 相对于本文件编译后的位置。 */
export function defaultPackageRoot(): string {
  // src/setup/install.ts → 或 lib/setup/install.js → 都是上两级
  return join(import.meta.dirname, '..', '..')
}

export interface InstallPaths {
  /** `$DSH_HOME`。 */
  home: string
  /** 包根：`persona/` 与 `presets/` 在这里。 */
  packageRoot: string
}

export interface InstallOutcome {
  /** 这一趟做了什么（给人看的一句话，控制台直接显示）。 */
  detail: string
  /** 落盘的文件（相对 `$DSH_HOME`，便于日志与测试断言）。 */
  written: string[]
}

/**
 * 装一个步骤的人格源（包内 `persona/<file>` → `$DSH_HOME/yanxin/persona/<file>`）。
 *
 * ⚠️ **在位就不装**（present-if-absent）：这份文件是**运营者的**，他可以在
 * `$DSH_HOME/yanxin/persona/` 里改。而向导**鼓励回退重跑**（换人格、重建世界）——
 * 若重跑时无条件覆盖，回退一次就把他的改动抹了。所以：
 *   · 文件有内容 → 保留他的那份（`written` 为空，如实说明"没动"）
 *   · 文件没有 / 不存在 → 从包内装一份出厂文本
 *
 * 代价：我们更新出厂人格文本后，老安装不会自动跟上（要删掉那份再重跑，或用控制台改）。
 * 这是刻意的取舍 —— 人格是运营者的东西，不该被一次重跑悄悄替换。
 *
 * @throws 包内源文件不存在或为空时 —— 那是打包错误（`files` 里漏了 `persona`），
 *   必须报出来，而不是装一份空人格下去
 */
export async function installPersonaSource(paths: InstallPaths, step: SetupStep): Promise<InstallOutcome> {
  const file = PERSONA_SOURCE_FILES[step]
  if (file === undefined) return { detail: `${step} 不需要人格源文件`, written: [] }

  const source = join(paths.packageRoot, 'persona', file)
  const text = await readFile(source, 'utf8')
  if (text.trim() === '') throw new Error(`包内的人格源是空的：${source}（打包漏了 persona/ ？）`)

  const target = join(personaDir(paths.home), file)
  if (await hasContent(target)) {
    return { detail: `${file} 已经在位（保留你自己那份）`, written: [] }
  }

  await writeAtomic(target, text)
  return { detail: `人格源已就位：${file}`, written: [join('yanxin', 'persona', file)] }
}

/**
 * 包内的 preset 目录（含 `agent.cordis.yml` 的），按名字排序。
 *
 * `presets/` 目录整个不在时返回空数组（**不抛**）：那是打包问题，由调用方用
 * "一个 preset 都没有：<路径>" 那条更清楚的错误报出来 —— 这里报 ENOENT 只会让人去查文件系统。
 */
export async function sourcePresets(packageRoot: string): Promise<string[]> {
  const root = join(packageRoot, 'presets')
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const hasYml = await exists(join(root, entry.name, 'agent.cordis.yml'))
    if (hasYml) ids.push(entry.name)
  }
  return ids.sort()
}

/** 一个 preset 目录要装的三个文件（`preset.yml` 是可选的：不是每个 preset 都有元信息）。 */
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const

/**
 * 把三个 preset 装到 `$DSH_HOME/.agent-presets/`（DSH 的挂载点）。
 *
 * 幂等：内容一样也照样写（rename 是原子的，"看起来没变"不值得做一次读比对）。
 *
 * ⚠️ **人格段不是从包内拷来的，是重新嵌入的**（`effectivePersonaSources`）——
 * 直接拷包内那份会把运营者在控制台人格页写过的东西**静默覆盖**回出厂模板。
 * 这条不是防御性设计：向导的三步都会调这里，先写人格再跑向导是**推荐路径**，
 * 少这一步她就变成一个空模板。
 *
 * 只认本仓那三个 preset id（`render.ts` 的 `PRESET_IDS`）；别的目录原样拷 ——
 * 结构归包内文件所有，这里不猜。
 */
export async function installPresets(paths: InstallPaths): Promise<InstallOutcome> {
  const ids = await sourcePresets(paths.packageRoot)
  if (ids.length === 0) throw new Error(`包内一个 preset 都没有：${join(paths.packageRoot, 'presets')}`)

  const sources = await effectivePersonaSources(paths)
  const written: string[] = []
  for (const id of ids) {
    const mode = MODE_BY_PRESET_ID.get(id)
    for (const file of PRESET_FILES) {
      const source = join(paths.packageRoot, 'presets', id, file)
      if (!(await exists(source))) continue
      let text = await readFile(source, 'utf8')
      if (mode !== undefined && file === 'agent.cordis.yml') {
        text = embedPersonaText(text, composePersona(mode, sources))
      }
      const target = join(presetRoot(paths.home), id, file)
      await writeAtomic(target, text)
      written.push(join('.agent-presets', id, file))
    }
  }
  return { detail: `已安装 ${ids.length} 个 preset：${ids.join(' / ')}`, written }
}

/**
 * 人格的**有效来源**：装过的用装过的（`$DSH_HOME/yanxin/persona/`），没装过才用包内的。
 *
 * 方向是刻意的：装机后 DSH 读的是 `.agent-presets/` 里的嵌入结果，
 * 而那份东西的**主人是运营者** —— 出厂文本只是第一次的起点，不是真相。
 * 反过来（优先包内）就是"跑一次向导把人格里出厂模板覆盖回去"那条覆盖 bug 的另一种写法。
 */
export async function effectivePersonaSources(paths: InstallPaths): Promise<PersonaSources> {
  const out = {} as PersonaSources
  for (const key of ['base', 'profile', 'world'] as const) {
    const name = PERSONA_SOURCE_NAMES[key]
    const installed = await readOrNull(join(personaDir(paths.home), name))
    const packaged = await readOrNull(join(paths.packageRoot, 'persona', name))
    out[key] = (installed ?? packaged ?? '').trim()
  }
  return out
}

/** 读一个可能不存在的文本文件（不存在 / 读失败 → `undefined`，不抛）。 */
async function readOrNull(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

// ── 证据（事实，不是判定）──────────────────────────────────────────────────

/** 读现场证据。`accounts` 从 onebot 服务来（这里只负责搬运）。 */
export async function readEvidence(
  paths: InstallPaths,
  accounts: { registered: readonly string[]; connected: readonly string[] },
): Promise<SetupEvidence> {
  const persona = personaDir(paths.home)
  const world = worldDir(paths.home)

  const ids = await sourcePresets(paths.packageRoot)
  let installed = 0
  for (const id of ids) {
    const root = join(presetRoot(paths.home), id)
    const ok = await exists(join(root, 'agent.cordis.yml'))
    if (ok) installed += 1
  }

  return {
    persona: {
      base: await hasAuthoredPersona(join(persona, 'base.md')),
      profile: await hasAuthoredPersona(join(persona, 'profile.md')),
      world: await hasAuthoredPersona(join(persona, 'world.md')),
    },
    presets: { installed, total: ids.length },
    world: {
      transactions: await countTransactions(join(world, 'world-transactions.jsonl')),
      clock: await hasClock(join(world, 'clock.json')),
    },
    accounts: { registered: [...accounts.registered], connected: [...accounts.connected] },
  }
}

/** 文件存在且非空（空白不算）。 */
async function hasContent(file: string): Promise<boolean> {
  try {
    return (await readFile(file, 'utf8')).trim() !== ''
  } catch {
    return false
  }
}

/**
 * 这一段是不是**有人写过**（存在 + 非空 + 不是出厂空模板）。
 *
 * ⚠️ 不能退回成上面的 `hasContent`：公开包的 `persona/` 是空模板 —— 标题、小节、`> TODO`
 * 说明一样不少，按"非空"判就是"人格已装好"。于是新用户一路在空模板上创了世，
 * 症状是"她说话像说明书"，而现场每一条证据都显示正常。
 *
 * 判据宽松（见 `isPersonaDraftTemplate`）：误判方向是"说她还没被写过"，
 * 那在页面上看得见、改得动；反过来（悄悄放行空模板）才会坑人。
 */
async function hasAuthoredPersona(file: string): Promise<boolean> {
  const text = await readOrNull(file)
  if (text === undefined || text.trim() === '') return false
  return !isPersonaDraftTemplate(text)
}

/**
 * 数事务日志里**能解析的**行数。
 *
 * ⚠️ 不数"非空行"：append 被打断会留下半行，把它算成一条事务会让证据虚高
 * （内核自己也只容忍最后一行不完整，见 `kernel.ts` 的崩溃语义）。
 */
async function countTransactions(file: string): Promise<number> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return 0
  }
  let count = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as { sequence?: unknown }
      if (typeof parsed.sequence === 'number') count += 1
    } catch {
      // 半行：不算（它与内核重放时的判断一致）
    }
  }
  return count
}

/** `clock.json` 在且带纪元锚点（缺锚点等于没有时间来源）。 */
async function hasClock(file: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { genesisMs?: unknown }
    return typeof parsed.genesisMs === 'number'
  } catch {
    return false
  }
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** 原子写：临时文件 + rename（读者永远看不到半个文件）。 */
export async function writeAtomic(target: string, text: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, target)
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}