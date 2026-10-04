/**
 * 记忆服务的**契约外壳**（`ctx.memory`）—— spec §6.9。
 *
 * ## 为什么自建
 *
 * DSH **没有一等公民的记忆子系统**（全仓库 grep `reme` 零命中，`docs/subsystems/` 无
 * `memory.md`）。所以我们在 DSH 的 session（**当前对话**）之上叠一层"**跨会话**的长期记忆"。
 *
 * ## 职责分工（这是本文件的核心设计）
 *
 * ```
 *   bridge / 未来的世界引擎
 *          │  只认这一个契约
 *          ▼
 *   MemoryService（本文件）      ← 降级包装、settings、契约稳定
 *          │  MemoryProvider
 *          ▼
 *   ReMe / 别的后端（T14）        ← 真实 IO
 * ```
 *
 * **降级统一在服务层实现一次**，provider 只管如实抛错。这样"记忆挂掉不阻塞对话"
 * 这条承诺不依赖每个 provider 都记得写 try/catch —— 换后端时也不会退化。
 *
 * ## 降级的三个层次（都不抛）
 *
 * | 情形 | 行为 |
 * |---|---|
 * | **没有 provider**（未配置） | `search` → `[]`；不记 warn（这是正常形态，不是故障） |
 * | provider 抛错 / 超时 | `search` → `[]` + **WARN**（可观测：反复失败要能查） |
 * | `record` / `consolidate` 失败 | 记 WARN，**不阻塞对话**（写回是异步沉降，丢一轮可接受） |
 *
 * ⚠️ **`record` 不等于“已沉淀”**（T42）：写回先进 `MemoryOutbox` 攒批（每 session 攒满
 * `batchRounds` 轮才交给后端），因为 ReMe 的 `auto_memory` 要在服务端跑 LLM 沉淀
 * （实测 19-27s），每轮都写只会让它反复 merge 同一张卡。理由与崩溃语义见 `outbox.ts`。
 *
 * ⚠️ **`health()` 不抛**：它是**探测**，调用方（启动期检查、控制台）需要的是"行不行 +
 * 为什么"，而不是一个异常。provider 抛错时把它转成 `{ ok: false, detail }`。
 *
 * ⚠️ **`record` 而非 `add`**：ReMe 没有 add 工具 —— 写回靠它监听对话自动完成
 * （`auto_memory`，每 session 每天最多沉淀一张卡）。接口名如实反映，避免抽象泄漏。
 *
 * ⚠️ 装配纪律：只用 `export default`（ADR 0004）；实例字段用 TS `private`（ADR 0007）。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { describeError as describe } from '../describe.ts'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { MemoryOutbox, defaultOutboxDir } from './outbox.ts'
import { RemeProvider, assertLoopbackEndpoint } from './reme.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
  interface Events {
    /** provider 被装载 / 卸下（参数为 provider id，或 undefined 表示没有）。 */
    'yanxin/memory-provider'(providerId: string | undefined): void
  }
}

/** 一条召回结果（spec §6.9）。 */
export interface MemoryHit {
  /** 记忆正文。 */
  content: string
  /** 来源（文件路径或 provider 自己的标识）。 */
  source: string
  /** 在来源文件里的行号区间。 */
  lines?: [number, number]
  /** 关联的其它记忆（wikilink 邻居之类）。 */
  links?: string[]
  /** provider 给的排序分。 */
  score?: number
  /**
   * 溯源：这条记忆来自哪个模式 / 会话。
   *
   * ⚠️ 这是**记录**，不是**授权依据** —— 能力边界由 preset 决定（spec §6.10）。
   */
  sessionId?: string
}

/** 轨迹里的一条消息。刻意只用 `role` + `content`，不引 DSH 的 Message 类型。 */
export interface TrajectoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 一段对话轨迹 —— 交给 provider 沉淀的材料。
 *
 * 形状刻意保持最小（一个 `messages` 数组）：契约不该把 DSH 的消息结构泄漏给后端，
 * 否则换后端时两边都要改。T14 接 ReMe 时若发现它需要更多字段，**加在这里**并同步
 * 更新本注释，而不是让 provider 去 import DSH 的类型。
 */
export interface Trajectory {
  messages: readonly TrajectoryMessage[]
}

