/**
 * bridge：把入站消息变成一次 agent 对话，并把回复发回去。
 *
 * 这是"群里能看到小研说话"的最后一环。
 *
 * ## 数据流
 *
 * ```
 * onebot/event（已过双向身份校验）
 *   → 过滤（只处理 message 事件）
 *   → 归一化（message.ts，array/CQ 两态）
 *   → 选模式与 preset（管理员私聊 → xiaoyan-admin；其余 → xiaoyan-agent）
 *   → 触发判定（session-trigger.ts：私聊一律回应；群聊仅被 @）
 *   → 按 session 串行（同一会话不并发）
 *   → agents.create（setup 里 mount preset —— 见下）
 *   → followup → whenIdle → flush → 取本轮 assistant 文本
 *   → onebot.call('send_group_msg' | 'send_private_msg')
 * ```
 *
 * ## ⚠️ 为什么必须在 `setup` 里 mount preset
 *
 * `@deepseek-ai/dsh-agent-presets` README 原话：
 *
 * > Every model-facing row lives on the **agent plane**, so the tool registry's global
 * > layer is empty and a child that joins nothing reaches the model with **no tools at all**
 * > and none of its parent's prompt sections.
 *
 * 即**面向模型的行都在 agent 平面上**：不 join preset 的 agent 既没有工具、也没有人格。
 * 根 agent 用异步的 `mount()`（`setup` 支持 async，官方注释："The factory awaits setup
 * after minting agentCtx but BEFORE inserting or announcing either the session or agent"），
 * 且 mount 的 reject 会**回滚整个 agent 创建**，不会留下半组合的会话。
 *
 * ## 为什么按 session 串行
 *
 * `whenIdle()` 解析在**静默**时，不是"每条消息的回复到达"时。同一会话并发两条消息时，
 * 两个 handler 都会在第一次静默时醒来、并读到重叠的事件区间 → 回复串台。
 * 所以同一 session 排队，不同 session 并行（spec §8 T11 的验收要求）。
 *
 * ⚠️ 装配纪律：只用 `export default`（ADR 0004）；实例字段用 TS `private`（ADR 0007）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resumeOrCreateAgent } from './agent-session.ts'
import { RecentChat, renderRecent, withContext } from './context.ts'
import { MessageStats } from './stats.ts'
import { normalizeMessage } from './message.ts'
import type { EventFrame } from './protocol.ts'
import { qqSource } from './provenance.ts'
import { readSessionEvents } from './session-api.ts'
// 召回注入的纯逻辑（T16）+ `ctx.memory` 的类型。
// ⚠️ 这个 `import type` 同时把 service.ts 的 `declare module '@deepseek-ai/cordis'`
// 增强拉进类型程序 —— 少了它 `ctx.get('memory')` 拿不到类型（ADR 0010 记过同一个坑）。
import { renderMemories, withMemories } from '../memory/inject.ts'
import type MemoryService from '../memory/service.ts'
import { allowAgent } from '../setup/guard.ts'
import {
  buildReply,
  decideTrigger,
  extractAssistantTurn,
  renderInbound,
  sessionIdFor,
  type Channel,
  type Mode,
} from './session-trigger.ts'

// ⚠️ **空类型导入不是多余的。** 每个服务包通过 `declare module '@deepseek-ai/cordis'`
// 往 Context 上挂属性（`ctx.agents` / `ctx.agentPresets` / `ctx.agentDefaultModel` / …），
// 而这类增强**只有在该模块进入类型程序时才生效**。只 import 类型、不 import 值，
// 就要用 `import type {}` 把它拉进来 —— 否则报 "Property 'agents' does not exist on type 'Context'"。
// 本仓库自己的服务（`onebot` / `admin`）同理。
// 上游 `packages/bundle/headless/src/index.ts` 也是这么做的。
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '../admin/index.ts'
import type {} from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 一条消息触发了回应（回复发出前）。 */
    'yanxin/reply'(info: {
      sessionId: string
      mode: Mode
      channel: Channel
      senderId: string
      inbound: string
      reply: string
    }): void
  }
}

