/**
 * 行动运行时 —— 让"做事要花时间"这件事真的成立（T24b，spec §6.7）。
 *
 * ## 它跑的是动作的三段生命周期
 *
 * ```
 * ① 登记：action.start 提交（带 expectedEnd = 发起时刻 + duration）→ 世界知道"她在做一件事"
 * ② 等待：等到世界时刻抵达 expectedEnd（**到点才结算，不是发起时结算**）
 * ③ 结算：调裁定（T25 的 World-LLM）→ 提案 action.finish → 内核校验提交 → 交付结果
 * ```
 *
 * **为什么必须分这三段**：世界会变。她 14:00 决定"去看看手机"，10 分钟后手机可能已经
 * 被挪走了 —— 裁定必须看**当前**世界，而不是发起时的假设。这正是参照框架那句
 * "动作接受、动作结算、结果交付是不同阶段"的意思。
 *
 * ## 两个注入点（都是刻意的）
 *
 *   · `adjudicate` —— 到期裁定。T25 会接 World-LLM；测试注入假裁定。
 *     返回 `null` 表示"这次裁不了"（不是失败）：保持 pending，**由下一次 `watch()`
 *     重新排期** —— 而 `watch()` 由 Tingle 心跳驱动（30 分钟一拍），所以卡住的动作
 *     会被自然重试，不需要退避逻辑。
 *   · `setTimer` / `clearTimer` —— 定时器。默认真实 `setTimeout`；测试注入**手动触发**的
 *     假定时器。为什么不直接用 `vi.useFakeTimers()`：结算里要调 `kernel.submit`
 *     （**真实文件 IO**），fake timers 管不到它 —— T21 在这上面栽过一次，这里换条路。
 *
 * ## 结算幂等与"取消只在提交边界前生效"
 *
 *   · 结算提案的幂等键是**确定性的**（`finish:<actionId>`）—— 就算到点被触发两次，
 *     内核的幂等也会挡住第二次；再加 `status !== 'pending'` 的前置检查，双保险。
 *   · 取消（`cancel()`）走同一条路：提案 `action.finish(cancelled)`。一旦动作已经结算过，
 *     内核会回 `ACTION_ALREADY_SETTLED` —— **提交边界之后取消无效**是内核保证的，
 *     运行时只是把它如实返回（`false`），不假装成功。
 *
 * ## 生命周期
 *
 * 它是**纯类**（不是 cordis Service）：`start()` 时扫描 pending 动作排期（含重启恢复），
 * `stop()` 清全部定时器。装配层负责把 `start/stop` 挂在 `ctx.effect` 里（与 `WorldClock` 同构）。
 */
import { KernelError } from './error.ts'
import { describeError } from '../describe.ts'
import type { WorldKernel } from './kernel.ts'

/**
 * 结算定时器的单次排期上限（24h）。`setTimeout` 的 delay 是 32 位有符号毫秒
 * （上限 2^31-1 ≈ 24.8 天）：更长的延迟会被 Node 钳成 1ms 立即触发 ——
 * 一个"30 天后完成"的动作会在登记后立刻被结算。封顶 + `settle` 入口的
 * "没到期就重排"把任意远期的动作变成一串 24h 的接力闹钟。
 */
const MAX_TIMER_DELAY_MS = 86_400_000
import type { TransactionProposal, WorldAction, WorldSnapshot } from './state.ts'

/** 结算的结局 —— 交付给世界（她下次感知会看到）。 */
export interface ActionOutcome {
  actionId: string
  status: 'completed' | 'cancelled' | 'failed'
  /** 一句话说明发生了什么（她读这个，不读内部结构）。 */
  summary: string
  /** 结算时的世界时刻（TU）。 */
  at: number
}

/** 裁定的输入：动作 + **当前**世界快照。 */
export type Adjudicate = (action: WorldAction, world: WorldSnapshot) => Promise<TransactionProposal | null>