/** 健康探测结果。`detail` 在 `ok: false` 时应当能说明原因。 */
export interface MemoryHealth {
  ok: boolean
  detail?: string
}

/**
 * provider 契约 —— T14 用 ReMe 实现它，测试用假实现。
 *
 * **实现者只需如实抛错**：降级、超时、日志都在 `MemoryService` 那一层。
 */
export interface MemoryProvider {
  /** 用于日志与 `yanxin/memory-provider` 事件的标识（如 `reme`）。 */
  readonly id: string
  search(query: string, options: { limit: number }): Promise<readonly MemoryHit[]>
  record(trajectory: Trajectory, sessionId: string): Promise<void>
  consolidate(): Promise<void>
  health(): Promise<MemoryHealth>
}

/**
 * settings 命名空间。
 *
 * ⚠️ 形式受 `SettingsNamespaceInput` 约束：**只允许小写字母、数字、连字符** ——
 * 点号不合法（ADR 0007）。所以是 `yanxin-memory` 而不是 `yanxin.memory`。
 */
const NAMESPACE = 'yanxin-memory'

/**
 * 默认配置。
 *
 * ⚠️ **schema 刻意不写 `.default()`** —— 这是一个反直觉但必要的选择。
 *
 * 配置有两个来源：**行 config**（bundle patch 里写的，部署基线）与 **settings**
 * （运行时可改，控制台/手改 `settings.yaml`）。取值顺序是 **settings → 行 config → 这里的默认**。
 *
 * 如果 schema 带 `.default()`，`settings` 文档里**永远**有值（schema 自己填的），
 * 于是行 config 被**静默忽略** —— 实测踩到：测试传 `searchLimit: 3` 却拿到 5。
 * 所以默认值只放在这一处常量里，三级回退在 {@link MemoryService.current} 显式写出来。
 */
export const MEMORY_DEFAULTS = {
  provider: 'none',
  endpoint: 'http://127.0.0.1:2333',
  searchLimit: 5,
  /**
   * **快路径**超时（`search` / `health_check`）—— 它在用户可感路径上，必须短。
   *
   * ⚠️ 不要拿它去管写回（T41 的根因）：`auto_memory` 实测要 19-27s，共用 10s
   * 会把慢路径**无条件误报为失败**，并遮蔽真故障。写回阈値见 `writeTimeoutMs`。
   */
  requestTimeoutMs: 10_000,
  /** **慢路径**超时（`auto_memory` / `auto_dream`）。实测 19-27s，给 120s 留余量。 */
  writeTimeoutMs: 120_000,
  /** 每 session 攒满多少轮才交给后端沉淀。`1` = 退化为“每轮即写”（旧行为）。 */
  batchRounds: 10,
} as const

const ConfigSchema = z.object({
  provider: z.string().description('记忆后端 id。`none` = 不装载 provider（所有召回为空，对话照常）。'),
  endpoint: z
    .string()
    .description('后端地址。默认指向本机 ReMe —— 它没有鉴权，绍不要指向非回环地址。'),
  searchLimit: z.natural().description('每次召回返回的最大条数。'),
  requestTimeoutMs: z
    .natural()
    .description('快路径（search/health_check）超时（毫秒）。它卡着用户回复，别调大。'),
  writeTimeoutMs: z
    .natural()
    .description(
      '慢路径（auto_memory/auto_dream）超时（毫秒）。后端要跑 LLM 沉淀，实测 19-27s（T41）。',
    ),
  batchRounds: z
    .natural()
    .description('每个 session 攒满多少轮才交给后端沉淀。`1` = 每轮即写（旧行为）。'),
  outboxDir: z
    .string()
    .description('写回缓冲目录。默认 `$DSH_HOME/yanxin/memory-outbox`；测试里请指向临时目录。'),
})

/** 行 config / settings 里**可能不全**（回退见 {@link MEMORY_DEFAULTS}）。 */
interface MemoryConfig {
  provider?: string
  endpoint?: string
  searchLimit?: number
  requestTimeoutMs?: number
  writeTimeoutMs?: number
  batchRounds?: number
  outboxDir?: string
}

