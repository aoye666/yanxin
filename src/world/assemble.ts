/**
 * 世界的**装配**（T27b）—— 从磁盘上的目录开始，把部件真的打开并接成一条线。
 *
 * ```
 * $DSH_HOME/yanxin/world/
 *   ├── world-transactions.jsonl   ← kernel（唯一写入口；重放得到快照）
 *   ├── clock.json                 ← clock（T=0 锚点 + Tingle 心跳 + 离线补偿）
 *   ├── notes/                     ← 她的本子（人机共用的 Markdown）
 *   └── outbox.json                ← 发射回执（跨重启的幂等依据）
 * ```
 *
 * 打开顺序有讲究：**内核 → 时钟 → 闸门 → 笔记本 → 运行时/循环**。
 * 循环最后开，因为它的 `start()` 会扫 pending 动作并可能**立刻结算**（已到期的那些）——
 * 那时内核、时钟、闸门都必须已经在位，否则"她做过的事"会在半空中丢一次。
 *
 * ## 三个注入点（都不在这里实现）
 *
 * | 注入 | 谁给 | 为什么不在这一层 |
 * |---|---|---|
 * | `callModel` | `ctx.worldModel`（T27b-1 的适配器） | 模型从哪来是装配知识，不是世界逻辑 |
 * | `decide` | T27b-3（驱动 `world:<selfId>` 的 agent 会话） | 同上：她是"谁在想"也是装配知识 |
 * | `deliver` | `ctx.onebot` + 世界群号 | 发射通道与部署有关（ADR 0004 的分层） |
 *
 * 于是这一层可以被**完整地测**：注入三个假实现，就能在临时目录里跑起一个真世界。
 */
import { WorldArbiter } from './arbiter.ts'
import { BotLoop, type Decide } from './bot-loop.ts'
import { WorldClock } from './clock.ts'
import { WorldKernel } from './kernel.ts'
import { WorldLoop } from './loop.ts'
import { WorldNotes } from './notes.ts'
import { WorldOutbox, type OutboxItem } from './outbox.ts'
import type { CallWorldModel } from './arbiter.ts'
import type { WorldFacade } from './tools.ts'
import type { PhoneMessage } from './observe.ts'

export interface OpenWorldOptions {
  /** 世界目录（`$DSH_HOME/yanxin/world`）。 */
  dir: string
  /** 她自己在世界里的实体 id（创世时写进世界的那个）。 */
  selfId: string
  /** 世界模型（裁定 + 创世）。 */
  callModel: CallWorldModel
  /**
   * 她"怎么想" —— 决策函数（T27b-3 接线）。
   *
   * 缺省时给一个**什么都不做**的实现：世界照常转（动作到点会结算、该发的会发），
   * 只是她不会主动想起什么。这是刻意的降级：装配缺一块不该让整个引擎起不来
   * ——但会在装载时 warn 一句，让"她为什么不主动"有据可查。
   */
  decide?: Decide
  /** 发射通道（她的话 → QQ）。 */
  deliver: (item: OutboxItem) => Promise<void>
  /** 手机里的消息（外部 QQ）—— 群聊流进她的感知。默认空。 */
  phoneMessages?: () => readonly PhoneMessage[]
  /** Tingle 间隔（TU）；`<= 0` 表示不启动心跳（测试用）。 */
  tingleEveryUnits?: number
  /** 现实时钟（测试注入假时钟）。 */
  now?: () => number
  /** 定时器注入（测试用手动定时器；转交给 T24b 的运行时）。 */
  setTimer?: (callback: () => void | Promise<void>, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  warn?: (message: string) => void
}

/** 打开后的世界（引擎与测试都用它）。 */
export interface OpenWorld {
  kernel: WorldKernel
  clock: WorldClock
  notes: WorldNotes
  outbox: WorldOutbox
  loop: WorldLoop
  /** 世界工具要的那四个动词（`WorldLoop` 就是 `WorldFacade`）。 */
  facade: WorldFacade
  /** 停：心跳 + 定时器 + 时钟（幂等）。 */
  stop: () => void
}

export async function openWorld(options: OpenWorldOptions): Promise<OpenWorld> {
  const warn = options.warn ?? ((message: string) => console.warn(message))

  // ① 内核：重放事务日志得到快照（权威状态就是"日志 + 重放"）
  const kernel = await WorldKernel.open(options.dir, {
    ...(options.now === undefined ? {} : { now: options.now }),
    warn,
  })

  // ② 时钟：读 T=0 锚点（`clock.json` 不在时会创世 —— 那是"向导还没跑"的形态）
  const clock = await WorldClock.open(options.dir, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.tingleEveryUnits === undefined ? {} : { tingleEveryUnits: options.tingleEveryUnits }),
    warn,
  })

  // ③ 闸门：回执是跨重启的幂等依据，所以它必须在循环之前打开
  const outbox = await WorldOutbox.open(options.dir, {
    deliver: options.deliver,
    ...(options.now === undefined ? {} : { now: options.now }),
    warn,
  })

  // ④ 她的本子（`notes/*.md`：与世隔绝的私人文本，不进世界事务）
  const notes = await WorldNotes.open(options.dir)

  // ⑤ 裁定者：模型只提案，内核校验后才落盘（T25）
  const arbiter = new WorldArbiter({ kernel, callModel: options.callModel, warn })

  // ⑥ 她"想一轮"的循环（T24c）——决策函数可选（缺省见 `OpenWorldOptions.decide`）
  const botLoop = new BotLoop({
    kernel,
    clock,
    selfId: options.selfId,
    decide: options.decide ?? (async () => null),
    ...(options.phoneMessages === undefined ? {} : { phoneMessages: options.phoneMessages }),
    warn,
  })

  // ⑦ 闭环：watch → turn → emit（T27）
  const loop = await WorldLoop.start({
    kernel,
    clock,
    adjudicate: (action, world) => arbiter.adjudicate(action, world),
    botLoop,
    outbox,
    notes,
    selfId: options.selfId,
    ...(options.phoneMessages === undefined ? {} : { phoneMessages: options.phoneMessages }),
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
    ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
    warn,
  })

  if (options.decide === undefined) {
    warn('[yanxin-world] 决策函数还没接线（T27b-3）—— 世界会转（到点结算、该发的发），但她不会主动想起什么')
  }

  return {
    kernel,
    clock,
    notes,
    outbox,
    loop,
    facade: loop,
    stop: () => {
      loop.stop()
      clock.stop()
    },
  }
}

export type { Decide }