export interface RuntimeOptions {
  kernel: WorldKernel
  clock: { now(): number }
  /** 到期裁定（T25 接 World-LLM；测试注入假裁定）。 */
  adjudicate: Adjudicate
  /** 结算交付（T24c 喂给 bot-loop；测试注入收集器）。 */
  onOutcome?: (outcome: ActionOutcome) => void | Promise<void>
  /** 告警去处（默认 `console.warn`）。 */
  warn?: (message: string) => void
  /** 定时器注入点（默认真实 `setTimeout`）。回调可以是异步的 —— 见 `schedule`。 */
  setTimer?: (callback: () => void | Promise<void>, delayMs: number) => unknown
  /** 定时器清理（默认真实 `clearTimeout`）。 */
  clearTimer?: (handle: unknown) => void
}

export class WorldRuntime {
  /** actionId → 定时器 handle（`Map` 而非 `Set`：要能取消）。 */
  private readonly scheduled = new Map<string, unknown>()
  private stopped = false
  private readonly options: Required<Pick<RuntimeOptions, 'warn' | 'setTimer' | 'clearTimer'>> & RuntimeOptions

  private constructor(options: RuntimeOptions) {
    this.options = {
      ...options,
      warn: options.warn ?? ((message) => console.warn(message)),
      setTimer: options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      clearTimer: options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)),
    }
  }

  /**
   * 启动：扫描当前 pending 的动作并为它们排期。
   *
   * ⚠️ **这就是"重启恢复"**：进程重启后内存里的定时器都没了，但 pending 动作还躺在
   * 快照里 —— 扫描一遍就复原了（已到期的会立刻结算）。
   */
  static async start(options: RuntimeOptions): Promise<WorldRuntime> {
    const runtime = new WorldRuntime(options)
    await runtime.watch()
    return runtime
  }

  /** 还在等结算的动作数（测试断言用）。 */
  get pendingTimers(): number {
    return this.scheduled.size
  }

  /**
   * 重新扫描：给还没排期的 pending 动作排上。
   *
   * 幂等 —— 已排期的跳过。Tingle 心跳每拍调一次（于是"上次没裁定"的动作会被重试），
   * 新增动作后也可以立刻调一次。
   */
  async watch(): Promise<void> {
    if (this.stopped) return
    const now = this.options.clock.now()

    for (const action of Object.values(this.options.kernel.snapshot.actions)) {
      if (action.status !== 'pending') continue
      if (this.scheduled.has(action.id)) continue

      // 没有 expectedEnd = 立即（"她顺手做了一件事"）
      const dueAt = action.expectedEnd ?? now
      // ⚠️ 用世界时间算延迟：1 TU = 1 现实秒（spec §6.7 的同步模式）。
      // ⚠️ 封顶 24h：setTimeout 的 delay 是 32 位有符号（上限 ~24.8 天），
      // 模型给的 duration 没有上限 —— 超限会被 Node 钳成 1ms 并立即触发（提前结算）。
      // 封顶 + settle 入口的"没到期就重排"一起兜住远期动作。
      const delayMs = Math.min(Math.max(0, dueAt - now) * 1000, MAX_TIMER_DELAY_MS)
      this.schedule(action.id, delayMs)
    }
  }

  /**
   * 取消一个还没结算的动作（**只能在提交边界之前**）。
   *
   * @returns 取消了 `true`；动作已结算 / 不存在 —— `false`（不假装成功）。
   */
  async cancel(actionId: string, reason: string): Promise<boolean> {
    const action = this.options.kernel.snapshot.actions[actionId]
    if (action === undefined || action.status !== 'pending') return false

    this.unschedule(actionId)
    try {
      await this.options.kernel.submit({
        // 幂等键确定性：同一个动作的取消只生效一次
        idempotencyKey: `cancel:${actionId}`,
        // ⚠️ 显式给**世界时刻**：内核缺省的 `now()` 是现实毫秒（它刻意不自己造世界时间），
        // 而 `finishedAt` 这类字段该记世界时间 —— 运行时知道时钟，由它填
        effectiveAt: this.options.clock.now(),
        operations: [{ op: 'action.finish', id: actionId, status: 'cancelled', reason }],
        source: 'runtime',
      })
    } catch (error) {
      // 内核拒了（典型：已经结算过）—— 如实返回 false，不掩盖
      this.options.warn(`[world-runtime] 取消失败（${actionId}）：${describe(error)}`)
      return false
    }
    await this.deliver(actionId, this.options.clock.now())
    return true
  }

  /** 清掉全部定时器（装配层在 `ctx.effect` 的清理里调用）。 */
  stop(): void {
    this.stopped = true
    for (const handle of this.scheduled.values()) this.options.clearTimer(handle)
    this.scheduled.clear()
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private schedule(actionId: string, delayMs: number): void {
    // ⚠️ 回调**返回 settle 的 promise**（而不是 `void` 掉它）：真实定时器会忽略返回值，
    // 但**测试的假定时器需要 await 它**才能等到结算完成 —— 结算里有真实文件 IO
    // （`kernel.submit` 落盘），"等几轮事件循环"赌不中它的完成时机（T21 的同一个教训）。
    const handle = this.options.setTimer(() => this.settle(actionId), delayMs)
    this.scheduled.set(actionId, handle)
  }

  private unschedule(actionId: string): void {
    const handle = this.scheduled.get(actionId)
    if (handle === undefined) return
    this.options.clearTimer(handle)
    this.scheduled.delete(actionId)
  }

  /** 到期结算：裁定 → 提案 → 内核提交 → 交付。 */
  private async settle(actionId: string): Promise<void> {
    this.scheduled.delete(actionId)
    if (this.stopped) return

    const action = this.options.kernel.snapshot.actions[actionId]
    // 已经结算过 / 动作没了：什么都不做（幂等的前置检查，内核算第二道）
    if (action === undefined || action.status !== 'pending') return

    // 定时器被 24h 封顶唤醒（见 watch）：还没到期就重排剩余时长，**不提前结算**
    if (action.expectedEnd !== undefined && this.options.clock.now() < action.expectedEnd) {
      const remainMs = Math.min(
        Math.max(0, (action.expectedEnd - this.options.clock.now()) * 1000),
        MAX_TIMER_DELAY_MS,
      )
      this.schedule(actionId, remainMs)
      return
    }

    let proposal: TransactionProposal | null
    try {
      // ⚠️ 传给裁定的世界是**此刻**的快照 —— 动作发起后世界可能已经变了，
      // "看到当前世界再决定"是这一层的全部意义
      proposal = await this.options.adjudicate(action, this.options.kernel.snapshot)
    } catch (error) {
      this.options.warn(`[world-runtime] 裁定失败（${actionId}）：${describe(error)}`)
      return
    }

    if (proposal === null) {
      // "这次裁不了"不是失败：保持 pending，等下一次 watch()（Tingle 心跳）重排
      this.options.warn(`[world-runtime] 未裁定（${actionId}）—— 保持 pending，等下一拍心跳`)
      return
    }

    try {
      // ⚠️ `effectiveAt` 显式给**世界时刻**：内核缺省的 `now()` 是现实毫秒
      // （它刻意不自己造世界时间 —— 见 kernel.ts 的"与时钟的接缝"）。运行时知道时钟，
      // 由它填。少了这一步，`finishedAt` 会变成 1.79e12 那种现实毫秒（实测踩到）。
      await this.options.kernel.submit({
        ...proposal,
        effectiveAt: proposal.effectiveAt ?? this.options.clock.now(),
      })
    } catch (error) {
      this.options.warn(`[world-runtime] 结算提案被内核拒绝（${actionId}）：${describe(error)}`)
      return
    }

    await this.deliver(actionId, this.options.clock.now())
  }

  /** 交付：把"发生了什么"告诉世界（她下一次感知会看到）。 */
  private async deliver(actionId: string, at: number): Promise<void> {
    const finished = this.options.kernel.snapshot.actions[actionId]
    if (finished === undefined) return
    const outcome: ActionOutcome = {
      actionId,
      status: finished.status === 'pending' ? 'failed' : finished.status,
      // 有 reason 用 reason（裁定写清了为什么），否则回落到意图
      summary: finished.reason ?? finished.intent,
      at,
    }
    try {
      await this.options.onOutcome?.(outcome)
    } catch (error) {
      this.options.warn(`[world-runtime] 交付结果失败（${actionId}）：${describe(error)}`)
    }
  }
}

function describe(error: unknown): string {
  // KernelError 优先给 summary（首条诊断比 message 更有信息量，直接指向"哪条操作错在哪"）
  if (error instanceof KernelError) return error.summary
  return describeError(error)
}