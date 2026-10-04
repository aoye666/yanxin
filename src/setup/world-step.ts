/**
 * `world` 步 —— 写时钟（T=0）并把世界创出来（T29，spec §6.11）。
 *
 * ## 顺序是刻意的（两处）
 *
 *   1. **先创世、后写时钟**：
 *      · 先写时钟、创世失败 → 世界里"有时间、没内容"，重试时还要处理"时钟已经在了"，
 *        留一个**需要重建才能收拾的半成品**
 *      · **先创世、写时钟失败** → 世界目录里一条事务都没有（等于没创世），重试直接从零再来
 *
 *      代价是 `clock.json` 的 T=0 是"创世成功那一刻"而不是"点了按钮那一刻" ——
 *      这个世界本来就该从"她存在的那一刻"起算，这两者的差别恰好是我们要的。
 *
 *   2. **先装配、后归档**：人格源安装与 preset 重新嵌入（②）都只碰 persona/preset
 *      目录，**不动世界**。它们全过了才轮到归档（①）—— 装配失败时旧世界原地不动，
 *      跑修好了重来即可。（反过来会把活跃世界先挪进归档、新世界又没建出来，
 *      engine 拒载、bot 失联，恢复要手工改回目录名。）
 *
 * ## 不做的事
 *
 *   · **不删旧世界**：`rebuild` 是**归档**（改名 + 时间戳），旧世界与她的笔记原样躺着，
 *     想回滚就改回目录名。删除是不可逆的，而这个功能的使用场景恰恰是"我搞错了想重来"
 *   · **不常驻时钟**：写完 T=0 就 `suspend()`（落一次精确检查点后停掉全部计时器）。
 *     世界时钟归世界引擎（窗口打开时装载），setup 不该在后台替它走时间
 *   · **不调真实 LLM**：`callModel` 由调用方注入（T27b 把 `ctx.llm` 适配进来；测试注入 mock）
 */
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallWorldModel } from '../world/arbiter.ts'
import { WorldClock } from '../world/clock.ts'
import { genesis } from '../world/genesis.ts'
import { WorldKernel } from '../world/kernel.ts'
import {
  effectivePersonaSources,
  installPersonaSource,
  installPresets,
  type InstallOutcome,
  type InstallPaths,
} from './install.ts'
import { SetupError } from './types.ts'

export interface WorldStepOptions extends InstallPaths {
  /** 世界目录（`$DSH_HOME/yanxin/world`）。 */
  worldDir: string
  /** 她在世界里的实体 id（必须出现在创世清单里）。 */
  selfId: string
  /** 世界模型调用（`WorldModelRequest` → 提案或实体清单）。 */
  callModel: CallWorldModel
  /** 世界已存在时是否归档重建（默认 `false` = 拒绝，防手滑）。 */
  rebuild?: boolean
  /** 现实时钟（测试注入；同时决定 T=0 锚点）。 */
  now?: () => number
  warn?: (message: string) => void
}

export interface WorldStepOutcome extends InstallOutcome {
  /** 创世事务的序号（世界从 1 开始）。 */
  sequence: number
  /** 归档了旧世界时，归档目录的路径。 */
  archived?: string
}

/** 这一步现在能看到的世界现场（决策依据，不做判定）。 */
export interface WorldState {
  transactions: number
  clock: boolean
}

/**
 * 跑世界步。
 *
 * @throws `STEP_BLOCKED` 世界已存在且没说要重建；`GENESIS_FAILED`（内核）模型始终给不出
 *   合法清单 —— 两种都不会留下"半成品世界"
 */
