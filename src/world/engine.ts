/**
 * World 引擎（`ctx.world`）—— 她"过日子"的那个服务（T27b 填实）。
 *
 * ## 它做什么
 *
 * 1. **打开世界**：`$DSH_HOME/yanxin/world/` 里的内核 / 时钟 / 闸门 / 笔记 / 闭环
 *    （见 `assemble.ts`）——顺序有讲究，且**异步打开**（读盘）
 * 2. **驱动世界**：Tingle 心跳（每 30 TU = 30 秒）想一轮；短心跳（`tickMs`）报活 +
 *    把已提交但还没发出的发言补发出去（工具那条路的 `say` 就在这条路上落地）
 * 3. **当世界工具的门面**：`look` / `submit` / `writeNote` / `listNotes`（T26 的四个动词）
 *    —— 于是 `world_observe` / `world_act` / `world_say` / `world_note` 真的能动这个世界
 *
 * ## 生命周期（窗口关了就真的停）
 *
 * 启停由窗口服务驱动（T19）：窗口关闭 → 这一行被 dispose → 心跳停、时钟停、订阅断。
 * 所以两件事都要绑 `ctx.effect`，而"异步打开"要额外防一个竞态：
 * **打开还在飞的时候收尾**（读盘可能比一次窗口裁决慢）——那时 `openWorld` 回来发现
 * 本次装载已经作废，必须自己收摊（否则留下一个没人管的循环在转）。判"作废"用**装载代数**
 * 而不是布尔标志：布尔会被下一次装载复位，于是旧 open 以为自已还活着，和新那轮抢同一个
 * 会话 id（字段注释在 `generation` 上）。
 *
 * ## 它**不**做的事
 *
 *   · 不自己造时间（时钟给）· 不自己写世界（内核是唯一入口）
 *   · 不直接发消息（闸门负责；这里只把"发什么"接到 OneBot）
 *   · 不决定她怎么想（`decide` 是注入的 —— T27b-3 接 agent 会话）
 *
 * ## 与"未初始化"的关系
 *
 * 窗口服务（`window`）在装载本行之前会问一次守卫："世界创世了吗"——
 * 没创世就不装载（她还没有可以过日子的地方，见 `setup/guard.ts`）。
 * 但本服务**自己也要能活**：万一世界目录缺东西（`clock.json` 还没有），
 * 就**如实报错并停在这一状态**，而不是假装在跑。
 *
 * ⚠️ 装配纪律：只用 `export default`（ADR 0004）；实例字段用 TS `private`（ADR 0007）。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { worldDir as defaultWorldDir } from '../setup/install.ts'
import { openWorld, type Decide, type OpenWorld } from './assemble.ts'
import { createLifeDecide } from './life.ts'
import type { Intent } from './bot-loop.ts'
import type { Observation, PhoneMessage } from './observe.ts'
import { PhoneBuffer, isGroupMessage } from './phone.ts'
import type { OutboxItem } from './outbox.ts'
import { buildReply } from '../onebot/session-trigger.ts'
import { describeError as describe } from '../describe.ts'
// 类型层面：让本文件"看见" onebot/service.ts 对 Events 的增强（'onebot/event'）。
// `import type` 会被编译擦除，运行时没有任何副作用。
import type {} from '../onebot/service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    world: WorldEngine
  }
  interface Events {
    /** 一次世界心跳（seq 单调递增）。控制台与审计订阅它。 */
    'yanxin/world-tick'(seq: number): void
  }
}

/**
 * 默认配置（行 config 缺省时用）。
 *
 * ⚠️ 与其它服务一致：**schema 刻意不写 `.default()`** —— 写了的话行 config 会被
 * 静默忽略（memory 的实测教训）。默认只放这一处常量。
 */
