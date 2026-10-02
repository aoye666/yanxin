/**
 * 世界闭环 —— 把 T20–T26 接成一条线（T27，spec §6.7）。
 *
 * ## 一拍里发生什么
 *
 * ```
 * ① watch   到期的动作排期（含重启恢复：pending 的会被重新排上）
 * ② settle  到点 → 裁定（T25）→ 提案 → 内核校验提交（T20）→ 结果喂回循环（T24b/c）
 * ③ turn    她"想起来"之后想一轮（T24c）—— 生成不阻塞，要花时间的动作只是登记
 * ④ emit    把**已提交**的发言经闸门发出去（T23）
 * ```
 *
 * ## 两条纪律，都是顺序问题
 *
 *   · **先提交、后发射**：`emit()` 只发**快照里已有**的发言。闸门不认任何"还没提交的
 *     内容"—— 于是"提交前零发射"（spec T8）不是靠自觉，而是因为**别处根本没有内容可发**。
 *   · **恰好一次跨重启**：发射幂等的依据是回执表（T23 的 `settledIds`），而回执是
 *     **落盘**的 —— 重启后重复的一批会被安静跳过，不会让群里看到两遍。
 *
 * ## 它同时是 `WorldFacade`（T26 的四个动词）
 *
 * 世界工具（`world_observe` / `world_act` / `world_say` / `world_note`…）只认那四个动词。
 * 它们由这里实现 —— 于是**工具那条路与循环这条路共用同一份翻译**（`intent.ts`）：
 * 她伸手登记一个动作，与她自己想一个动作，落到世界里的形状完全一样。
 *
 * ## 刻意不做
 *
 *   · **不自己开定时器**：Tingle 心跳由 `clock.startTingle()` 给（递归 setTimeout），
 *     本文件只是被它调；`stop()` 之后一拍都不会再来。
 *   · **不调真实 LLM**：决策函数与裁定函数都是注入的（T24c / T25）。真实接线是
 *     装配层的事（要世界目录、模型路由、agent 会话）——本文件因此可以在假时钟 +
 *     mock 模型下把整条链路跑通。
 */
import { KernelError } from './error.ts'
import { describeError } from '../describe.ts'
import { translateIntent } from './intent.ts'
import type { BotLoop, Intent, TurnResult } from './bot-loop.ts'
import type { WorldClock } from './clock.ts'
import type { WorldKernel } from './kernel.ts'
import type { WorldNotes } from './notes.ts'
import { observe, type Observation, type PhoneMessage } from './observe.ts'
import type { WorldOutbox, OutboxReceipt } from './outbox.ts'
import { WorldRuntime, type ActionOutcome, type Adjudicate } from './runtime.ts'
import type { WorldFacade } from './tools.ts'
import type { TransactionProposal } from './state.ts'

