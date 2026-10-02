/**
 * 入站消息的**溯源**：这条消息从哪来（T12）。
 *
 * ## ⚠️ 为什么不用自定义 session 事件（spec §6.13 的原方案被证伪）
 *
 * 原设计是加一个 `'yanxin/provenance'` 事件：
 *
 * ```ts
 * declare module '@deepseek-ai/dsh-session/types' {
 *   interface SessionEventMap { 'yanxin/provenance': { mode; account; senderId? } }
 * }
 * ```
 *
 * **那条路会毁掉会话，而且是最难查的那种毁法。** 实测取证：
 *
 * `packages/core/session/src/known-event-types.ts` 是**生成**的
 * `KNOWN_SESSION_EVENT_TYPES` 集合，其文档原话：
 *
 * > The persistence read path refuses to interpret a log containing a type outside
 * > this set unless the event carries the envelope's `ignorable` marker … **Downstream
 * > (out-of-repo) plugin events are outside this list by construction; a registration
 * > surface for them is deferred until such a consumer exists.**
 *
 * 而拒绝发生在 `packages/session/session-persistence/src/coordinator.ts` 的
 * `assertEventsSupported()` —— 是 **`throw`**，不是 warn：
 *
 * ```ts
 * if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue
 * throw this.unsupported(meta, `… contains event type "…" unknown to this harness …`)
 * ```
 *
 * 于是后果链是：**写进日志（写路径不查）→ 重启 → resume 时抛错 → 该会话永久不可读**。
 * 更糟的是 `persistence.list()` 仍能列出它，所以 bridge 每次都走 resume 分支、
 * 每次都失败 —— 那个群 / 那个人**彻底失联**，除非手工删磁盘上的日志。
 *
 * 而 `ignorable: true` 这条逃生门**当前没有任何 writer 能设置它**（全仓搜不到写入点，
 * `session.append()` 的公开签名也只接受 surface 事件的 `SurfaceIntent`）—— 它是给
 * 未来词汇增长预留的，不是给下游插件的接口。
 *
 * ## 所以改用官方**已开放**的扩展点
 *
 * `MessageSourceMap` 的文档原话是 "Merge-extensible sum type — **plugins add their own
 * `kind`s**"，monorepo 里有 **11 个包**在这么做（`skill` / `goal` / `subagent` /
 * `commands` / `session-reference` / `tool-cordis` …）。它的宿主事件 `user/message`
 * 是**已知类型**，所以整条路都不碰 `KNOWN_SESSION_EVENT_TYPES`。
 *
 * 溯源信息因此**随消息本身持久化**，跟着 `user/message` 事件一起写盘、一起 resume ——
 * 与"用 session 日志做权威记录"的初衷一致，只是不再另开一个事件类型。
 *
 * 模块说明符是主入口 `@deepseek-ai/dsh-llm`（不是 `/message` 子路径）：
 * `lib/types/index.d.ts` 有 `export * from './message.ts'`，`skill` 包用的就是这个写法。
 */
import type { Mode } from './session-trigger.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * 一条来自 QQ（OneBot）的用户消息。
     *
     * 自包含：消费方不需要回头查 session id 就知道这条消息的完整来路。
     * （session id 里也有 mode / account / 频道，但那是**会话级**的；
     * source 是**消息级**的 —— 消息被跨会话引用时，source 仍要能独立回答"从哪来"。）
     */
    qq: QqMessageSource
  }
}

/** 一条 QQ 消息的来路。 */
export interface QqMessageSource {
  kind: 'qq'
  /** 发消息的人（QQ 号，字符串化）。 */
  userId: string
  /** 群号；**私聊时缺席**（不是空串 —— 缺席与"空群号"是两件事）。 */
  groupId?: string
  /**
   * 这条消息从哪个模式进来。
   *
   * ⚠️ 这是**记录**，不是**授权依据**。能力边界由 preset 决定（spec §6.10）——
   * 即使这个字段被伪造，也换不到 shell。
   */
  mode: Mode
  /** bot 自己的账号（selfId）。多账号时用来区分"谁收到的"。 */
  account: string
}

/**
 * 造一条 QQ 消息的 source。
 *
 * 纯函数（无 IO、无状态），所以可以表驱动地钉住每个分支。
 */
export function qqSource(input: {
  userId: string
  groupId?: string
  mode: Mode
  account: string
}): QqMessageSource {
  return {
    kind: 'qq',
    userId: input.userId,
    // 刻意区分"私聊（没有群号）"与"群号是空串"：后者是畸形输入，不该被静默当成私聊
    ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
    mode: input.mode,
    account: input.account,
  }
}
