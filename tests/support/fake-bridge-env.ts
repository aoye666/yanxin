/**
 * bridge 集成测试用的**假装配体**。
 *
 * bridge 的 6 个依赖全是**服务**，所以每个假服务都 `extends Service` 并
 * `super(ctx, '<真服务名>')` —— 运行时挂到 `ctx[name]`，与真装配体同形，
 * bridge 的 `inject` 才认得。
 *
 * ## 假 agent 的回合模型
 *
 * `followup()` **同步**把这一轮的事件推进 session 日志
 * （`turn/start` → `assistant/message` → `turn/end`），`whenIdle()` 按配置延迟解析。
 * 于是 bridge 的完整链路 ——
 * `whenIdle → seq 划界 → followup → whenIdle → flush → 读事件 → 回发` ——
 * 能在毫秒级跑完，而"这一轮模型回了什么"由测试脚本决定。
 *
 * ## 为什么 `sessionApi` 是可切换的
 *
 * 真实的 `agent.session` 有两种形态（ADR 0011）：npm 版有 `snapshotEvents`、
 * monorepo 版有 `events`。**实际运行时走的是 monorepo 那条**，所以两条都要能跑 ——
 * 只测一条正是当初漏掉这个 bug 的原因。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import MemoryService, { type MemoryHit, type MemoryProvider } from '../../src/memory/service.ts'
import type { EventFrame } from '../../src/onebot/protocol.ts'
import type { SetupStatus, SetupStep } from '../../src/setup/types.ts'
// ⚠️ 空类型导入不是多余的：`declare module '@deepseek-ai/cordis'` 的 Events 增强
// 在这里（`onebot/event` 等），不 import 就看不见（ADR 0010 记过同一个坑）。
import type {} from '../../src/onebot/service.ts'
import MemorySettings from './memory-settings.ts'

/** 假服务都直接 `new` 出来（构造即注册），测试里要拿实例引用。 */
type AnyCtx = Context

// ── 假 session：两种事件读取形态（**互斥**，与真实情况一致）──────────

/** 两种形态共有的部分：日志与追加。 */
abstract class BaseFakeSession {
  protected log: { seq: number; type: string; data: unknown }[] = []

  get seq(): number {
    return this.log.length
  }

  append(type: string, data: unknown): void {
    this.log.push({ seq: this.log.length, type, data })
  }

  /**
   * 仅供测试观察：日志里的事件类型序列。
   *
   * **刻意不叫 `events`** —— 那是 npm 形态的 API 名，给它起同名方法会让"两种形态互斥"
   * 这件事在假体上失真（正是当初漏掉 ADR 0011 那个 bug 的模式）。
   */
  observedTypes(): string[] {
    return this.log.map((event) => event.type)
  }
}

/**
 * monorepo 形态（`packages/core/session`，`0.1.0-rc.x`）：`get events()`。
 * **没有** `snapshotEvents` —— 这是真的，不是简化（ADR 0011）。
 */
export class EventsSession extends BaseFakeSession {
  get events(): readonly unknown[] {
    return this.log
  }
}

/**
 * npm 形态（`@deepseek-ai/dsh-session`，`0.1.5-rc.x`）：`snapshotEvents(from, to)`。
 * **没有** `events`。
 */
export class SnapshotSession extends BaseFakeSession {
  snapshotEvents(fromSeq = 0, toSeqExclusive = this.log.length): readonly unknown[] {
    return this.log.filter((event) => event.seq >= fromSeq && event.seq < toSeqExclusive)
  }
}

export type FakeSession = EventsSession | SnapshotSession

// ── 假 agent ──────────────────────────────────────────────────────────

export class FakeAgent {
  readonly session: FakeSession
  /** 记录 followup 收到的用户文本（用于断言"这一轮问了什么"）。 */
  readonly asked: string[] = []
  /** 记录每条入站消息的 `source`（T12 溯源）。 */
  readonly sources: unknown[] = []

  constructor(
    private readonly owner: FakeAgents,
    sessionId: string,
  ) {
    this.session = owner.sessionApi === 'events' ? new EventsSession() : new SnapshotSession()
    this.sessionId = sessionId
  }

