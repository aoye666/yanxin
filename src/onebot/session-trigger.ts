/**
 * session 命名与入站消息的纯逻辑（T12 + T11 的可测内核）。
 *
 * 抽成纯函数的理由和之前一样：这些规则需要表驱动单测，而单测不该被迫搭
 * 一套真实的 Agent + LLM。网络/Agent 部分在 `./bridge.ts`。
 *
 * ⚠️ 只用命名导出（ADR 0004）。
 */

/** 三种运行身份。`admin` 是管理员私聊（唯一带 shell 的模式，见 spec §6.10）。 */
export type Mode = 'agent' | 'admin' | 'world'

/** 入站消息的频道。 */
export type Channel =
  | { kind: 'group'; groupId: string }
  | { kind: 'private'; userId: string }

/**
 * 会话 id —— 记忆写回的隔离单位（spec §6.5）。
 *
 * 命名形状：
 *   agent:3000000001:group:3000000003
 *   agent:3000000001:private:2000000001
 *   admin:2000000001
 *   world:3000000001
 *
 * ## 为什么这样切
 *
 * ReMe 的 `auto_memory` **每个 session 每天最多沉淀一张卡**，而检索是**全 workspace** 的。
 * 所以 session 的切分同时决定两件事：
 *   - **写回隔离**：不同群 / 不同模式各自成卡，不互相污染
 *   - **召回共享**：都在同一个 workspace 里，跨 session 可召回
 *
 * 换句话说 session 是"记忆的写入粒度"，不是"对话的隔离墙"。
 */
export function sessionIdFor(mode: Mode, selfId: string, channel: Channel): string {
  if (mode === 'admin') {
    // 管理员私聊按【人】切，不按 bot 账号 —— 换账号不该换她的记忆
    if (channel.kind === 'private') return `admin:${channel.userId}`
    return `admin:group:${channel.groupId}`
  }
  if (mode === 'world') {
    // 世界是单一天然会话流，不按频道切
    return `world:${selfId}`
  }
  return channel.kind === 'group'
    ? `agent:${selfId}:group:${channel.groupId}`
    : `agent:${selfId}:private:${channel.userId}`
}

/** 触发判定的输入（只取判定需要的字段，便于单测）。 */
export interface TriggerInput {
  /** 这个账号是否注册过（未注册的连接根本不会被接受，这里是双保险） */
  knownAccount: boolean
  channel: Channel
  /** 发送者 QQ 号 */
  senderId: string
  /** bot 自己的 QQ 号 */
  selfId: string
  /** 消息里被 at 的 QQ（不含 all） */
  at: readonly string[]
  /** 是否 at 了全体 */
  atAll: boolean
  /** 消息文本（已归一化） */
  text: string
  /** 群里的触发策略 */
  groupTrigger: 'mention' | 'name' | 'never'
  /**
   * `groupTrigger: 'name'` 时算"被叫到"的字样（文本包含即可）。
   *
   * 只在**群聊**里生效，且只在没被 @ 时兜底 —— 被 @ 永远优先（那条判断在前）。
   */
  nameWords?: readonly string[]
}

export type TriggerDecision =
  | { respond: true; reason: 'private' | 'mentioned' | 'named' }
  | { respond: false; reason: string }

/**
 * 该不该回应。
 *
 * ## 政策
 *
 * - **私聊**：一律回应。
 * - **群聊**：默认**只有被 @ 才回应**。理由有两条：
 *   1. 人格设定是「喜欢潜水——群里看着，偶尔对感兴趣的话题发言，不刻意表现自己」，
 *      对每条群消息都应答与该设定直接冲突；
 *   2. 一个真实账号的群里有几百上千人，默认全应答是**对外可见的骚扰**。
 * - **永不回应自己**：防御性检查 —— 即使 OneBot 侧配了"上报 Bot 自身消息"
 *   （SnowLuma 的默认是不上报），也不该形成自回环。
 * - **`groupTrigger: 'never'`**：给"只想私聊测试"的部署一个明确的开关。
 * - **`groupTrigger: 'name'`**：没被 @ 但文本里出现她的名字（`nameWords` 任一）也叫一次。
 *   注意这一档叫的是**"去看一眼"**，不等于"要说话" —— 说不说由她自己在人格里判断
 *   （别人互相提到她名字、或那句不是说给她听的时，接话就是插话）。
 */
export function decideTrigger(input: TriggerInput): TriggerDecision {
  if (!input.knownAccount) return { respond: false, reason: '未注册的账号' }
  if (input.senderId === input.selfId) return { respond: false, reason: '自己发的消息（防自回环）' }
  if (input.channel.kind === 'private') {
    // 自己给自己的私聊（某些实现会推）也算自回环
    if (input.channel.userId === input.selfId) return { respond: false, reason: '自己给自己的私聊' }
    return { respond: true, reason: 'private' }
  }
  if (input.groupTrigger === 'never') return { respond: false, reason: 'groupTrigger=never' }
  if (input.at.includes(input.selfId) || input.atAll) return { respond: true, reason: 'mentioned' }
  if (input.groupTrigger === 'name' && (input.nameWords ?? []).some((word) => word !== '' && input.text.includes(word))) {
    return { respond: true, reason: 'named' }
  }
  return { respond: false, reason: '群里没被 @（默认潜水）' }
}