export const ENGINE_DEFAULTS = {
  /**
   * 报活 + 补发心跳：60 秒。
   *
   * ⚠️ 它**不是**"她想一轮"的节拍（那是 Tingle，默认 30 TU = 30 秒）：这条心跳只做两件事 ——
   * 记一次活着的证据（T19 的"真的在转"判据 + 控制台），以及**把已提交但还没发出的
   * 发言补发出去**（她经工具说的那句话不必等到 30 分钟后的 Tingle 才出门）。
   */
  tickMs: 60_000,
  /** 她的世界群（她的话发到哪里）。缺省空 = 没配，发射会如实失败（不静默丢）。 */
  worldGroupId: '',
  /** 她自己在世界里的实体 id（与 `setup` 的缺省一致）。 */
  selfId: 'yanxin',
} as const

const ConfigSchema = z.object({
  tickMs: z.natural().description('报活 + 补发心跳的间隔（毫秒）。'),
  worldGroupId: z.string().description('她的世界群号（她对外说的话发到这里）。'),
  account: z.string().description('她的 QQ 号（会话 id 用 `world:<QQ>`；缺省取 onebot 注册表的第一个账号）。'),
  selfId: z.string().description('她自己在世界里的实体 id（创世时写进世界的那个）。'),
  worldDir: z.string().description('世界目录；缺省 $DSH_HOME/yanxin/world（测试请指向临时目录）。'),
  model: z.string().description('覆盖她过日子用的模型（缺省走 agent-default-model 的当前选择）。'),
  cwd: z.string().description('她的会话工作目录；**必须与桥的 cwd 一致**，缺省会落到内核检出目录。'),
  tingleEveryUnits: z.number().description('Tingle 间隔（TU）；<= 0 表示不启动心跳（测试用）。'),
  packageRoot: z.string().description('包根（人格源/preset 所在）；一般不用配。'),
})

/**
 * 运营配置的 settings 命名空间（她的世界群号）。
 *
 * ⚠️ **注册挂在 console 服务上**（常驻 root 行），不挂本引擎 —— 引擎行会随窗口
 * 卸下，而 fiber 的注销会带走它名下的 settings 注册：挂引擎上意味着"世界一停
 * 就改不了群号"。挂在常驻的 console 上，写路径永不断。
 *
 * 本引擎**只读**：`settings.get(ns)` 对未注册命名空间返回 undefined（不抛），
 * 于是装载顺序无关紧要 —— console 注册之前读到的是 undefined，回退行 config。
 * 读取优先级：settings → 行 config → 内置缺省。
 */
export const WORLD_SETTINGS_NS = 'yanxin-world'

export const WORLD_SETTINGS_SCHEMA = z.object({
  worldGroupId: z
    .string()
    .default(undefined as never)
    .description('她的世界群号（她对外说的话发到这里）。改完下一句话就生效，不用重启。'),
})

/**
 * 世界的只读状态（`status()` 的返回）。
 *
 * 数值字段一律可空：`ready: false` 时它们全是 `null` —— 页面上显示"—"比显示 `0` 诚实
 * （0 会让"世界没打开"看起来像"世界是空的"）。
 */
export interface WorldStatus {
  /** 世界打开好了没有（窗口没开 / 世界没创世时是 false）。 */
  ready: boolean
  /** 世界时间（TU）。 */
  tu: number | null
  /** T=0 对应的**现实**时刻（纪元，ms）—— 她说"今天"时锚在这一刻。 */
  era: number | null
  /** 已提交的事务数。 */
  sequence: number | null
  entities: number | null
  actions: number | null
  /** 报活心跳计数（窗口开了之后才会增长）。 */
  ticks: number
  /** 本进程收到的 OneBot 事件数。 */
  inbound: number
  /** 当前生效的世界群号（settings → 行 config → 缺省；空串 = 没配，她说的话发不出去）。 */
  groupId: string
}

/** 行 config 里字段可能不全（回退见 {@link ENGINE_DEFAULTS} + `install.ts` 的路径推导）。 */
interface EngineConfig {
  tickMs?: number
  worldGroupId?: string
  account?: string
  selfId?: string
  worldDir?: string
  tingleEveryUnits?: number
  packageRoot?: string
  /** 覆盖模型（缺省走 agentDefaultModel 的当前选择）。 */
  model?: string
  /**
   * 她的会话工作目录。
   *
   * ⚠️ 不传就会落到 `process.cwd()` —— 那是**内核检出目录**，里面有内核自己的 `AGENTS.md`，
   * 而 agent 会把 cwd 往上的工作区说明文件注入 prompt。症状不是报错，是她的内心独白
   * 里混进"SQLite 用单调 SCHEMA_VERSION""Remove this section at the first tagged release"
   * 这类给改 DSH 代码的人看的指令（2026-10-01 从会话落盘里抓到）。
   */
  cwd?: string
}