  readonly sessionId: string

  async whenIdle(): Promise<void> {
    const wait = this.owner.idleWaitMs
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }

  followup(message: unknown): void {
    const inbound = message as { source?: unknown }
    this.asked.push(textOf(message))
    this.sources.push(inbound.source)
    this.owner.order.push(`followup:${this.sessionId}`)

    this.session.append('turn/start', { turn: 1 })
    if (this.owner.reply !== undefined) {
      this.session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: this.owner.reply }] },
        stream: [],
      })
    }
    this.session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
  }
}

/** 从 `createUserMessage` 的产物里取出文本（假 agent 不关心结构细节）。 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const typed = block as { type?: unknown; text?: unknown }
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
    })
    .join('')
}

// ── 六个假服务 ────────────────────────────────────────────────────────

export class FakeOneBot extends Service {
  readonly calls: { selfId: string; action: string; params: unknown }[] = []
  readonly accounts = new Map<string, { selfId: string; preset: string; model?: string }>()

  constructor(
    ctx: AnyCtx,
    /** 与 FakeAgents 共享的全局调用顺序（串行/并行断言用）。 */
    private readonly order: string[],
  ) {
    super(ctx, 'onebot')
  }

  account(selfId: string): { selfId: string; preset: string; model?: string } | undefined {
    return this.accounts.get(selfId)
  }

  async call(selfId: string, action: string, params: unknown): Promise<unknown> {
    this.order.push(`call:${action}`)
    this.calls.push({ selfId, action, params })
    return { message_id: 1 }
  }
}

export class FakeAgents extends Service {
  /** create 的入参留痕。 */
  readonly created: { sessionId: string; cwd: string | undefined; agentPreset: string | undefined }[] = []
  /** resume 的 session id 留痕。 */
  readonly resumed: string[] = []
  /** 磁盘上"已有日志"的 session id —— 决定 bridge 走 resume 还是 create。 */
  readonly persisted = new Set<string>()
  readonly live = new Map<string, FakeAgent>()

  /** 假的 session 暴露哪一种事件读取形态（ADR 0011 的两条路径）。 */
  sessionApi: 'snapshotEvents' | 'events' = 'snapshotEvents'
  /** `whenIdle()` 的延迟，用来让并发交错可观察。 */
  idleWaitMs = 0
  /** 这一轮"模型"回什么；`undefined` 表示不回文本。 */
  reply: string | undefined = '好的'

  constructor(
    ctx: AnyCtx,
    /** 与 FakeOneBot 共享的全局调用顺序。 */
    readonly order: string[],
  ) {
    super(ctx, 'agents')
  }

  get(sessionId: string): FakeAgent | undefined {
    return this.live.get(sessionId)
  }

  async create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    setup?: (agentCtx: AnyCtx) => Promise<void> | void
  }): Promise<{ agent: FakeAgent; dispose: () => Promise<void> }> {
    this.created.push({
      sessionId: options.sessionId,
      cwd: options.meta?.cwd,
      agentPreset: options.meta?.agentPreset,
    })
    return this.publish(options.sessionId, options.setup)
  }

  async resume(options: {
    resumeSessionId: string
    setup?: (agentCtx: AnyCtx) => Promise<void> | void
  }): Promise<{ agent: FakeAgent; dispose: () => Promise<void> }> {
    this.resumed.push(options.resumeSessionId)
    return this.publish(options.resumeSessionId, options.setup)
  }

  private async publish(
    sessionId: string,
    setup?: (agentCtx: AnyCtx) => Promise<void> | void,
  ): Promise<{ agent: FakeAgent; dispose: () => Promise<void> }> {
    const agent = new FakeAgent(this, sessionId)
    // setup 必须被真的调用 —— "preset 有没有挂上"正是要验证的东西
    await setup?.(this.ctx)
    this.live.set(sessionId, agent)
    return {
      agent,
      dispose: async () => {
        this.live.delete(sessionId)
      },
    }
  }
}