/** 解析后的形态：每个键都保证有值。 */
export interface ResolvedMemoryConfig {
  provider: string
  endpoint: string
  searchLimit: number
  requestTimeoutMs: number
  writeTimeoutMs: number
  batchRounds: number
  outboxDir: string
}

export default class MemoryService extends Service {
  static readonly inject = ['settings']

  static readonly Config: z<MemoryConfig> = ConfigSchema

  /** 当前 provider。`undefined` = 没有（降级为空召回，不是错误）。 */
  private active: MemoryProvider | undefined

  /** 卸载当前 provider 的收尾闭包（`setProvider` 的返回物）。 */
  private disposeProvider: (() => void) | undefined

  /** 写回缓冲（T42）。**首次写回时惰性建**：没配 provider 就不该创建文件/扫盘。 */
  private outbox: MemoryOutbox | undefined

  /** 已调用、还没落进 outbox 缓冲的 `record` 数（排空判据要连这段一起看）。 */
  private inFlightRecords = 0

  /** `yanxin-memory` 命名空间的 settings 作用域（三级回退的第一级）。 */
  private readonly scope: SettingsScope<MemoryConfig>
  private readonly config: MemoryConfig

  constructor(
    ctx: Context,
    config: MemoryConfig,
  ) {
    super(ctx, 'memory')
    this.config = config
    this.scope = ctx.settings.register(NAMESPACE, ConfigSchema)

    // 装载 provider，并随 settings 变化重装。
    //
    // ⚠️ **构造期就同步一次**，而且是**不吞错**的 —— 端点配成非回环时要让装载直接失败
    //    （spec §6.9：ReMe 无鉴权，绝不对外暴露），而不是等第一次召回才在日志里冒一条 warn。
    ctx.effect(() => {
      this.syncProvider()
      return this.scope.watch(() => {
        // settings 是**运行时可改**的：改坏了不该让整个服务崩掉，
        // 但也不能静默 —— 记 warn 并退回"无 provider"（降级到无记忆）。
        try {
          this.syncProvider()
        } catch (error) {
          this.log(`provider 重装失败，已退回无记忆：${describe(error)}`)
          this.dropProvider()
        }
      })
    }, 'yanxin-memory.provider')

    // 优雅退出时把攒着没满批的写回先沉淀掉。
    //
    // 这不是“时间兼底”（那要定时器，已拍板归 Phase 4 的窗口基础设施），而是
    // 落盘攒批自带的收尾：攒了 3 轮就重启，不冲掉就永远等不到第 10 轮。
    // 崩溃（没走到 cleanup）仍会留残留，那部分由 `recover()` 下次启动补发。
    ctx.effect(
      () => () => {
        void this.outbox?.flushAll()
      },
      'yanxin-memory.outbox-drain',
    )
  }

  /**
   * 按当前配置同步 provider（幂等）。
   *
   * 三种配置值：
   *   · `none`  → 不装（正常形态：无记忆）
   *   · `reme`  → 校验回环后装载（**校验失败会抛**）
   *   · 其它    → warn 并按无记忆运行（记忆是增强，配置写错不该让 bot 起不来）
   */
  private syncProvider(): void {
    const resolved = this.current
    if (this.active?.id === resolved.provider) return

    this.dropProvider()

    if (resolved.provider === 'none') return

    if (resolved.provider !== 'reme') {
      this.log(`未知的 provider "${resolved.provider}"，按无记忆运行（可选：none / reme）`)
      return
    }

    const endpoint = assertLoopbackEndpoint(resolved.endpoint)
    this.disposeProvider = this.setProvider(
      new RemeProvider({
        endpoint,
        timeoutMs: resolved.requestTimeoutMs,
        writeTimeoutMs: resolved.writeTimeoutMs,
      }),
    )

    // provider 一就位就建写回缓冲并**补发崩溃残留**（T42 的 recover）：上次进程死在
    // "攒满 10 轮但没 flush"的 session，如果从此不再说话，惰性建（首次 record 才建）
    // 会让那批**永远**等不到补发。这里主动建一次，残留至少在启动后就被冲走。
    this.ensureOutbox()
  }

  private dropProvider(): void {
    this.disposeProvider?.()
    this.disposeProvider = undefined
  }