export async function runWorldStep(options: WorldStepOptions): Promise<WorldStepOutcome> {
  const now = options.now ?? (() => Date.now())
  const warn = options.warn ?? ((message: string) => console.warn(message))

  const existing = await inspect(options.worldDir)
  const exists = existing.transactions > 0 || existing.clock

  if (exists && options.rebuild !== true) {
    throw new SetupError('STEP_BLOCKED', '世界已经存在了 —— 重建要显式说明', [
      `${options.worldDir} 里已有 ${existing.transactions} 条事务${existing.clock ? '，时钟也已建立' : ''}`,
      '确定要重建时传 { rebuild: true }：旧世界会**归档**（改名保留，不删除）',
    ])
  }

  // ② 世界定义装到位（人格源 + 重新嵌入 preset —— 她的世界姿态要跟着一起生效）。
  //    只碰 persona/preset 目录，不动世界 —— 放在归档之前，失败也留不下半成品
  const source = await installPersonaSource(options, 'world')
  const presets = await installPresets(options)

  // ③ 创世用的世界定义就是**刚被嵌进 preset 的那一批源**（不再另读一份、也不再比一份）
  //
  // 这里原来有一道"installed 的 world.md ≡ 包内 persona/world.md，不同源就拦住"的检查，
  // 理由是对的（她按一份设定说话、世界的实体却是另一份，这种分叉极难查），
  // 但 `installPresets` 现在**从已安装的人格源重新嵌入** persona 段
  // （`effectivePersonaSources`）—— 走到这一步时两者由构造保证同源，检查恒真。
  //
  // 换掉它还有第二个理由：旧检查唯一的产出是让用户"去重跑 build-presets.mjs"，
  // 而运营者改人格的正确入口已经是控制台的 `/yanxin/persona` 页 —— 一条只会把人
  // 往命令行支走的拦阻，不如把他要的结果直接做出来。
  const sources = await effectivePersonaSources(options)
  const worldDoc = sources.world

  // ① 重建：归档旧世界（不删除 —— 这个功能的使用场景恰恰是"我搞错了"）。
  //    此刻校验已全过（②③ 都没碰世界），才轮到动它
  let archived: string | undefined
  if (exists) {
    archived = `${options.worldDir}-archive-${stamp(now())}`
    await rename(options.worldDir, archived)
    warn(`[yanxin-setup] 旧世界已归档：${archived}`)
  }

  const kernel = await WorldKernel.open(options.worldDir, { now, warn })
  let result: Awaited<ReturnType<typeof genesis>>
  try {
    result = await genesis({ kernel, worldDoc, callModel: options.callModel, selfId: options.selfId, warn })
  } catch (error) {
    // 内核的失败变成向导的失败（控制台只需处理一种错误类型）——
    // 但**不吞原因**：机读诊断逐条挪进 details
    const diagnostics = (error as { details?: { message?: string }[] }).details ?? []
    throw new SetupError(
      'STEP_FAILED',
      `创世失败：${error instanceof Error ? error.message : String(error)}`,
      diagnostics.map((diagnostic) => diagnostic.message ?? '').filter((line) => line !== ''),
    )
  }

  // ④ T=0：锚在创世这一刻。`open` 会立刻落盘（T21 的教训：不能等到第一个检查点），
  //    随后 `suspend` 落一次精确值并停掉计时器 —— setup 不替世界引擎走时间
  const clock = await WorldClock.open(options.worldDir, { now, warn })
  await clock.suspend()

  // ⑤ 只读呈现（控制台的世界页读它；它不是编辑入口）
  await kernel.exportStatus()

  return {
    detail: `世界已创世：${result.entityIds.length} 个实体，T=0 锚在现在（事务 #${result.sequence}）`,
    written: [...source.written, ...presets.written],
    sequence: result.sequence,
    ...(archived === undefined ? {} : { archived }),
  }
}

/** 读世界现场（目录不存在时是"还没有世界"）。 */
export async function inspect(worldDir: string): Promise<WorldState> {
  let transactions = 0
  try {
    const text = await readFile(join(worldDir, 'world-transactions.jsonl'), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as { sequence?: unknown }
        if (typeof parsed.sequence === 'number') transactions += 1
      } catch {
        // 半行不算（与内核重放一致）
      }
    }
  } catch {
    transactions = 0
  }

  let clock = false
  try {
    const parsed = JSON.parse(await readFile(join(worldDir, 'clock.json'), 'utf8')) as { genesisMs?: unknown }
    clock = typeof parsed.genesisMs === 'number'
  } catch {
    clock = false
  }

  return { transactions, clock }
}

/** 归档目录名的时间戳（本地可读，避免 `:` 这类非法字符）。 */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-')
}