/**
 * Bot-LLM 循环 —— 她"持续过下去"的那个循环（T24c，spec §6.7）。
 *
 * ## 一轮里发生什么
 *
 * ```
 * ① 消费"刚想起来的事"（上一批动作的结算结果 —— 她做完了什么、失败了什么）
 * ② observe：拿一次投影（她此刻能感知到的；T24a）
 * ③ decide：**决策函数**决定做什么 → 一个「意图」
 * ④ 翻译：意图 → 合法提案（句柄解析回真实 id、duration 换成 expectedEnd、生成幂等键）
 * ⑤ 提交：内核校验后落盘。**不等它完成** —— 需要时间的动作由 runtime 等到期再结算
 * ```
 *
 * ## "不等待结果"的确切含义
 *
 * 不是说"她一秒内安排十件事"—— 是说**生成不阻塞**：发起一个要花 10 分钟的动作后，
 * 循环不挂在那里等（`runOnce()` 立刻返回），结果会由 `runtime` 在世界时间抵达时**以事件注入**
 * （经 `feed()` 进下一轮的 `notices`）。下一轮由谁触发（Tingle 心跳 / 结算事件 / 外部刺激）
 * 是 T27 的接线问题，不在这层。
 *
 * ## 为什么决策函数产出「意图」而不是提案
 *
 * 模型看到的世界里**没有内部 id**（只有 `seen:n` 句柄），所以它不可能直接写出合法提案。
 * 让它产出一个「意图」（做什么、对谁、多久），由这里翻译成提案 —— 于是：
 *
 *   · **句柄 → id 的解析只发生在一个地方**（`intent.ts` 的 `translateIntent` ——
 *     "她伸手登记"那条路走的是同一份实现）；
 *   · 幂等键、`expectedEnd`、动作 id 这些"机械细节"不用模型操心，也就无从写错。
 *
 * 瞎编的句柄（`seen:99` 根本不在这次观测里）会被拒 —— **这一轮作废**（`rejected`），
 * 不抛也不重试：下一轮她会重新看一次世界，再决定。
 *
 * ## 范围
 *
 * `note`（写日记）**不在这里** —— 它写的是 `notes/*.md`（世界之外的文件），不产生世界事务，
 * 属于 T26 的世界工具集。本文件的意图只有 `act` / `wait` / `rest` / `say` / `nothing`。
 */
import type { WorldKernel } from './kernel.ts'
import { translateIntent } from './intent.ts'
import { describeError as describe } from '../describe.ts'
import { observe, type Observation, type ObservationResult, type PhoneMessage } from './observe.ts'
import type { ActionOutcome } from './runtime.ts'
import type { TransactionProposal, WorldSnapshot } from './state.ts'

/** 她想做的事（模型友好的形态）。 */
export interface Intent {
  /**
   * `act` 做事 / `wait` 等一会儿 / `rest` 歇一阵 /
   * `say` 说句话 / `nothing` 什么都不做（也是一种决定）
   */
  kind: 'act' | 'wait' | 'rest' | 'say' | 'nothing'
  /** 做什么（`act` 用；她自己的措辞，结算时会作为"意图"回给她）。 */
  intent?: string
  /** 对谁做（**句柄**，如 `seen:3`）—— 由这里解析回真实 id。 */
  handle?: string
  /** 说什么（`say` 用）。 */
  text?: string
  /** 期望耗时（TU）—— 决定 `expectedEnd = 现在 + duration`。 */
  duration?: number
}

/** 一轮的输入 —— 给决策函数。 */
export interface TurnContext {
  /** 她此刻能感知到的（**没有内部 id**）。 */
  observation: Observation
  /** 她"刚想起来"的事：上一批动作的结果（结算交付进来的）。 */
  notices: string[]
  /** 当前世界时刻（TU）。 */
  at: number
  /** 世界快照（只读；判"世界现在什么样"时用 —— 但用观测里的更符合"她的视角"）。 */
  world: WorldSnapshot
}

/** 决策函数（真实实现接 LLM，在 T27；测试注入假的）。返回 `null` = 什么都不做。 */
export type Decide = (context: TurnContext) => Promise<Intent | null>

export interface BotLoopOptions {
  kernel: WorldKernel
  clock: { now(): number }
  /** 她的实体 id（世界里的"她自己"）。 */
  selfId: string
  /** 决策函数。 */
  decide: Decide
  /** 观测投影（默认 T24a 的 `observe`；注入让测试可控）。 */
  observer?: (world: WorldSnapshot, selfId: string, phoneMessages: readonly PhoneMessage[]) => ObservationResult
  /** 手机消息（外部世界 QQ）—— T27 接线；默认空。 */
  phoneMessages?: () => readonly PhoneMessage[]
  /** 她"看手机"的时机（`focus`）；默认 `around`（看周围）。T27 会按需切换。 */
  focus?: () => 'around' | 'phone'
  /** 告警去处。 */
  warn?: (message: string) => void
}

export interface TurnResult {
  /** 这一轮她做了什么（`nothing` = 什么都没做）。 */
  kind: Intent['kind']
  /** 提交序号（没提交时为 `undefined`）。 */
  sequence?: number
  /** 被内核拒时的诊断摘要（这一轮作废，不重试）。 */
  rejected?: string
}

export class BotLoop {
  /** 待注入下一轮的通知（动作结算的结果）。 */
  private readonly pendingNotices: string[] = []
  /** 动作/提案的序号（同一世界序号内多轮时区分）。 */
  private turnCounter = 0
  private readonly options: Required<Pick<BotLoopOptions, 'warn' | 'phoneMessages' | 'focus'>> & BotLoopOptions