const ConfigSchema = z.object({
  groupTrigger: z
    .union(['mention', 'name', 'never'] as const)
    .default('mention')
    .description(
      '群聊触发策略：mention = 只在被 @ 时回应；name = 被 @ **或**文本里出现她的名字都调用一次；never = 群里永不回应。',
    ),
  nameWords: z
    .array(z.string())
    .default(['小研'])
    .description('`groupTrigger: name` 时算"被叫到"的字样（文本包含即可）。'),
  contextMessages: z
    .natural()
    .default(10)
    .description('每次调用带进群聊最近几句原话（0 = 不带）。缓冲在内存里，重启即空。'),
  stats: z
    .boolean()
    .default(true)
    .description('把收发计数写进 SQLite（控制台首页仪表盘的数据源）。'),
  statsPath: z
    .string()
    .description('统计库路径。缺省 `$DSH_HOME/yanxin/stats.db`（测试请指向临时目录或 :memory:）。'),
  dryRun: z
    .boolean()
    .default(false)
    .description('只记日志不真发。首次上线或调试时用它可以先看小研会怎么回，不发到 QQ。'),
  cwd: z.string().description('agent 的工作目录。缺省用进程 cwd。'),
  model: z.string().description('覆盖默认模型（缺省用 agentDefaultModel 的当前选择）。'),
  maxReplyChars: z.natural().default(2000).description('回复长度上限，超出截断。'),
})

interface Config {
  groupTrigger: 'mention' | 'name' | 'never'
  nameWords: string[]
  contextMessages: number
  stats: boolean
  statsPath?: string
  dryRun: boolean
  cwd?: string
  model?: string
  maxReplyChars: number
}

/** 从事件里安全地读出我们需要的字段。 */
interface InboundMessage {
  channel: Channel
  senderId: string
  senderName?: string
  messageId?: string
  text: string
  at: string[]
  atAll: boolean
  raw: string
}

function readInbound(frame: EventFrame): InboundMessage | undefined {
  const raw = frame.raw
  const messageType = raw.message_type
  const senderId = raw.user_id === undefined ? '' : String(raw.user_id)
  if (!senderId) return undefined

  const normalized = normalizeMessage(raw.message, raw.raw_message)
  const sender = (raw.sender ?? {}) as { nickname?: unknown }
  const senderName = typeof sender.nickname === 'string' ? sender.nickname : undefined
  const messageId = raw.message_id === undefined ? undefined : String(raw.message_id)

  if (messageType === 'group') {
    const groupId = raw.group_id === undefined ? '' : String(raw.group_id)
    if (!groupId) return undefined
    return {
      channel: { kind: 'group', groupId },
      senderId,
      senderName,
      messageId,
      text: normalized.text,
      at: normalized.at,
      atAll: normalized.atAll,
      raw: normalized.raw,
    }
  }

  if (messageType === 'private') {
    return {
      channel: { kind: 'private', userId: senderId },
      senderId,
      senderName,
      messageId,
      text: normalized.text,
      at: normalized.at,
      atAll: normalized.atAll,
      raw: normalized.raw,
    }
  }

  return undefined
}

export default class OneBotBridge extends Service {
  /**
   * 依赖：传输层、Agent 注册表、preset 服务、会话存储、管理员名单、以及默认模型。
   * 任一缺席时 bridge 不激活（而不是半工作）—— 这是 cordis 的 fiber 语义。
   */
  static readonly inject = ['onebot', 'agents', 'agentPresets', 'sessions', 'admin', 'agentDefaultModel']

  static readonly Config: z<Config> = ConfigSchema

  /** sessionId → 已创建的 agent handle（复用，避免每条消息重建）。 */
  private readonly agents = new Map<string, { agent: Agent; dispose: () => Promise<void> }>()

  /** sessionId → 该会话的串行队列尾。 */
  private readonly queues = new Map<string, Promise<void>>()

  /**
   * 已经回过"还没初始化"的频道（`group:<gid>` / `private:<uid>`）。
   *
   * 未就绪时**每个频道只回一次**：群里每来一条消息都回一句"还没初始化"是刷屏，
   * 而完全沉默又让人以为她坏了。日志每次都记（warn），回复只发一次。
   */
  private readonly refused = new Set<string>()