  /** 当前生效的配置：**settings → 行 config → 内置默认**，三级回退。 */
  get current(): ResolvedMemoryConfig {
    const fromSettings = this.scope.get()
    const requestTimeoutMs =
      fromSettings.requestTimeoutMs ?? this.config.requestTimeoutMs ?? MEMORY_DEFAULTS.requestTimeoutMs
    const writeTimeoutMs =
      fromSettings.writeTimeoutMs ?? this.config.writeTimeoutMs ?? MEMORY_DEFAULTS.writeTimeoutMs
    const batchRounds = fromSettings.batchRounds ?? this.config.batchRounds ?? MEMORY_DEFAULTS.batchRounds
    return {
      provider: fromSettings.provider ?? this.config.provider ?? MEMORY_DEFAULTS.provider,
      endpoint: fromSettings.endpoint ?? this.config.endpoint ?? MEMORY_DEFAULTS.endpoint,
      searchLimit: fromSettings.searchLimit ?? this.config.searchLimit ?? MEMORY_DEFAULTS.searchLimit,
      // ⚠️ 钳到 ≥1：schemastery 的 `z.natural()` 接受 0，而 0ms 超时 = `AbortSignal.timeout(0)`
      //    立即中止 —— 运维写 0 的心智多半是"禁用超时/不限"，实际效果是记忆整体降级为
      //    空召回 + 刷 WARN（`??` 也不会把 0 当缺省回退）。`batchRounds: 0` 同理钳为 1。
      requestTimeoutMs: Math.max(1, requestTimeoutMs),
      writeTimeoutMs: Math.max(1, writeTimeoutMs),
      batchRounds: Math.max(1, batchRounds),
      outboxDir: fromSettings.outboxDir ?? this.config.outboxDir ?? defaultOutboxDir(),
    }
  }

  /** 当前 provider 的 id（没有则 `undefined`）。 */
  get providerId(): string | undefined {
    return this.active?.id
  }