export default class WorldEngine extends Service {
  /**
   * 不需要 inject 任何服务。
   *
   * ⚠️ 故意**不** inject `onebot` / `worldModel` / `setup`：
   *   · `ctx.on('onebot/event', ...)` 只依赖事件总线，不等待服务就位
   *   · 模型与账号都是**运行时软查**（`ctx.get`）——把它们写进 inject 会让引擎
   *     pending 在它们身上，于是"窗口开了但引擎起不来"这种最难查的状态就出现了
   */
  static readonly inject: readonly string[] = []

  static readonly Config: z<EngineConfig> = ConfigSchema

  /** 心跳序号（T19 的"真的在转 / 停掉后不再增长"判据）。 */
  private seq = 0

  /** 入站 OneBot 事件计数（T19 的"订阅随 dispose 断开"判据）。 */
  private inboundCount = 0

  /** 她的手机（外部消息的缓冲，T27b-5）—— 去重、限长、只追加，见 `phone.ts`。 */
  private readonly phone = new PhoneBuffer()

  /** 行 config 给的她的 QQ 号（没给就从 onebot 注册表软查，见 `accountOf`）。 */
  private readonly configAccount?: string

  /** 解析出来的账号缓存（避免每条消息都软查一次）。 */
  private phoneAccount?: string

  /** 打开好的世界（还没打开完 / 已关时是 `undefined`）。 */
  private world?: OpenWorld

  /**
   * 装载代数。每次 effect 起一次 open 就 +1，收尾时再 +1 让在飞的那次作废。
   *
   * ⚠️ 为什么不是一个布尔 `disposed`：布尔会被**下一次装载**复位成 false，于是一次
   * 还没跑完的旧 open 在恢复执行时看到"没被关"，把 `this.world` 覆盖成新装载的那份，
   * 而它自己的循环也在跑 —— 两条生活共用同一个 session id，第二份直接撞
   * `session "…" already exists`（2026-10-04 线上那 49 次的第二个成因）。
   * 代数只对"我这次装载还作不作数"负责，复位不了。
   */
  private generation = 0

  /** 在飞的 open（收尾要等它落定，否则下一次打开会撞上它还没摘掉的会话）。 */
  private opening: Promise<void> | undefined

  /** 她这段生活的会话句柄收尾（窗口关闭时调，见 lifecycle effect 的清理）。 */
  private lifeDispose: (() => Promise<void>) | undefined

  /** 行 config 里的世界群号（settings 里没有时用它 —— 见 `effectiveGroupId`）。 */
  private readonly configGroupId: string | undefined