export class FakeAgentPresets extends Service {
  readonly mounts: string[] = []

  constructor(ctx: AnyCtx) {
    super(ctx, 'agentPresets')
  }

  async mount(_agentCtx: AnyCtx, presetId: string): Promise<void> {
    this.mounts.push(presetId)
  }
}

export class FakeSessions extends Service {
  readonly flushed: unknown[] = []

  constructor(ctx: AnyCtx) {
    super(ctx, 'sessions')
  }

  async flush(session: unknown): Promise<void> {
    this.flushed.push(session)
  }

  get(_sessionId: string): undefined {
    return undefined
  }
}

export class FakeAdmin extends Service {
  readonly admins = new Set<string>()

  constructor(ctx: AnyCtx) {
    super(ctx, 'admin')
  }

  isAdmin(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false
    return this.admins.has(candidate)
  }
}

export class FakeAgentDefaultModel extends Service {
  constructor(ctx: AnyCtx) {
    super(ctx, 'agentDefaultModel')
  }

  currentSelection(): { provider: string; model: string } {
    return { provider: 'fake-provider', model: 'fake-model' }
  }
}

export class FakePersistence extends Service {
  readonly ids = new Set<string>()

  constructor(ctx: AnyCtx) {
    super(ctx, 'sessionPersistence')
  }

  async list(): Promise<readonly { id: string }[]> {
    return [...this.ids].map((id) => ({ id }))
  }
}

/**
 * 假的向导服务（T30 的守卫要问它"她有没有人格 / 世界有没有创世"）。
 *
 * 默认**全部就绪**（`ready`）—— 那些测试要验的是别的东西（召回、preset、串行），
 * 让它们被"未初始化"挡下来只会掩盖各自要测的行为。要验守卫本身的用例把
 * `steps` 改成就绪以外的形态（见 `bridge.spec.ts` 的守卫组）。
 *
 * 形状只提供守卫用到的那几个字段（`progress()`），不拖进真的 SetupService ——
 * 守卫的契约就是"给我一个进度"，谁给的不重要。
 */
export class FakeSetup extends Service {
  status: SetupStatus = 'ready'
  steps: { step: SetupStep; completed: boolean; satisfied: boolean; missing: string[] }[] = [
    { step: 'persona', completed: true, satisfied: true, missing: [] },
    { step: 'background', completed: true, satisfied: true, missing: [] },
    { step: 'world', completed: true, satisfied: true, missing: [] },
    { step: 'accounts', completed: true, satisfied: true, missing: [] },
  ]

  constructor(ctx: AnyCtx) {
    super(ctx, 'setup')
  }

  async progress(): Promise<{
    status: SetupStatus
    next: SetupStep | null
    steps: { step: SetupStep; completed: boolean; satisfied: boolean; missing: string[] }[]
    reverted: SetupStep[]
    warnings: string[]
  }> {
    return {
      status: this.status,
      next: this.steps.find((state) => !state.satisfied)?.step ?? null,
      steps: this.steps,
      reverted: [],
      warnings: [],
    }
  }

  /** 把某一步设成"不成立"（守卫用例用；名字不用 `break` —— 它是保留字）。 */
  markUnsatisfied(step: SetupStep, missing: string[] = ['（测试）这一步不成立']): void {
    this.steps = this.steps.map((state) => (state.step === step ? { ...state, satisfied: false, missing } : state))
    const index = this.steps.findIndex((state) => state.step === step)
    this.status = index <= 0 ? 'init' : (this.steps[index - 1]?.step ?? 'init')
  }
}

// ── 装配 ──────────────────────────────────────────────────────────────