  constructor(options: BotLoopOptions) {
    this.options = {
      ...options,
      warn: options.warn ?? ((message) => console.warn(message)),
      phoneMessages: options.phoneMessages ?? (() => []),
      focus: options.focus ?? (() => 'around'),
    }
  }

  /** 还没被下一轮消费掉的通知（测试断言用）。 */
  get notices(): readonly string[] {
    return this.pendingNotices
  }

  /**
   * 把"刚结算的动作结果"喂进来 —— `runtime` 的 `onOutcome` 接这里。
   *
   * 它不会立刻触发一轮（那是 T27 的调度决定），只是排队：
   * 下一次 `runOnce()` 时她会"想起来"这些事。
   */
  feed(outcome: ActionOutcome): void {
    const verb = outcome.status === 'completed' ? '做完了' : outcome.status === 'cancelled' ? '没做成（中途放弃了）' : '没做成'
    this.notify(`${verb}：${outcome.summary}`)
  }

  /**
   * 直接排一条通知（不走动作结算）。
   *
   * 用处是 T27 的**离线补偿**：进程重启后世界过了一大段（`consumeOfflineGap()`），
   * 那句话不是某个动作的结果，但同样该在她下一轮里"被想起来"。
   */
  notify(text: string): void {
    this.pendingNotices.push(text)
  }

  /**
   * 跑一轮。
   *
   * **不阻塞**：需要时间的动作只是"登记"（`action.start`），结算由 runtime 在到期时做。
   */
  async runOnce(): Promise<TurnResult> {
    const at = this.options.clock.now()
    const world = this.options.kernel.snapshot

    const decide = this.options.decide
    // 消费掉：她"想起来"之后，这些事就不再挂在心上了（避免每轮重复提）。
    // ⚠️ 但消费的前提是**她真的看到了** —— decide 抛错时这批会被原样放回（见 decideSafely），
    // 一次模型/会话故障不该让她永远"想不起来"那几件事
    const taken = this.takeNotices()
    const intent = await this.decideSafely(decide, {
      observation: this.project(world),
      notices: taken,
      at,
      world,
    }, taken)

    if (intent === null || intent.kind === 'nothing') return { kind: 'nothing' }

    let proposal: TransactionProposal
    try {
      proposal = this.translate(intent, at, world)
    } catch (error) {
      // 典型：瞎编的句柄。这一轮作废 —— 下一轮她会重新看一次世界
      const reason = describe(error)
      this.options.warn(`[world-bot-loop] 意图无法翻译成提案（${intent.kind}）：${reason}`)
      return { kind: intent.kind, rejected: reason }
    }

    try {
      const result = await this.options.kernel.submit(proposal)
      return { kind: intent.kind, sequence: result.sequence }
    } catch (error) {
      const reason = describe(error)
      this.options.warn(`[world-bot-loop] 提案被内核拒绝（${intent.kind}）：${reason}`)
      return { kind: intent.kind, rejected: reason }
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * 决策函数抛错 → 告警并按"什么都不做"处理（她不至于因为一次决策失败就停摆）。
   *
   * 失败分两种，处理不同：**翻译失败 / 提交被拒**时 notices 已经真被看见了（模型给过判断，
   * 只是判断没落地），不返还；**decide 本身抛错**时她连世界都没看到 —— 返还这批 notices，
   * 下一轮重新提起（错误处理只吞错误，不吞数据）。
   */
  private async decideSafely(decide: Decide, context: TurnContext, taken: readonly string[]): Promise<Intent | null> {
    try {
      return await decide(context)
    } catch (error) {
      // ⚠️ 带上**第一行栈**：2026-09-27 夜间实例上这条只有一句 `cannot get property
      //    "agents" without inject`，光看它找不到是谁在访问 —— 有栈就一眼定位。
      const frame = error instanceof Error ? error.stack?.split('\n')[1]?.trim() : undefined
      this.options.warn(
        `[world-bot-loop] 决策失败（本轮按"什么都不做"处理，她没看到的通知将放回）：${describe(error)}${frame === undefined ? '' : ` @ ${frame}`}`,
      )
      if (taken.length > 0) this.pendingNotices.unshift(...taken)
      return null
    }
  }

  private takeNotices(): string[] {
    const taken = [...this.pendingNotices]
    this.pendingNotices.length = 0
    return taken
  }

  /** 取一次投影（默认走 T24a；注入时用注入的）。 */
  private project(world: WorldSnapshot): Observation {
    const phoneMessages = this.options.phoneMessages()
    const focus = this.options.focus()
    const result =
      this.options.observer === undefined
        ? observe(world, this.options.selfId, { focus, phoneMessages })
        : this.options.observer(world, this.options.selfId, phoneMessages)
    // 句柄映射留在这一层（`translate` 用），不进 TurnContext ——
    // 决策函数看到的观测里**没有内部 id**（T24a 的纪律）
    this.lastHandles = result.handles
    return result.observation
  }

  /** 上一次投影的句柄映射。 */
  private lastHandles: ReadonlyMap<string, string> = new Map()

  /**
   * 意图 → 合法提案。
   *
   * 三件机械细节（句柄解析、`expectedEnd`、幂等键）都在 `intent.ts` 的
   * {@link translateIntent} 里 —— **与"她伸手登记"那条路共用同一份实现**，
   * 于是模型不可能指到没见过的东西（T27 把这段抽出去的动机）。
   */
  private translate(intent: Intent, at: number, world: WorldSnapshot): TransactionProposal {
    this.turnCounter += 1
    return translateIntent(intent, {
      at,
      selfId: this.options.selfId,
      sequence: world.sequence + 1,
      turn: this.turnCounter,
      handles: this.lastHandles,
      source: 'bot-llm',
    })
  }
}
