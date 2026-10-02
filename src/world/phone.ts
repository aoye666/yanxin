/**
 * 她的**手机**：外部世界（QQ）的消息缓冲区（T27b-5）。
 *
 * ## 为什么要有这个文件
 *
 * `observe()` 的 `focus: 'phone'` 分支从 T24a 起就在（"她看手机里的消息"），
 * `BotLoop` 也一直会拿 `phoneMessages()` 去投影 —— 但引擎那一侧**返回的是空数组**
 * （2026-09-27 夜间隔离实例实测：`private phoneMessages() { return [] }`）。
 * 于是她**永远看不到群里发生了什么**：世界与 QQ 之间那条设计的通道是空的。
 *
 * ## 两条设计选择（都写在这里，免得下次有人重新发明）
 *
 * 1. **只缓冲，不排空**：看一眼手机不会"消费"消息 —— 手机里本来就是历史。
 *    代价是同一批消息会在连续的观测里重复出现；好处是"某次没看手机"不会让消息丢。
 *    （真要"已读/未读"的语义，那是另一件事，等有需求再做。）
 * 2. **不按群过滤**：她自己账号收到的**所有**群聊与私聊都进手机（除了她自己发的）。
 *    世界群只是她"说话的地方"，不是她"能感知的地方" —— 群里别人说的话本来就该被她看见，
 *    这与她跟群里是**同一个 session、同一份人格**（spec §6.5）一致。
 *
 * ## 为什么记现实时刻、读的时候才换算
 *
 * `PhoneMessage.at` 要的是**世界时刻**（TU）。而消息到达时世界可能还没打开
 * （引擎装载与 OneBot 连接是两件独立的事），所以这里只记 `arrivedAtMs`（现实毫秒），
 * 读的时候用 `genesisMs` 换算 —— 锚点是稳定的（`clock.json` 里的 T=0），换算永远成立。
 *
 * ⚠️ 只用命名导出（ADR 0004）。
 */
import type { PhoneMessage } from './observe.ts'
import { normalizeMessage } from '../onebot/message.ts'

/** 最多留多少条（她的手机不是归档；世界很小，提示词也不该被消息撑爆）。 */
export const PHONE_BUFFER = 20

/** 缓冲里的一条（还没有世界时刻）。 */
export interface BufferedPhoneMessage {
  /** 外部消息 id（去重用）。 */
  id: string
  /** 发送者昵称（人可读）。 */
  speaker: string
  text: string
  /** 到达的现实时刻（ms）。 */
  arrivedAtMs: number
}

/**
 * 一帧 → 原始 OneBot 字段表。
 *
 * ⚠️ **这里踩过一个坑（2026-09-27 实测）**：引擎在 `onebot/event` 上收到的是
 * **项目归一化后的 `EventFrame`**（`{ kind:'event', postType, selfId, raw }`，
 * `src/onebot/protocol.ts`），**不是**裸的 OneBot 帧 —— 原始字段（`post_type` /
 * `message_type` / `message_id` / `sender`…）都在 `frame.raw` 里。
 * 一开始按裸帧解析，于是手机**永远空**、打断也永远不触发，而且**一声不响**
 * （判据不匹配 = 当作"不是消息"，那是合法结果）。测试当时喂的也是裸帧，
 * 所以单测全绿 —— 教训：**夹具要用运行时真正给的形状**。
 *
 * 两种形状都接受（裸帧也认）：多一层兼容不影响判据，而将来若有人从别处喂裸帧也不会静默失效。
 */
export function rawEventOf(frame: unknown): Record<string, unknown> | undefined {
  if (frame === null || typeof frame !== 'object') return undefined
  const candidate = frame as { kind?: unknown; raw?: unknown }
  if (candidate.kind === 'event' && candidate.raw !== null && typeof candidate.raw === 'object') {
    return candidate.raw as Record<string, unknown>
  }
  return candidate as Record<string, unknown>
}

/**
 * 一帧 OneBot 事件 → 一条手机消息；不该进手机就返回 `undefined`。
 *
 * 判据：`post_type === 'message'`、不是她自己发的、文本非空、有 message_id。
 * 全程防御式读（外部数据），形状不认识就当"不是消息"——**不抛**
 * （一条坏帧不该把世界循环打断）。
 */
export function phoneMessageOf(frame: unknown, selfId: string): { id: string; speaker: string; text: string } | undefined {
  const event = rawEventOf(frame) as
    | {
        post_type?: unknown
        message_id?: unknown
        user_id?: unknown
        raw_message?: unknown
        message?: unknown
        sender?: { nickname?: unknown; card?: unknown; user_id?: unknown }
      }
    | undefined
  if (event === undefined) return undefined
  if (event.post_type !== 'message') return undefined
  if (event.message_id === undefined || event.message_id === null) return undefined

  const senderId = event.user_id ?? event.sender?.user_id
  // 她自己发的：那是世界**出口**的回声，不该进她的手机（否则她会看见自己说的话两次）
  if (String(senderId ?? '') === selfId) return undefined

  const normalized = normalizeMessage(event.message, event.raw_message)
  const text = normalized.text.trim()
  if (text === '') return undefined

  const nickname = event.sender?.card ?? event.sender?.nickname
  const speaker = typeof nickname === 'string' && nickname.trim() !== '' ? nickname.trim() : `QQ ${String(senderId ?? '?')}`

  return { id: String(event.message_id), speaker, text }
}

/** 这一帧是不是**群消息**（`interruptWaiting` 的触发判据）。 */
export function isGroupMessage(frame: unknown): boolean {
  const event = rawEventOf(frame)
  return event?.post_type === 'message' && event.message_type === 'group'
}

/** 她的手机缓冲：去重、限长、只追加。 */
export class PhoneBuffer {
  private readonly messages: BufferedPhoneMessage[] = []
  private readonly seen = new Set<string>()

  /** 记一条（同一 id 只记一次）。返回是否真的记下了。 */
  remember(frame: unknown, selfId: string, arrivedAtMs: number): boolean {
    const parsed = phoneMessageOf(frame, selfId)
    if (parsed === undefined) return false
    if (this.seen.has(parsed.id)) return false

    this.seen.add(parsed.id)
    this.messages.push({ ...parsed, arrivedAtMs })
    while (this.messages.length > PHONE_BUFFER) {
      const dropped = this.messages.shift()
      if (dropped !== undefined) this.seen.delete(dropped.id)
    }
    return true
  }

  /** 现在手机里有什么（**只读快照**，不排空 —— 见文件头的选择 1）。 */
  list(): readonly BufferedPhoneMessage[] {
    return [...this.messages]
  }

  /** 换算成观测要的形状（世界时刻）。世界还没打开（拿不到锚点）时返回空。 */
  toPhoneMessages(clock: { genesisMs: number } | undefined): readonly PhoneMessage[] {
    if (clock === undefined) return []
    return this.messages.map((message) => ({
      id: message.id,
      speaker: message.speaker,
      text: message.text,
      at: Math.max(0, Math.floor((message.arrivedAtMs - clock.genesisMs) / 1000)),
    }))
  }
}