export interface BridgeEnv {
  ctx: Context
  onebot: FakeOneBot
  agents: FakeAgents
  presets: FakeAgentPresets
  sessions: FakeSessions
  admin: FakeAdmin
  defaultModel: FakeAgentDefaultModel
  /** 假的向导服务（T30 的守卫问它"准备好了吗"；默认全部就绪）。 */
  setup: FakeSetup
  /** `withPersistence: false` 时为 `undefined`。 */
  persistence: FakePersistence | undefined
  /** `options.memory` 未设置时为 `undefined`（= 没有记忆服务）。 */
  memoryProvider: FakeMemoryProvider | undefined
  /** 全局调用顺序（`followup:<sessionId>` / `call:<action>`）。 */
  order: string[]
  /** 推一个事件帧进 bridge（走真实的 `onebot/event` 通道）。 */
  emit(frame: EventFrame): void
  /** 等所有在飞的队列排空。 */
  settle(): Promise<void>
  dispose(): Promise<void>
}

export interface BridgeEnvOptions {
  /** 不挂 `sessionPersistence` —— 验证"没有持久化时 create 是安全的"。 */
  withPersistence?: boolean
  /**
   * 装载**真实** `MemoryService`（配内存 settings + 一个可编程的假 provider）。
   *
   * 用真服务而不是假服务，是为了让"召回注入 + 写回"这两条链路真的被跑到 ——
   * 包括降级（`fail: true` 时 service 会吞掉错误返回 `[]`）。
   */
  memory?: {
    /** 召回返回这些内容；空数组 = 没有记忆。 */
    hits?: string[]
    /** provider 抛错（验证降级不阻塞对话）。 */
    fail?: boolean
    /**
     * 攒满几轮才交给 provider。**默认 1（每轮即写）**。
     *
     * 本文件的写回用例关心的是“写回了什么内容 / 写到哪个 session_id”，
     * 不该被攒批这个变量干扰；攒批本身由 `tests/unit/memory-outbox.spec.ts` 覆盖，
     * 这里只留个别用例传真实阈值验证端到端（T42）。
     */
    batchRounds?: number
  }
  config?: {
    groupTrigger?: 'mention' | 'name' | 'never'
    nameWords?: string[]
    contextMessages?: number
    dryRun?: boolean
    cwd?: string
    maxReplyChars?: number
    model?: string
    stats?: boolean
    /** 不给就指向 :memory:（统计不落真实 $DSH_HOME，也不在临时目录留文件）。 */
    statsPath?: string
  }
}

/** 记录交互的假 provider（`recorded` 让测试能断言"写回了什么"）。 */
export interface FakeMemoryProvider extends MemoryProvider {
  readonly recorded: { sessionId: string; messages: readonly { role: string; content: string }[] }[]
}

function fakeMemoryProvider(script: { hits?: string[]; fail?: boolean }): FakeMemoryProvider {
  const recorded: FakeMemoryProvider['recorded'] = []
  const boom = (): never => {
    throw new Error('假 provider 故意失败')
  }
  return {
    id: 'bridge-fake',
    recorded,
    search: async (): Promise<readonly MemoryHit[]> => {
      if (script.fail === true) boom()
      return (script.hits ?? []).map((content) => ({ content, source: 'fake' }))
    },
    record: async (trajectory, sessionId) => {
      if (script.fail === true) boom()
      recorded.push({ sessionId, messages: trajectory.messages })
    },
    consolidate: async () => undefined,
    health: async () => ({ ok: script.fail !== true }),
  }
}

/**
 * 装出一个跑得起来的 bridge 环境。
 *
 * bridge 用 `ctx.plugin` 装载（走真实的 inject 解析），假服务直接 `new`（构造即注册），
 * 这样测试里能拿到实例引用做断言。
 */