export interface WorldLoopOptions {
  kernel: WorldKernel
  clock: WorldClock
  /** 到期裁定（T25 的 `WorldArbiter.adjudicate`）。 */
  adjudicate: Adjudicate
  /** 她"过下去"的那个循环（T24c）。 */
  botLoop: BotLoop
  /** 发射闸门（T23）。 */
  outbox: WorldOutbox
  /** 她的本子（`notes/*.md`）。 */
  notes: WorldNotes
  /** 她自己在世界里的实体 id。 */
  selfId: string
  /** 手机里的消息（外部世界 QQ）—— 装配层注入；默认空（她就看不到群里的动静）。 */
  phoneMessages?: () => readonly PhoneMessage[]
  /** 她"看手机"还是"看周围"（默认 `around`）。 */
  focus?: () => 'around' | 'phone'
  /**
   * "她该想一轮了"的调度器（默认 `setTimeout(…, 0)`）。
   *
   * 为什么要有这个注入点：结算完成后她该**很快**想起来（而不是等下一拍心跳，
   * 那是 30 分钟）。测试注入手动调度器，于是"结算 → 想一轮 → 说话 → 发射"
   * 这条链在测试里是确定性的（没有真实定时器参与）。
   */
  schedule?: (callback: () => void) => void
  /**
   * 结算用的定时器（转交给 T24b 的 `WorldRuntime`）。
   *
   * 与 `schedule` 分开：这个口子的语义是"到点了 → 结算"（世界时间尺度，可能是几分钟），
   * 而 `schedule` 是"现在 → 她想一轮"（立刻）。测试两个都注入手动实现，
   * 于是**谁先谁后完全由测试决定**。
   */
  setTimer?: (callback: () => void | Promise<void>, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  warn?: (message: string) => void
}

export interface BeatResult {
  /** 这一拍她做了什么。 */
  turn: TurnResult | undefined
  /** 这一拍发出去了几条（不含更早发过的）。 */
  emitted: OutboxReceipt[]
}

export class WorldLoop implements WorldFacade {
  private readonly runtime: WorldRuntime
  private readonly options: Required<Pick<WorldLoopOptions, 'phoneMessages' | 'focus' | 'schedule' | 'warn'>> &
    WorldLoopOptions
  /** 轮的串行队列（一拍与"结算后的那一轮"不会并行 —— 她一次只想一件事）。 */
  private queue: Promise<unknown> = Promise.resolve()
  /** 已经排了一个"结算后的轮"，还没跑（合并突发结算，避免一串轮堆起来）。 */
  private turnScheduled = false
  /** 提案序号（与 `sequence` 一起构成幂等键；两条路各数各的）。 */
  private facadeTurns = 0
  /** 最近一次 `look()` 的句柄映射（工具那条路的句柄解析依据）。 */
  private lastHandles: ReadonlyMap<string, string> = new Map()
  private stopped = false

  private constructor(
    options: WorldLoopOptions,
    runtime: WorldRuntime,
  ) {
    this.runtime = runtime
    this.options = {
      ...options,
      phoneMessages: options.phoneMessages ?? (() => []),
      focus: options.focus ?? (() => 'around'),
      schedule: options.schedule ?? ((callback) => void setTimeout(callback, 0)),
      warn: options.warn ?? ((message) => console.warn(message)),
    }
  }

  /**
   * 启动闭环。
   *
   * 顺序是刻意的：**先接管结算回调，再扫描 pending** —— 否则"启动时就已经到期"的动作
   * 会在回调还没接上时就结算掉，那次的 `onOutcome` 就丢了（她会"想不起来"自己做过）。
   * 实现上用一个极短的缓冲区接住"实例还没造好就到达的结果"，随后补交。
   */
  static async start(options: WorldLoopOptions): Promise<WorldLoop> {
    const early: ActionOutcome[] = []
    const holder: { loop?: WorldLoop } = {}

    const runtime = await WorldRuntime.start({
      kernel: options.kernel,
      clock: options.clock,
      adjudicate: options.adjudicate,
      onOutcome: (outcome) => {
        const current = holder.loop
        if (current === undefined) {
          early.push(outcome)
          return
        }
        current.onOutcome(outcome)
      },
      warn: options.warn,
      ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
      ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
    })

    const loop = new WorldLoop(options, runtime)
    holder.loop = loop
    for (const outcome of early) loop.onOutcome(outcome)

    // 离线补偿（T21）：进程不在的那段时间，只**说一句**"过去了多久"，
    // 绝不逐 tick 重放（额度与叙事的双重灾难）。
    const gap = options.clock.consumeOfflineGap()
    if (gap !== null) {
      options.botLoop.notify(`你不在的这段时间过去了 ${gap.gapTU} 秒（从 ${gap.fromTU} 到 ${gap.fromTU + gap.gapTU}）。`)
    }

    // Tingle 心跳：每 `tingleEveryUnits`（默认 30 TU = 30 秒）一拍。它驱动 watch/turn/emit 三件事。
    // 回调**返回这一拍的 promise**：让 clock 的"上一拍没跑完就跳过"守卫真的生效
    // （否则一拍还在跑，下一拍就会叠上来）。
    options.clock.startTingle(async () => {
      await loop.beat()
    })
    return loop
  }

  /** 停：心跳 + 定时器。之后一拍都不会再来（窗口关闭时装配层调用）。 */
  stop(): void {
    this.stopped = true
    this.options.clock.stopTingle()
    this.runtime.stop()
  }

  /**
   * 等队列里的轮跑完（优雅关闭 / 测试用）。
   *
   * 注意它只等**已经入队**的轮：正在跑的那一轮会等，但"排在调度器里还没被触发"的
   * 那一轮不算（那由调度器决定什么时候来）。
   */
  async idle(): Promise<void> {
    await this.queue
  }