  /**
   * 装载一个 provider（T14 的 ReMe 在自己的插件行里调它；测试里注入假的）。
   *
   * 返回 **disposer**（spec §7.2 的副作用纪律）：provider 卸载时把自己摘掉，
   * 而不是留一个指向死对象的引用。
   */
  setProvider(provider: MemoryProvider | undefined): () => void {
    const previous = this.active
    this.active = provider
    this.ctx.emit('yanxin/memory-provider', provider?.id)
    // 单次生效：重复调用这个 disposer 不该把"后来者"也摘掉
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.active !== provider) return
      this.active = previous
      this.ctx.emit('yanxin/memory-provider', this.active?.id)
    }
  }

  /**
   * 召回：跨 session 全 workspace 检索。
   *
   * **永不抛**。没有 provider → `[]`（静默，这是正常形态）；provider 失败 → `[]` + WARN
   * （可观测 —— 记忆反复失败要能从日志里查出来，否则"小研变笨了"会无从归因）。
   */
  async search(query: string, options: { limit?: number } = {}): Promise<MemoryHit[]> {
    const provider = this.active
    if (provider === undefined) return []

    const limit = options.limit ?? this.current.searchLimit
    try {
      const hits = await provider.search(query, { limit })
      // 归一化成数组：provider 契约写的是 readonly，运行时不该因为返回 undefined 就让调用方炸
      return Array.isArray(hits) ? [...hits] : []
    } catch (error) {
      this.log(`召回失败（降级为空）：${describe(error)}`)
      return []
    }
  }

  /**
   * 写回：不直接写，而是把一轮交给 outbox 攒批（T42）。
   *
   * **永不抛**。注意语义变化：本方法 resolve **只意味着“已收下并落盘”**，
   * 不意味着已交给后端 —— 真正的 `auto_memory` 要等攒满 `batchRounds` 轮（或退出/手动 flush）。
   * 这样才可能不把 19-27s 的 LLM 沉淀接回对话路径。
   */
  async record(trajectory: Trajectory, sessionId: string): Promise<void> {
    // 计数在**任何 await 之前**加：调用方是 `void memory.record(…)`（挂在微任务上），
    // 而 append 要 await 落盘才把轮数记进 outbox —— 只数 outbox 的话，"已收下但还没落盘"
    // 的那一段在排空判据里是隐形的（2026-10-05 测试就是这么间歇只看到一条写回）。
    this.inFlightRecords += 1
    try {
      if (this.active === undefined) return
      await this.ensureOutbox().append(sessionId, trajectory)
    } finally {
      this.inFlightRecords -= 1
    }
  }

  /**
   * 把某 session 攒着的写回立刻沉淀掉（未满批也发）。
   *
   * ⚠️ 目前**只有测试在用**（优雅退出走 effect 里的 `flushAll`；控制台的记忆页
   * 尚未接它）。留着是因为"手动冲一把缓冲"是运营上真实会需要的动作，
   * 控制台接线时这就是入口 —— 但别误以为它已经可达。
   */
  async flush(sessionId: string): Promise<void> {
    await this.outbox?.flush(sessionId)
  }

  /**
   * 某 session 当前攒了多少轮。
   *
   * ⚠️ 同 `flush`：目前仅测试消费（"为什么她还没记住"这个运营问题还没有页面回答）。
   */
  pendingRounds(sessionId: string): number {
    return this.outbox?.pendingRounds(sessionId) ?? 0
  }

  /**
   * 全部 session 攒着的轮数之和（回到 0 = 没有写回还在飞）。
   *
   * ⚠️ 同 `flush` / `pendingRounds`：目前只有测试拿它做排空判据。写回本身是
   * `void memory.record(…)` 挂在会话队列之外的（沉淀要跑十几秒，不该挡住下一轮），
   * 所以桥的 `drainQueues` 看不见它 —— 测试要等"她记住了"，就得问这个数。
   */
  pendingRoundsTotal(): number {
    return this.inFlightRecords + (this.outbox?.pendingRoundsTotal() ?? 0)
  }

  /**
   * 惰性建 outbox。
   *
   * 只建**一次**：配置里的 `batchRounds`/`outboxDir` 后来被改不会重建缓冲（改了阈值
   * 不该把已攒的轮丢掉）。provider 则在 `send` 里**动态取** `this.active`，
   * 所以换后端/暂摘 provider 都不会让缓冲丢失 —— 取不到时抛，由 outbox 保留缓冲。
   */
  private ensureOutbox(): MemoryOutbox {
    if (this.outbox !== undefined) return this.outbox

    const resolved = this.current
    this.outbox = new MemoryOutbox({
      dir: resolved.outboxDir,
      rounds: resolved.batchRounds,
      send: async (trajectory, sessionId) => {
        const provider = this.active
        if (provider === undefined) throw new Error('provider 已被卸下，本轮沉淀延后')
        await provider.record(trajectory, sessionId)
      },
      warn: (message) => this.log(message),
    })

    // 上次可能在“send 成功之前”崩掉，那批还在盘上：补发已达阈值的，未满的继续攒。
    void this.outbox.recover()
    return this.outbox
  }

  /**
   * 触发 provider 的固化流程（ReMe 的 `auto_dream`）。**永不抛**。
   *
   * ⚠️ `auto_dream` **目前没有任何调用点**（T42 已核）。“晚上整理今天记忆”归
   * Phase 4 的窗口/定时器基础设施；本方法先作为契约存在。
   *
   * 已验证它**不是召回的前提**：ReMe 的 `search` 能直接命中 `daily/` 里的卡，
   * 所以不跑 dream 只是“不精炼”，不是“记不住”。
   */
  async consolidate(): Promise<void> {
    const provider = this.active
    if (provider === undefined) return
    try {
      await provider.consolidate()
    } catch (error) {
      this.log(`整理失败（忽略）：${describe(error)}`)
    }
  }

  /**
   * 健康探测 —— 供启动期检查与 `/yanxin` 控制台。
   *
   * ⚠️ **不抛**：它是探测，调用方要的是"行不行 + 为什么"。provider 抛错时转成
   * `{ ok: false, detail }`，而不是把异常丢回给一个正在渲染状态页的人。
   */
  async health(): Promise<MemoryHealth> {
    const provider = this.active
    if (provider === undefined) {
      return { ok: false, detail: `未装载 provider（配置 provider = ${this.current.provider}）` }
    }
    try {
      return await provider.health()
    } catch (error) {
      return { ok: false, detail: describe(error) }
    }
  }

  private log(message: string): void {
    this.ctx.logger.warn(`[yanxin-memory] ${message}`)
  }
}