export async function makeBridgeEnv(options: BridgeEnvOptions = {}): Promise<BridgeEnv> {
  const { default: OneBotBridge } = await import('../../src/onebot/bridge.ts')
  const { Context } = await import('@deepseek-ai/cordis')

  const ctx = new Context()
  const order: string[] = []
  const onebot = new FakeOneBot(ctx, order)
  const agents = new FakeAgents(ctx, order)
  const presets = new FakeAgentPresets(ctx)
  const sessions = new FakeSessions(ctx)
  const admin = new FakeAdmin(ctx)
  const defaultModel = new FakeAgentDefaultModel(ctx)
  const setup = new FakeSetup(ctx)
  // 不挂时 `ctx.get('sessionPersistence')` 返回 undefined —— 正是"没有持久化后端"的形态
  const persistence = options.withPersistence === false ? undefined : new FakePersistence(ctx)

  // 记忆（可选）：真实的 MemoryService + 假 provider —— 让"召回注入 / 写回"真的被跑到
  let memoryProvider: FakeMemoryProvider | undefined
  // ⚠️ 每个 env **一个独立的缓冲目录**：outbox 是落盘的，而同一测试文件里
  // `DSH_HOME` 只算一份 —— 共目录会让上一个用例没跑完的缓冲被下一个用例的
  // `recover()` 读出来补发给新 provider（症状：`recorded` 条数莫名变多）。
  let outboxDir: string | undefined
  if (options.memory !== undefined) {
    outboxDir = await mkdtemp(join(tmpdir(), 'yanxin-test-outbox-'))
    await ctx.plugin(MemorySettings)
    await ctx.plugin(MemoryService, {
      provider: 'none', // 不自动装 ReMe；下面手动注入假 provider
      endpoint: 'http://127.0.0.1:2333',
      searchLimit: 5,
      requestTimeoutMs: 10_000,
      writeTimeoutMs: 120_000,
      batchRounds: options.memory.batchRounds ?? 1,
      outboxDir,
    })
    memoryProvider = fakeMemoryProvider(options.memory)
    ctx.memory.setProvider(memoryProvider)
  }

  await ctx.plugin(OneBotBridge, {
    groupTrigger: 'mention',
    nameWords: ['小研'],
    // 假环境默认**关掉**上下文注入：现有那批"prompt 逐字节一致"的验收比较的是记忆那条线，
    // 不该顺带把群上下文卷进来。要测上下文用 `options.config.contextMessages` 显式打开。
    contextMessages: 0,
    dryRun: false,
    maxReplyChars: 2000,
    // 统计默认开，但落在 **:memory:**（测试不该写真实 $DSH_HOME，也不留临时文件）；
    // 要测统计本身就用 `options.config.statsPath` 指向临时目录，或 `stats: false` 关掉。
    stats: options.config?.stats ?? true,
    statsPath: options.config?.statsPath ?? ':memory:',
    ...options.config,
  })

  return {
    ctx,
    onebot,
    agents,
    presets,
    sessions,
    admin,
    defaultModel,
    setup,
    persistence,
    memoryProvider,
    order,
    emit(frame) {
      ctx.emit('onebot/event', frame)
    },
    async settle() {
      // 队列是 promise 链，给它几个宏任务周期排空
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    },
    async dispose() {
      await ctx.fiber.dispose()
      if (outboxDir !== undefined) await rm(outboxDir, { recursive: true, force: true })
    },
  }
}

// ── 造事件帧 ──────────────────────────────────────────────────────────

export const BOT = '2000000002'
export const OWNER_QQ = '1000000001'
export const GROUP = '3000000003'

export function messageFrame(over: {
  messageType: 'group' | 'private'
  userId: string
  groupId?: string
  text: string
  at?: string
  selfId?: string
}): EventFrame {
  const selfId = over.selfId ?? BOT
  const segments: unknown[] = []
  if (over.at !== undefined) segments.push({ type: 'at', data: { qq: over.at } })
  segments.push({ type: 'text', data: { text: over.text } })

  const raw: Record<string, unknown> = {
    time: Math.floor(Date.now() / 1000),
    self_id: Number(selfId),
    post_type: 'message',
    message_type: over.messageType,
    sub_type: over.messageType === 'group' ? 'normal' : 'friend',
    message_id: 9001,
    user_id: Number(over.userId),
    font: 0,
    sender: { user_id: Number(over.userId), nickname: '测试者', role: 'member' },
    message: segments,
    raw_message: over.at === undefined ? over.text : `[CQ:at,qq=${over.at}] ${over.text}`,
  }
  if (over.groupId !== undefined) raw.group_id = Number(over.groupId)

  return { kind: 'event', postType: 'message', selfId, raw }
}