  constructor(ctx: Context, config: EngineConfig = {}) {
    super(ctx, 'world')

    const tickMs = positive(config.tickMs, ENGINE_DEFAULTS.tickMs)
    const dir = config.worldDir ?? defaultWorldDir()
    this.configAccount = config.account
    this.configGroupId = config.worldGroupId

    // 世界生命周期：打开（异步）→ 关闭（同步，且幂等）
    ctx.effect(() => {
      const generation = ++this.generation
      this.opening = this.open(dir, config, generation).catch((error: unknown) => {
        // 打不开就**如实报错**并停在这一状态：不假装在跑（那是"她明明在却什么都没发生"的根源）
        this.ctx.logger.error(`[yanxin-world] 世界装载失败（${dir}）：${describe(error)}`)
      })
      return async () => {
        ++this.generation
        // 先等在飞的那次 open 落定（它会看见代数不匹配、自己收摊），再收会话句柄。
        // 顺序反了或干脆不 await，cordis 就以为作用域拆完了，下一次装载撞上 store 里
        // 还没摘掉的同 id 条目 —— `session "…" already exists`，那一拍静默丢掉。
        await this.opening?.catch(() => undefined)
        this.opening = undefined
        await this.lifeDispose?.().catch((error: unknown) => {
          this.ctx.logger.warn(`[yanxin-world] 她的会话收尾失败：${describe(error)}`)
        })
        this.lifeDispose = undefined
        this.world?.stop()
        this.world = undefined
      }
    }, 'yanxin-world.lifecycle')

    // 报活 + 补发心跳。裸 setInterval 必须经 ctx.effect 绑生命周期 ——
    // 少了这层，插件卸载后 interval 还在跑（T19 专门证伪这个形态的泄漏）。
    ctx.effect(() => {
      const timer = setInterval(() => {
        void this.tick()
      }, tickMs)
      return () => clearInterval(timer)
    }, 'yanxin-world.tick')

    // 入站观察：OneBot 帧到达时记数（也是"群聊流进她的手机"的入口 —— 手机见 `phone.ts`）
    ctx.effect(
      () =>
        this.ctx.on('onebot/event', (frame) => {
          this.inboundCount += 1
          const selfId = this.accountOf()
          if (!this.phone.remember(frame, selfId, Date.now())) return
          // 群里来消息 = 把她从"干等"里叫醒（T27b-6）：不然她会一直等到 expectedEnd，
          // 那时话题早过去了。只打断 wait/rest（正在做的事不打断），且**不叫模型**
          // （机械结算，省一次调用 —— 设等待下限就是为了省额度）。
          if (isGroupMessage(frame)) {
            void this.world?.loop.interruptWaiting('群里来了消息').catch(() => undefined)
          }
        }),
      'yanxin-world.inbound',
    )

    this.ctx.logger.info(`[yanxin-world] 引擎装载：世界目录 ${dir}，报活心跳每 ${tickMs}ms`)
  }

  /** 心跳计数（只增不减，随实例销毁归零）。 */
  get ticks(): number {
    return this.seq
  }

  /** 收到的 OneBot 事件数（窗口外引擎被卸下时不再累计）。 */
  get inbound(): number {
    return this.inboundCount
  }

  /** 世界打开好了没有（控制台/测试用）。 */
  get ready(): boolean {
    return this.world !== undefined
  }

  /** 当前世界快照（还没打开完时报错 —— 不返回空快照掩盖）。 */
  get snapshot(): OpenWorld['kernel']['snapshot'] {
    return this.require().kernel.snapshot
  }

  /**
   * 控制台用的**只读状态**（T33）。
   *
   * 与 `snapshot` 的区别：世界还没打开好时**不抛错**，而是如实答 `ready: false` ——
   * 页面的职责是"显示现在是什么状态"，不是把异常抛到浏览器里。
   */
  status(): WorldStatus {
    const world = this.world
    const groupId = this.effectiveGroupId({ worldGroupId: this.configGroupId })
    if (world === undefined) {
      return { ready: false, tu: null, era: null, sequence: null, entities: null, actions: null, ticks: this.seq, inbound: this.inboundCount, groupId }
    }
    const snapshot = world.kernel.snapshot
    return {
      ready: true,
      tu: world.clock.now(),
      era: world.clock.genesisMs,
      sequence: snapshot.sequence,
      entities: Object.keys(snapshot.entities).length,
      actions: Object.keys(snapshot.actions).length,
      ticks: this.seq,
      inbound: this.inboundCount,
      groupId,
    }
  }

  // ── 世界工具的门面（T26 的四个动词）─────────────────────────────────────

  /** 她在哪儿、那儿能感知到什么（T24a 的投影）。 */
  look(options: { focus?: 'around' | 'phone' } = {}): Observation {
    return this.require().facade.look(options)
  }

  /** 她伸手登记一个意图（`world_act` / `world_wait` / `world_rest` / `world_say`）。 */
  submit(intent: Intent): Promise<{ accepted: boolean; detail?: string }> {
    return this.require().facade.submit(intent)
  }

  /** 写一篇笔记（`notes/*.md`：一篇一个文件、文件名即标题、人机共用）。 */
  writeNote(title: string, body: string): Promise<{ path: string }> {
    return this.require().facade.writeNote(title, body)
  }