/** 渲染成给模型读的文本。 */
export interface RenderInput {
  channel: Channel
  senderId: string
  /** 发送者昵称（OneBot 的 `sender.nickname`，尽力而为、可能缺失） */
  senderName?: string | undefined
  /** 归一化后的消息文本 */
  text: string
  /** 发出去的消息 id，便于模型需要时引用 */
  messageId?: string | undefined
}

/**
 * 把一条入站消息渲染成给模型读的一行。
 *
 * ## 为什么带 `[群 x · 昵称(id)]` 前缀
 *
 * 模型需要知道**谁在说、在哪说** —— 否则"同上"、"他也这么觉得"这类话无从理解，
 * 而人格设定里明确有「记住自己是客人」「注意细节」。
 * 前缀是**元数据**，不是内容；这一点已写进人格文本（`persona/base.md`），
 * 免得她把前缀当成对方说的话回敬过去。
 */
export function renderInbound(input: RenderInput): string {
  const who = input.senderName ? `${input.senderName}(${input.senderId})` : input.senderId
  if (input.channel.kind === 'group') {
    return `[群 ${input.channel.groupId} · ${who}] ${input.text}`
  }
  return `[私聊 · ${who}] ${input.text}`
}

/** 回复的投递目标与消息段（决定调哪个 API、带什么参数）。 */
export interface ReplyTarget {
  action: 'send_group_msg' | 'send_private_msg'
  params: Record<string, unknown>
  /** 用于日志 */
  describe: string
}

/**
 * 构造回复的投递目标。
 *
 * 群里回复时带一个 `at` 段指向发送者 —— QQ 的常规礼仪（让对方知道这句话在回他），
 * 而不是裸文本。
 */
export function buildReply(target: Channel, text: string, options: { atSender?: string } = {}): ReplyTarget {
  if (target.kind === 'group') {
    const message: unknown[] = []
    if (options.atSender) message.push({ type: 'at', data: { qq: options.atSender } })
    message.push({ type: 'text', data: { text: options.atSender ? ` ${text}` : text } })
    return {
      action: 'send_group_msg',
      params: { group_id: Number(target.groupId), message },
      describe: `群 ${target.groupId}`,
    }
  }
  return {
    action: 'send_private_msg',
    params: { user_id: Number(target.userId), message: [{ type: 'text', data: { text } }] },
    describe: `私聊 ${target.userId}`,
  }
}

/** 从会话事件里抽出这一轮的回复文本（跳过 `firstSeq` 之前的事件）。 */
export interface AssistantTurn {
  text: string
  /** `turn/end` 的 reason.kind，便于判断是 completed 还是 error */
  endedWith?: string
  /** error 时的可读信息 */
  errorText?: string
}

/**
 * 从 `agent.session.events` 里取这一轮的助手文本。
 *
 * 形态照搬上游 headless 的 `summarize`（`packages/bundle/headless/src/index.ts`）：
 *   - 跳过 `seq < firstSeq` 的历史事件
 *   - 遇到 `turn/start` 才算进入本轮
 *   - 取**最后一个非空**的 `assistant/message` 的 text 块拼接
 *   - `turn/end` 给出结束原因
 *
 * 「最后一个非空」而不是「全部拼接」：一轮里可能有多个 assistant/message
 * （思考后重发），拼接会重复；取最后一个非空是与上游一致的行为。
 */
export function extractAssistantTurn(events: readonly unknown[], firstSeq: number): AssistantTurn {
  // 防御性检查：类型上要求数组，但这个函数是"读外部结构"的边界，
  // 传错形态时应当安静地返回空结果，而不是抛 "events is not iterable"。
  if (!Array.isArray(events)) return { text: '', endedWith: undefined }

  let started = false
  let text = ''
  let endedWith: string | undefined
  let errorText: string | undefined

  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue
    const event = raw as { seq?: unknown; type?: unknown; data?: unknown }
    const seq = typeof event.seq === 'number' ? event.seq : -1
    if (seq < firstSeq) continue

    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue

    if (event.type === 'assistant/message') {
      const data = event.data as { message?: { content?: unknown } } | undefined
      const content = data?.message?.content
      if (!Array.isArray(content)) continue
      const joined = content
        .filter((b): b is { type: string; text?: unknown } => b !== null && typeof b === 'object')
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('')
      if (joined !== '') text = joined
      continue
    }

    if (event.type === 'turn/end') {
      const data = event.data as { reason?: { kind?: unknown; error?: { message?: unknown } } } | undefined
      const kind = data?.reason?.kind
      if (typeof kind === 'string') endedWith = kind
      const message = data?.reason?.error?.message
      if (kind === 'error' && typeof message === 'string') errorText = message
    }
  }

  return errorText === undefined ? { text, endedWith } : { text, endedWith, errorText }
}