  // ── 一拍 ────────────────────────────────────────────────────────────────

  /**
   * 一拍（Tingle 心跳调它）。
   *
   * `watch()` 会把到期的 pending 重新排上 —— 于是"上次没裁定"的动作在这里被自然重试，
   * 不需要单独的退避逻辑。
   */
  async beat(): Promise<BeatResult> {
    if (this.stopped) return { turn: undefined, emitted: [] }
    await this.runtime.watch()
    return this.enqueueTurn()
  }

  /** 审理一次结算的结果（`runtime` 的交付回调）。 */
  private onOutcome(outcome: ActionOutcome): void {
    this.options.botLoop.feed(outcome)
    this.requestTurn()
  }

  /**
   * 排一轮"她很快就想起来"。
   *
   * **合并**：突发结算（一批动作同时到期）只排一轮 —— 她想一次就够了，
   * 不必为每条结果各想一遍。
   */
  private requestTurn(): void {
    if (this.stopped || this.turnScheduled) return
    this.turnScheduled = true
    this.options.schedule(() => {
      this.turnScheduled = false
      if (this.stopped) return
      void this.enqueueTurn()
    })
  }

  /** 把一轮排进串行队列（不并行 —— 一轮里可能提交事务，并行会打乱幂等键的序号语义）。 */
  private enqueueTurn(): Promise<BeatResult> {
    const run = this.queue.then(async (): Promise<BeatResult> => {
      if (this.stopped) return { turn: undefined, emitted: [] }
      const turn = await this.options.botLoop.runOnce()
      // ⚠️ 这一轮可能**刚登记**了要花时间的动作 —— 而 `beat()` 开头那次 `watch()` 是在
      // 它之前跑的，看不见它。少这一句，她"去看看手机"就永远不会到点（T27 实测踩到：
      // 集成测试里动作一直 pending，因为没有任何定时器被排上）。
      await this.runtime.watch()
      const emitted = await this.emit()
      return { turn, emitted }
    })
    // 队列本身不因一次失败而断（失败已经由 botLoop/runtime announce 过）
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // ── 发射 ────────────────────────────────────────────────────────────────

  /**
   * 把**已提交**的发言发出去。
   *
   * 传入的是整个世界说过的话（快照的 utterances）—— 闸门按回执去重，所以"已经发过的"
   * 会被安静跳过。这样做的理由是**崩溃安全**：不需要在别处记"我发到哪了"，
   * 判断依据只有一份（回执表，且它落盘）。
   */
  async emit(): Promise<OutboxReceipt[]> {
    const utterances = this.options.kernel.snapshot.utterances
    const receipts = await this.options.outbox.deliver(utterances)

    // outbox 文件头承诺"她下次感知会从回执里知道那句话没发出去"—— 这里就是接线：
    // failed 的那几句变成 notice，下一轮她真的会想起来（否则她对失败永远无感）。
    // 幂等天然成立：deliver 按回执"落定即不再试"，failed 只在发生的当拍 produce 一次。
    for (const receipt of receipts) {
      if (receipt.status !== 'failed') continue
      const said = utterances.find((utterance) => utterance.id === receipt.id)
      const text = said === undefined ? '' : `「${said.text}」`
      this.options.botLoop.notify(
        `你想说的${text}没有发出去（${receipt.reason ?? '原因不明'}；不会自动重试，想再说就重新说一次）。`,
      )
    }
    return receipts
  }

  // ── WorldFacade（T26 的四个动词）─────────────────────────────────────────

  /** 她在哪儿、那儿能感知到什么（T24a 的投影）。 */
  look(options: { focus?: 'around' | 'phone' } = {}): Observation {
    const focus = options.focus ?? this.options.focus()
    const result = observe(this.options.kernel.snapshot, this.options.selfId, {
      focus,
      phoneMessages: this.options.phoneMessages(),
    })
    // 句柄映射留在这里（工具那条路的解析依据）——模型看到的观测里没有内部 id
    this.lastHandles = result.handles
    return result.observation
  }

  /**
   * 她伸手登记一个意图（世界工具那条路）。
   *
   * 与"她自己想一个动作"走**同一份翻译**（`intent.ts`）：句柄解析、`expectedEnd`、
   * 幂等键的形状完全一致 —— 于是世界分不出这只手是哪只。
   *
   * 提交成功后立刻 `emit()`：把"先提交后发射"用在工具这条路上也一样成立。
   */
  async submit(intent: Intent): Promise<{ accepted: boolean; detail?: string }> {
    if (this.stopped) return { accepted: false, detail: '世界没在转（引擎已停）' }

    this.facadeTurns += 1
    let proposal: TransactionProposal
    try {
      proposal = translateIntent(intent, {
        at: this.options.clock.now(),
        selfId: this.options.selfId,
        sequence: this.options.kernel.snapshot.sequence + 1,
        turn: this.facadeTurns,
        handles: this.lastHandles,
        keyPrefix: 'tool',
        source: 'world-tool',
      })
    } catch (error) {
      // 典型：句柄不在最近一次观测里（她指了个没见过的东西）——如实说被拒
      return { accepted: false, detail: describe(error) }
    }

    try {
      await this.options.kernel.submit(proposal)
    } catch (error) {
      return { accepted: false, detail: describe(error) }
    }

    // 登记完立刻排期（她"伸手"登记的动作同样要到点结算）
    await this.runtime.watch()
    await this.emit()
    return { accepted: true }
  }

  /** 写一篇笔记（`notes/*.md`）。 */
  async writeNote(title: string, body: string): Promise<{ path: string }> {
    return this.options.notes.write(title, body)
  }

  /** 翻本子（标题，最近写的在前）。 */
  async listNotes(): Promise<string[]> {
    return this.options.notes.list()
  }

  /**
   * **打断"干等"**（T27b-6）：把 pending 的 `wait` / `rest` 提前收场。
   *
   * 用户要的行为：她在世界里等时间过去时，**群里来消息要能把她叫醒** —— 否则她会
   * 一直等到 `expectedEnd` 才看一眼，而那时候话题早就过去了。
   *
   * 三条设计选择：
   *   · 只打断 `kind` 是 `wait`/`rest` 的动作 —— `act`（正在做的事）不打断：
   *     "书读到一半"被群消息打断会很怪，而"干等着"被打断正合她的性子
   *   · **不叫模型**：直接以机械理由结算（`action.finish`），省一次调用 ——
   *     这正是设等待下限的初衷（额度）。她下一轮看到手机里的消息，自然会怎么反应就怎么反应
   *   · 一次事务结掉全部（同一批操作），幂等键按世界序号走，重放不会重复结算
   *
   * @param reason - 结算理由（会被她"感知"到，所以是给她看的一句话）
   * @returns 实际打断了几件
   */
  async interruptWaiting(reason: string): Promise<number> {
    if (this.stopped) return 0

    const pending = Object.values(this.options.kernel.snapshot.actions).filter(
      (action) => action.status === 'pending' && (action.kind === 'wait' || action.kind === 'rest'),
    )
    if (pending.length === 0) return 0

    const proposal: TransactionProposal = {
      // 幂等键带上世界序号与动作 id：同一批被打断两次只会生效一次
      idempotencyKey: `interrupt:${this.options.kernel.snapshot.sequence + 1}:${pending.map((action) => action.id).join(',')}`,
      effectiveAt: this.options.clock.now(),
      operations: pending.map((action) => ({
        op: 'action.finish' as const,
        id: action.id,
        status: 'completed' as const,
        reason: `${reason}（本来还要等到 ${action.expectedEnd ?? 0}）`,
      })),
      source: 'interrupt',
    }

    try {
      await this.options.kernel.submit(proposal)
    } catch (error) {
      // 打断失败不该影响世界运转：她还是会在 expectedEnd 时被正常结算
      this.options.warn(`[world-loop] 打断等待失败（下一次照常结算）：${describe(error)}`)
      return 0
    }
    await this.runtime.watch()
    return pending.length
  }
}

function describe(error: unknown): string {
  // KernelError 优先给 summary（首条诊断比 message 更有信息量，直接指向"哪条操作错在哪"）
  if (error instanceof KernelError) return error.summary
  return describeError(error)
}