  /** 翻本子（标题，最近写的在前）。 */
  listNotes(): Promise<string[]> {
    return this.require().facade.listNotes()
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private require(): OpenWorld {
    const world = this.world
    if (world === undefined) {
      throw new Error('世界还没装载完（或已被窗口关闭）—— 她此刻不在自己的世界里')
    }
    return world
  }

  /** 打开世界（读盘 + 接线）。代数不匹配（被关或被新一轮装载顶掉）时自己收摊。 */
  private async open(dir: string, config: EngineConfig, generation: number): Promise<void> {
    const selfId = config.selfId ?? ENGINE_DEFAULTS.selfId
    const world = await openWorld({
      dir,
      selfId,
      callModel: this.callModel(),
      decide: this.lifeDecide(config),
      deliver: (item) => this.deliver(config, item),
      phoneMessages: () => this.phoneMessages(),
      ...(config.tingleEveryUnits === undefined ? {} : { tingleEveryUnits: config.tingleEveryUnits }),
      warn: (message) => this.ctx.logger.warn(message),
    })

    if (generation !== this.generation) {
      // 打开期间被关了、或被新一轮装载顶了：**自己收摊**，别留一个没人管的循环在转。
      // 这里的 await 与 effect 收尾同理 —— 不收完就返回，下一次打开会撞 store。
      world.stop()
      await this.lifeDispose?.().catch((error: unknown) => {
        this.ctx.logger.warn(`[yanxin-world] 她的会话收尾失败：${describe(error)}`)
      })
      this.lifeDispose = undefined
      this.ctx.logger.warn('[yanxin-world] 打开完成时本次装载已作废 —— 丢弃这次打开')
      return
    }
    this.world = world
    this.ctx.logger.info(
      `[yanxin-world] 世界已打开：${Object.keys(world.kernel.snapshot.entities).length} 个实体、` +
        `${world.kernel.transactionCount} 条事务、T=${world.clock.now()}`,
    )
  }

  /** 报活 + 补发：已提交但还没出门的发言在这里落地（`emit` 按回执去重，重复调用无害）。 */
  private async tick(): Promise<void> {
    this.seq += 1
    this.ctx.emit('yanxin/world-tick', this.seq)

    const world = this.world
    if (world === undefined) return
    try {
      await world.loop.emit()
    } catch (error) {
      this.ctx.logger.warn(`[yanxin-world] 补发失败（下拍重试）：${describe(error)}`)
    }
  }

  /**
   * 她"怎么想"：驱动她自己的 agent 会话（T27b-3）。
   *
   * 会话 id 是 `world:<她的QQ号>` —— **与群聊同一个命名空间**：群聊里的小研与过日子的
   * 小研是同一个 session、同一份人格、同一套记忆（spec §6.5）。
   *
   * 她的 QQ 号从哪来：行 config 显式给（部署时最清楚），否则取 onebot 账号注册表的第一个
   * ——注册表是"这个实例服务哪些账号"的权威（profile patch 里配的）。两处都没有时
   * 由 `createLifeDecide` 自己告警并空转（世界照常转，只是她不会主动想起什么）。
   */
  private lifeDecide(config: EngineConfig): Decide {
    const onebot = this.ctx.get('onebot') as { accounts?: readonly { selfId: string }[] } | undefined
    const account = config.account ?? onebot?.accounts?.[0]?.selfId
    if (account === undefined) {
      this.ctx.logger.warn('[yanxin-world] 不知道她是哪个 QQ 号（engine 行的 account，或 onebot 的 accounts）—— 她不会主动过日子')
      this.lifeDispose = undefined
      return async () => null
    }

    const life = createLifeDecide({
      ctx: this.ctx,
      account,
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      clock: () => this.world?.clock,
      warn: (message) => this.ctx.logger.warn(message),
    })
    this.lifeDispose = life.dispose
    return life.decide
  }

  /**
   * 世界模型（裁定 + 创世）：从 `ctx.worldModel` 软查。
   *
   * 缺席时给一个**明确失败**的实现：装载期不拦（世界照样能打开、能重放、能结算已有的
   * 待办），但真到要裁定那一刻会报清楚"模型没接线"——比"静默什么都不发生"好查得多。
   */
  private callModel(): Parameters<typeof openWorld>[0]['callModel'] {
    const service = this.ctx.get('worldModel') as { call?: Parameters<typeof openWorld>[0]['callModel'] } | undefined
    if (service?.call !== undefined) return service.call

    return async () => {
      throw new Error('世界模型没接线：装配里要有 `world-model` 行（yanxin/src/world/model.ts，inject llm）')
    }
  }

  /**
   * 当前生效的世界群号：**settings → 行 config → 内置缺省**。
   * settings 段由 console 服务注册（见 `WORLD_SETTINGS_NS` 的说明），这里只读：
   * `get(ns)` 对未注册命名空间返回 undefined，装载顺序无关紧要。
   */
  private effectiveGroupId(config: { worldGroupId?: string } | undefined): string {
    const settings = this.ctx.get('settings') as { get(ns: string): unknown } | undefined
    const section = settings?.get(WORLD_SETTINGS_NS) as { worldGroupId?: string } | undefined
    return section?.worldGroupId ?? config?.worldGroupId ?? ENGINE_DEFAULTS.worldGroupId
  }

  /** 发射通道：她的话 → 她的世界群。没配群号时**如实失败**（回执记 failed，不重试）。 */
  private async deliver(config: EngineConfig, item: OutboxItem): Promise<void> {
    const groupId = this.effectiveGroupId(config)
    if (groupId === '') {
      throw new Error('没配她的世界群（settings 的 yanxin-world，或 engine 行的 worldGroupId）—— 这句话发不出去')
    }

    const target = buildReply({ kind: 'group', groupId }, item.text)
    const onebot = this.ctx.get('onebot') as
      | { call: (selfId: string, action: string, params: unknown) => Promise<unknown> }
      | undefined
    if (onebot === undefined) throw new Error('OneBot 服务不在，发不出去')

    // ⚠️ 这里要的是**她的 QQ 号**（OneBot 连接的身份），**不是**世界实体 id（`yanxin`）。
    // 2026-09-27 夜间实测踩到：传了世界实体 id，于是每一句都
    // "selfId=yanxin 没有可用的 API 连接" —— 而且它按纪律**记回执、不重试**，
    // 表现为"她很会说话，但群里一句都没收到"（配上 worldGroupId 也一样发不出去）。
    const account = this.accountOf()
    if (account === '') {
      throw new Error('不知道她是哪个 QQ 号（engine 行的 account，或 onebot 的 accounts）—— 这句话发不出去')
    }

    await onebot.call(account, target.action, target.params)
    this.ctx.logger.info(`[yanxin-world] 她说了：${item.text}`)
  }

  /**
   * 手机里的消息（T27b-5 接上）：她自己账号收到的群聊/私聊，去重后留在 `PhoneBuffer` 里。
   *
   * 换算成世界时刻要用 T=0 锚点，所以拿不到 `world.clock` 时返回空（那通常意味着
   * 世界还没打开 —— 而那时这一行本来就被卸下了，这块只是兜底）。
   */
  private phoneMessages(): readonly PhoneMessage[] {
    return this.phone.toPhoneMessages(this.world?.clock)
  }

  /**
   * 她是哪个 QQ 号（手机与发射都要靠它"她自己发的"回声）。
   *
   * 缺省从 onebot 的账号注册表软查（与 `lifeDecide` 同一口径：注册表是"这个实例服务哪些账号"
   * 的权威）。查不到就空串 —— 那时**不滤**（宁可多看她自己的回声，也不要因为算不出账号
   * 而把整个群聊挡在手机外面）。
   */
  private accountOf(): string {
    if (this.phoneAccount === undefined) {
      const onebot = this.ctx.get('onebot') as { accounts?: readonly { selfId: string }[] } | undefined
      this.phoneAccount = this.configAccount ?? onebot?.accounts?.[0]?.selfId ?? ''
    }
    return this.phoneAccount
  }
}

/** 坏值兜底：非数字 / NaN / 非正 → 默认。 */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