  /**
   * 群里最近的话（按群号分桶）。上限取 `contextMessages`。
   *
   * 入桶的 key 只由 {@link bucketFor} 决定 —— 写入方（`onEvent`）与读取方（`runTurn`）
   * 分处两个方法，各算各的会静默错位，所以这里共用一个函数。
   */
  private readonly recent: RecentChat
  /** 消息统计（SQLite）。`undefined` = stats 关掉或库打不开 —— 收发照常，仪表盘显示"没有数据"。 */
  private readonly stats: MessageStats | undefined

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'onebot-bridge')
    this.recent = new RecentChat(this.config.contextMessages)

    // 统计库（控制台仪表盘的数据源）。打不开只 warn —— 统计是旁路，聊天不能等它。
    if (this.config.stats) {
      const path = this.config.statsPath ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'yanxin', 'stats.db')
      try {
        this.stats = MessageStats.open(path, { warn: (message) => this.log('warn', message) })
        ctx.effect(() => () => this.stats?.close(), 'yanxin-bridge.stats-close')
      } catch (error) {
        this.log('warn', `统计库打不开（${path}），仪表盘将没有数据：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 监听是 effect：卸载时自动解绑（spec §6 的副作用纪律）
    ctx.effect(
      () =>
        ctx.on('onebot/event', (frame) => {
          void this.onEvent(frame)
        }),
      'yanxin-bridge.listener',
    )

    // agent 也得随卸载清掉，否则 fiber 走了 agent 还在跑
    ctx.effect(
      () => async () => {
        const handles = [...this.agents.values()]
        this.agents.clear()
        await Promise.allSettled(handles.map((h) => h.dispose()))
      },
      'yanxin-bridge.agents',
    )

    this.log('info', `bridge 就绪（groupTrigger=${config.groupTrigger}${config.dryRun ? '，dryRun' : ''}）`)
  }

  // ── 入口 ────────────────────────────────────────────────────────────

  /**
   * 这条消息进哪个"听见"的桶。私聊返回空串 = 没有桶 —— 那边的会话历史本身就带上下文，
   * 而群聊的空白才是这个缓冲要补的。
   */
  private bucketFor(inbound: InboundMessage): string {
    return inbound.channel.kind === 'group' ? `group:${inbound.channel.groupId}` : ''
  }

  private async onEvent(frame: EventFrame): Promise<void> {
    if (frame.postType !== 'message') return

    const account = this.ctx.onebot.account(frame.selfId)
    if (!account) return

    const inbound = readInbound(frame)
    if (!inbound) return

    const mode = this.modeFor(inbound)
    // ⚠️ 缓冲必须喂在**决策之前**：闸门默认丢掉未被 @ 的消息，先判断再存的话，
    //    缓冲里就只剩她答过的那些 —— 那正好是我们要补的那段空白。
    const bucket = this.bucketFor(inbound)
    if (bucket !== '' && inbound.senderId !== frame.selfId) {
      // 没带昵称就用 QQ 号当名字 —— 总比给模型一个空标签强
      this.recent.push(bucket, { senderName: inbound.senderName ?? inbound.senderId, text: inbound.text })
    }
    const decision = decideTrigger({
      knownAccount: true,
      channel: inbound.channel,
      senderId: inbound.senderId,
      selfId: frame.selfId,
      at: inbound.at,
      atAll: inbound.atAll,
      text: inbound.text,
      groupTrigger: this.config.groupTrigger,
      nameWords: this.config.nameWords,
    })

    // 统计记账：**所有**收到的消息都记（responded = 触发了没有）——
    // 触发率是仪表盘的数字之一。自己的消息不记（那是回声，不是流量）。
    if (this.stats !== undefined && inbound.senderId !== frame.selfId) {
      this.stats.record({
        ts: Date.now(),
        direction: 'in',
        channel: inbound.channel.kind,
        groupId: inbound.channel.kind === 'group' ? inbound.channel.groupId : undefined,
        sender: inbound.senderId,
        responded: decision.respond,
        length: inbound.text.length,
      })
    }

    if (!decision.respond) {
      this.log('info', `略过（${decision.reason}）：${inbound.text.slice(0, 40)}`)
      return
    }

    // ── 未初始化就不启动 agent（T30，spec §6.11）──────────────────────────
    //
    // 拦在**建会话之前**，而不是 agent 内部：那里的下一步就是"召回 + 调模型 + 写回记忆"，
    // 而"空人格跑起来污染记忆"正是要防的事（检索是全 workspace 的，沉淀下去就跟着她了）。
    const verdict = await allowAgent(this.ctx)
    if (!verdict.ok) {
      const channelKey = `${inbound.channel.kind}:${inbound.channel.kind === 'group' ? inbound.channel.groupId : inbound.senderId}`
      const firstTime = !this.refused.has(channelKey)
      this.refused.add(channelKey)
      this.log(
        'warn',
        `拒绝启动 agent（向导状态 ${verdict.status}${verdict.next === null ? '' : `，下一步 ${verdict.next}`}）：${verdict.advice ?? ''}`,
      )
      if (firstTime) await this.deliver(frame.selfId, inbound, verdict.advice ?? '还没初始化好。')
      return
    }

    const sessionId = sessionIdFor(mode, frame.selfId, inbound.channel)
    this.enqueue(sessionId, () => this.runTurn({ frame, account, inbound, mode, sessionId }))
  }

  /** 管理员私聊走 `xiaoyan-admin`（唯一带 shell 的模式，spec §6.10）。 */
  private modeFor(inbound: InboundMessage): Mode {
    if (inbound.channel.kind === 'private' && this.ctx.admin.isAdmin(inbound.senderId)) return 'admin'
    return 'agent'
  }

  /** 同一 session 串行、不同 session 并行。 */
  private enqueue(key: string, task: () => Promise<void>): void {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(task).catch((error: unknown) => {
      this.log('warn', `会话 ${key} 处理失败：${error instanceof Error ? error.message : String(error)}`)
    })
    this.queues.set(key, next)
    void next.then(() => {
      // 只在链尾仍是自己时删除，避免误删后来者的链
      if (this.queues.get(key) === next) this.queues.delete(key)
    })
  }

  // ── 一轮对话 ────────────────────────────────────────────────────────

  private async runTurn(input: {
    frame: EventFrame
    account: { selfId: string; preset: string; model?: string }
    inbound: InboundMessage
    mode: Mode
    sessionId: string
  }): Promise<void> {
    const { frame, account, inbound, mode, sessionId } = input
    const { agent } = await this.agentFor(sessionId, mode, account)

    // 上游 headless 的形态：先等静默，再取 seq 划界
    await agent.whenIdle()
    const firstSeq = agent.session.seq

    // ── 召回长期记忆（T16）──────────────────────────────────────────────
    //
    // 三件事刻意这样做：
    //   · 用 `ctx.get('memory')` 而**不是** inject —— 记忆是**增强**，服务缺席时
    //     对话必须照常（inject 会让 bridge 整个 pending，ADR 0010 记过那个坑）。
    //   · `search` 自己永不抛（MemoryService 的降级承诺），所以这里不用 try/catch。
    //   · 召回为空时 `withMemories` 原样返回 —— **一个字节都不加**，
    //     免得"没有找到相关记忆"这类噪声既浪费 token 又教会模型"你有记忆机制"。
    const rendered = renderInbound({
      channel: inbound.channel,
      senderId: inbound.senderId,
      senderName: inbound.senderName,
      text: inbound.text,
      messageId: inbound.messageId,
    })
    const memory = this.memoryService()
    const memories = memory === undefined ? [] : await memory.search(inbound.text)
    // 她刚才听见了什么（不含当前这条 —— 它在 `onEvent` 里已经进缓冲了）
    const heardBucket = this.bucketFor(inbound)
    const heard = heardBucket === '' ? '' : renderRecent(this.recent.beforeLast(heardBucket))

    agent.followup(
      createUserMessage({
        content: [
          {
            type: 'text',
            text: withMemories(withContext(rendered, heard), renderMemories(memories)),
          },
        ],
        // 溯源（T12）：走 `MessageSourceMap` 的 `qq` kind，**随这条 user/message 一起持久化**。
        // 刻意不写自定义 session 事件 —— 那会被持久化读取路径硬拒、让会话永久不可读，
        // 取证与后果链见 provenance.ts 的文件头。
        source: qqSource({
          userId: inbound.senderId,
          groupId: inbound.channel.kind === 'group' ? inbound.channel.groupId : undefined,
          mode,
          account: frame.selfId,
        }),
      }),
    )

    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)

    // 事件读取走 `readSessionEvents` 适配层，而不是直接写某个成员名：
    // 运行时的 session（monorepo 形态）有 `events`、没有 `snapshotEvents`，
    // 而本仓类型（npm 形态）恰好反过来。详见 session-api.ts 与 ADR 0011。
    const turn = extractAssistantTurn(readSessionEvents(agent.session, firstSeq), firstSeq)
    if (turn.errorText) {
      this.log('warn', `${sessionId} 本轮以 error 结束：${turn.errorText}`)
    }

    const text = this.trim(turn.text)
    if (!text) {
      this.log('warn', `${sessionId} 本轮没有产出文本（endedWith=${turn.endedWith ?? '?'}），不发`)
      return
    }

    // ── 写回长期记忆（T16）──────────────────────────────────────────────
    //
    // **故意不 await**：ReMe 的沉淀是异步的（每 session 每天最多一张卡），
    // 而"把消息回出去"不该等它。丢一轮沉淀可接受，让用户多等几秒不可接受。
    // `MemoryService.record` 自己永不抛，所以这里连 catch 都不用加。
    //
    // ⚠️ 写回的是 `rendered`（**原始对话**），不是模型看到的那一版（带记忆前缀的）。
    //    否则召回内容会被再次沉淀 → 下轮又召回 → 内容重复累积，记忆自我强化。
    //    记忆的来源该是真实对话，不是我们注入的检索结果。
    if (memory !== undefined) {
      void memory.record(
        {
          messages: [
            { role: 'user', content: rendered },
            { role: 'assistant', content: text },
          ],
        },
        sessionId,
      )
    }

    this.ctx.emit('yanxin/reply', {
      sessionId,
      mode,
      channel: inbound.channel,
      senderId: inbound.senderId,
      inbound: inbound.text,
      reply: text,
    })

    await this.deliver(frame.selfId, inbound, text)
  }

  /**
   * 记忆服务 —— **可选**。
   *
   * ⚠️ 不在 `inject` 里，而是运行时 `ctx.get`：记忆是**增强**，服务缺席时
   * 对话必须照常（写进 `inject` 会让 bridge 整个 pending，ADR 0010 记过那个坑）。
   */
  private memoryService(): MemoryService | undefined {
    return this.ctx.get('memory') as MemoryService | undefined
  }

  private trim(text: string): string {
    const limit = this.config.maxReplyChars
    if (text.length <= limit) return text
    this.log('warn', `回复长度 ${text.length} 超过上限 ${limit}，已截断`)
    return text.slice(0, limit)
  }

  /** 投递。`dryRun` 时只记日志。 */
  private async deliver(selfId: string, inbound: InboundMessage, text: string): Promise<void> {
    const target = buildReply(inbound.channel, text, {
      // 群里带上 at，让对方知道这句话在回他
      atSender: inbound.channel.kind === 'group' ? inbound.senderId : undefined,
    })

    if (this.config.dryRun) {
      this.log('info', `[dryRun] 本应发到 ${target.describe}：${text}`)
      return
    }

    try {
      await this.ctx.onebot.call(selfId, target.action, target.params)
      this.log('info', `→ ${target.describe}：${text}`)
      // 发送成功才算"她说了话"（失败不是 —— 那是"她想说了但没说出去"）
      this.stats?.record({
        ts: Date.now(),
        direction: 'out',
        channel: inbound.channel.kind,
        groupId: inbound.channel.kind === 'group' ? inbound.channel.groupId : undefined,
        sender: inbound.channel.kind === 'group' ? inbound.channel.groupId : inbound.senderId,
        length: text.length,
      })
    } catch (error) {
      this.log('warn', `发往 ${target.describe} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── agent 生命周期 ──────────────────────────────────────────────────

  private async agentFor(
    sessionId: string,
    mode: Mode,
    account: { preset: string; model?: string },
  ): Promise<{ agent: Agent }> {
    const existing = this.agents.get(sessionId)
    if (existing) return { agent: existing.agent }

    // ⚠️ preset 由 mode 决定，而不是账号配置 —— 这样"管理员私聊才有 shell"
    //    是**能力构成**层面的保证（spec §6.10），不依赖运行期判定。
    const presetId = mode === 'admin' ? 'xiaoyan-admin' : account.preset

    const selection = this.ctx.agentDefaultModel.currentSelection()
    const model = this.config.model ?? account.model ?? selection.model

    // 解析或新建（共用件 `agent-session.ts`：mount / resume-else-create / 不吞错，
    // 三条纪律都写在那边的文件头 —— 她的日常生活走的是同一份实现）。
    // ⚠️ 两个服务在这里**显式传**：桥声明了 inject，但助手不替调用方碰 ctx ——
    //    世界引擎故意不 inject，见 `agent-session.ts` 的 `AgentServices` 说明。
    const resolved = await resumeOrCreateAgent(
      this.ctx,
      { agents: this.ctx.agents, agentPresets: this.ctx.agentPresets },
      {
        sessionId,
        presetId,
        agentOptions: { provider: selection.provider, model },
        ...(this.config.cwd === undefined ? {} : { cwd: this.config.cwd }),
      },
    )

    this.agents.set(sessionId, { agent: resolved.agent, dispose: resolved.dispose })
    this.log(
      'info',
      `${resolved.persisted ? '恢复' : '新建'}会话 ${sessionId}（preset=${presetId} model=${model}）`,
    )
    return { agent: resolved.agent }
  }

  private log(level: 'info' | 'warn', message: string): void {
    this.ctx.logger[level](`[yanxin-bridge] ${message}`)
  }
}

