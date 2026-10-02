/**
 * 未初始化守卫（T30，spec §6.11）—— "她还没准备好，就先别开口"。
 *
 * ## 它要防的那件事很具体
 *
 * **空人格跑起来会污染记忆**：消息进来 → 建会话 → 调模型 → 写回长期记忆。
 * 一旦这条路通了，一个"还不知道自己是谁"的小研就已经在往 ReMe 里沉淀东西了 ——
 * 而那些记忆会跟着她一辈子（检索是全 workspace 的）。
 *
 * 所以拦截点在**建会话之前**（bridge 的入口），而不是 agent 内部：晚一步，写回路径就通了。
 *
 * ## 两个判据，刻意不同
 *
 * | 问的是 | 判据 | 不满足时 |
 * |---|---|---|
 * | agent 能不能开口 | **人格在不在**（源文件 + preset 装齐） | 拒答，回一句可操作的话 |
 * | 世界能不能转 | **世界在不在**（`clock.json` + 至少一条事务） | 世界引擎不装载 |
 *
 * 为什么不是"必须 `ready` 才允许 agent 说话"：`ready` 还要求账号选定 —— 那是**部署**的事，
 * 与她"有没有人格"无关。真正会伤到她的只有后者，所以按后者判定（判据与"未就绪"分开写，
 * 免得把两件事的说法混成一句）。
 *
 * ## 没有 setup 服务时也要能判断
 *
 * 守卫退化为**直接读现场**（`readEvidence`）：它不该因为"向导没装载"而失去判断力 ——
 * 那正是最需要它的时候（一个没配好的装配）。世界引擎与 bridge 都用 `ctx.get` 软查，
 * 于是它们不会被向导的装载顺序挡住。
 */
import type { Context } from '@deepseek-ai/cordis'
// 类型层面：让 `ctx.get('setup')` 认得服务键（ADR 0010 的同一个坑）
import type {} from './index.ts'
import {
  defaultPackageRoot,
  dshHome,
  readEvidence,
} from './install.ts'
import { emptyRecord, reconcile, type ReconcileResult } from './logic.ts'
import type { SetupStatus, SetupStep } from './types.ts'

/** 一次守卫判定 —— 连"该怎么说"一起给，调用方不必自己编话。 */
export interface GuardVerdict {
  ok: boolean
  /** 不满足时的**可操作**建议（直接回给运营者/写进日志）。 */
  advice?: string
  /** 向导状态（`ready` / 某一步 / `init`）——供日志与诊断。 */
  status: SetupStatus
  /** 下一步该做的。 */
  next: SetupStep | null
}

/**
 * agent 能不能开口（人格必须真的在）。
 *
 * @example
 * ```ts
 * const verdict = await allowAgent(ctx)
 * if (!verdict.ok) return void reply(verdict.advice)
 * ```
 */
export async function allowAgent(ctx: Context): Promise<GuardVerdict> {
  return judge(ctx, 'persona', (missing) =>
    [
      '她还没有人格 —— 先完成初始化向导（/yanxin 的「初始化」页）再让她开口。',
      ...missing,
    ].join(' '),
  )
}

/** 世界引擎能不能装载（世界必须真的存在）。 */
export async function allowWorld(ctx: Context): Promise<GuardVerdict> {
  return judge(ctx, 'world', (missing) =>
    [
      '世界还没创世 —— 跳过这次装载（她不会在没有世界的地方过日子）。',
      ...missing,
      '补法：完成向导的「世界」一步（ctx.setup.run("world")）。',
    ].join(' '),
  )
}

// ── 内部 ──────────────────────────────────────────────────────────────────

/** 判定某一步"现场真的成立吗"。 */
async function judge(
  ctx: Context,
  step: SetupStep,
  describe: (missing: readonly string[]) => string,
): Promise<GuardVerdict> {
  const verdict = await inspect(ctx)
  const state = verdict.steps.find((candidate) => candidate.step === step)
  const ok = state?.satisfied === true

  return {
    ok,
    ...(ok ? {} : { advice: describe(state?.missing ?? []) }),
    status: verdict.status,
    next: verdict.next,
  }
}

/** 读现场并判定（优先问 setup 服务；没有它就自己读）。 */
async function inspect(ctx: Context): Promise<ReconcileResult> {
  const setup = ctx.get('setup') as { progress(): Promise<SetupProgressLike> } | undefined
  if (setup !== undefined) {
    const progress = await setup.progress()
    return {
      status: progress.status,
      steps: progress.steps.map((state) => ({ step: state.step, satisfied: state.satisfied, missing: state.missing })),
      completed: progress.steps.filter((state) => state.completed).map((state) => state.step),
      reverted: progress.reverted,
      next: progress.next,
      warnings: progress.warnings,
    }
  }

  // 没有向导服务：直接读现场 —— 守卫不该因为"向导没装载"而失去判断力。
  // ⚠️ 此时**不看落盘记录**（读它就得再实现一份读盘逻辑），只信证据 ——
  //    所以把"证据证明了的步骤"当成已完成来推状态：否则会出现"人格明明在、
  //    状态却说 init"这种自相矛盾的报告（status/next 会被日志与告警直接引用）。
  const evidence = await readEvidence(
    { home: dshHome(), packageRoot: defaultPackageRoot() },
    { registered: [], connected: [] },
  )
  const bare = reconcile(emptyRecord(Date.now()), evidence)
  const proved = bare.steps.filter((state) => state.satisfied).map((state) => state.step)
  return reconcile({ ...emptyRecord(Date.now()), completed: proved }, evidence)
}

/** `SetupProgress` 里守卫用到的那几个字段（结构化最小面，避免把服务类型拖进来）。 */
interface SetupProgressLike {
  status: SetupStatus
  next: SetupStep | null
  steps: { step: SetupStep; completed: boolean; satisfied: boolean; missing: string[] }[]
  reverted: SetupStep[]
  warnings: string[]
}