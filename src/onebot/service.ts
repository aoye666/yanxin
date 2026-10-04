/**
 * OneBot 适配：反向 WebSocket **服务端** + 账号注册表。
 *
 * ## 这个服务的职责边界
 *
 * 它只做**传输**——握手、鉴权、账号路由、帧收发、存活检测、API 调用关联。
 * **它不知道 agent、preset、session 是什么**。把"收到的消息变成一次 agent 对话"是
 * `./bridge.ts`（T11）的事。这样切的好处是：传输层可以独立测试（配一个假的 OneBot 端），
 * 而路由逻辑也能独立测试（喂假事件）。
 *
 * ## 方向（见 protocol.ts 的表格）
 *
 * NapCat 作为客户端连我们；**我们向它发 API 调用**（发送消息等），它回响应并推事件。
 *
 * ## 存活检测（不能靠心跳）
 *
 * 规范：`heartbeat.enable` **默认 false**。所以**不能依赖 OneBot 的心跳**做存活检测，
 * 必须用 WebSocket 协议层自己的 ping/pong（`ws.ping()` / `'pong'` 事件）。
 *
 * ## 连接数不是 1
 *
 * 规范：API 客户端与 Event 客户端可以连**同一个 URL 但是两条连接**（除非配了
 * `use_universal_client`）。所以**一个 QQ 号可能对应 1～2 条连接**，注册表必须按键
 * `(selfId, role)` 存，不能假设一个 QQ 一条。
 *
 * ⚠️ 装配纪律：只用 `export default` 导出这一个类（ADR 0004）；
 *    实例字段用 TS `private` 而非 `#`（ADR 0007：追踪 Proxy 会替换 receiver）。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { WebSocket, WebSocketServer } from 'ws'
import { normalizeMessage } from './message.ts'
import { tokenEquals } from '../console/logic.ts'
import {
  ONEBOT_SETTINGS_NS,
  resolveTransport,
  sameListenPoint,
  TransportSchema,
  type Transport,
  type TransportOverride,
} from './transport.ts'
import {
  buildApiFrame,
  classifyFrame,
  parseHandshake,
  pathnameOf,
  type ClientRole,
  type EventFrame,
} from './protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    onebot: OneBotService
  }
  interface Events {
    /** 一条连接握手成功（NapCat 侧每次(重)连都会产生）。 */
    'onebot/connected'(selfId: string, role: ClientRole): void
    /** 一条连接关闭。 */
    'onebot/disconnected'(selfId: string, role: ClientRole, reason: string): void
    /** 收到一个事件帧（已通过双向身份校验）。 */
    'onebot/event'(frame: EventFrame): void
  }
}

/** 一个账号的路由配置：这个 selfId 的消息该用哪个 preset / 模型。 */
export interface AccountConfig {
  selfId: string
  /** preset id（如 `xiaoyan-agent`）。路由由 bridge 使用。 */
  preset: string
  /** 模型（可选；缺省时用会话默认）。 */
  model?: string
}

interface PendingCall {
  resolve: (value: { status: string; retcode: number; data: unknown }) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface Connection {
  selfId: string
  role: ClientRole
  ws: WebSocket
  pending: Map<string, PendingCall>
  /** WebSocket 层 pong 是否收到（我们自己实现的存活检测）。 */
  alive: boolean
}

/** 抛出这个错误表示"连接没了/调用超时"，调用方据此决定是否重试或降级。 */
export class OneBotCallError extends Error {
  readonly kind: 'no-connection' | 'timeout' | 'closed' | 'api-failed'
  readonly retcode?: number

  constructor(
    message: string,
    kind: 'no-connection' | 'timeout' | 'closed' | 'api-failed',
    retcode?: number,
  ) {
    super(message)
    this.kind = kind
    this.retcode = retcode
    this.name = 'OneBotCallError'
  }
}

const ConfigSchema = z.object({
  host: z.string().default('127.0.0.1').description('监听地址。默认只绑回环。'),
  port: z.natural().required().description('监听端口，供 OneBot 实现反向连接。'),
  path: z
    .string()
    .description('只接受这个路径的升级请求（如 /onebot/v11）。留空则接受任意路径。'),
  token: z
    .string()
    .description('与 OneBot 侧的 access token 对应。留空则不校验。'),
  accounts: z
    .array(
      z.object({
        selfId: z.string().required(),
        preset: z.string().required(),
        model: z.string(),
      }),
    )
    .default([])
    .description('账号注册表：selfId → 该账号用哪个 preset。未注册的 selfId 的连接会被拒绝。'),
  pingIntervalMs: z
    .natural()
    .default(30_000)
    .description('WebSocket 层 ping 间隔。规范里心跳默认关闭，所以存活检测由我们自己做。'),
  callTimeoutMs: z.natural().default(15_000).description('API 调用的响应超时。'),
})

interface Config {
  host: string
  port: number
  path?: string
  token?: string
  accounts: AccountConfig[]
  pingIntervalMs: number
  callTimeoutMs: number
}

export default class OneBotService extends Service {
  /**
   * 需要 `settings`：传输层参数（host / port / path / token / 超时）可以在运行期被
   * `yanxin-onebot` 命名空间覆盖，控制台改完不用重启实例（`./transport.ts`）。
   *
   * ⚠️ 特别地，**不要写 `inject: ['logger']`** —— `ctx.logger` 是 `Context` 自带的字段
   * （构造函数里直接 `new LoggerService(self)`），并不是通过 `provide` 注册的服务。
   * 把它写进 inject 会让 fiber 永远等一个不存在的依赖而**不激活**。
   */
  static readonly inject = ['settings']

  /**
   * 行 config 的 schema —— **它是部署基线，不是唯一来源**。
   *
   * ⚠️ `port` 是 required：装配期就没有任何端口可听，比"运行期改坏了"更糟，
   *    所以这一条宁可在启动时炸，也不要静默兜到默认端口（那会让别人的 8080 意外对上她）。
   *
   * ⚠️ **必须显式标注 `z<Config>`**。不标注的话，`tsc` 在产出 `.d.ts` 时会报
   * TS2742："The inferred type of 'Config' cannot be named without a reference to
   * '@deepseek-ai/cosmokit'… A type annotation is necessary."
   * —— 推断出的类型引用了 cosmokit 的内部路径，对 `.d.ts` 不可移植。
   * （typecheck 用 `noEmit` 抓不到这个错，只有 `pnpm build` 会暴露。DSH 自己的
   *   `ConsoleExporter` 也是这么标注的。）
   */
  static readonly Config: z<Config> = ConfigSchema

  private readonly scope: SettingsScope<TransportOverride>

  private readonly connections = new Map<string, Connection>()

  /**
   * 当前在听的 HTTP 服务。⚠️ **不是 readonly**：换监听地址/端口要整体换掉它
   * （一个 `Server` 实例只能绑一次），而 `wss` 是 `noServer` 模式，与它解耦，可以复用。
   */
  private server: Server

  /** 真实绑上的监听点。端口传 0 时记的是系统分配到的那个 —— **只用于显示**。 */
  private bound: { host: string; port: number } = { host: '', port: -1 }

  /**
   * **请求的**监听点（settings / 行 config 里写的那两个值）。
   *
   * 判断"要不要换绑"必须拿它比，而不是拿 `bound` 比：端口写 0 = 让系统分配，
   * 于是 `bound.port` 是个真实端口号（如 54321），而请求值永远是 0 ——
   * 用 `bound` 比就会**每次保存都白白换绑一次**，而每次换绑又分配一个新端口，
   * 页面上就成了"我明明没改，端口怎么一直在变"。
   */
  private requested: { host: string; port: number } = { host: '', port: -1 }

  private readonly wss: WebSocketServer
  private echoSeq = 0
  private closed = false

  /** 存活检测的定时器。间隔可被 settings 改，所以每次重挂都要能撤掉旧的。 */
  private pingTimer: NodeJS.Timeout | undefined

  /** 当前生效的 ping 间隔（用来判断"要不要重挂定时器"）。 */
  private pingInterval = -1

  /** 监听就绪。`port` 传 0 时由系统分配，测试与控制台都靠它拿到真实端口。 */
  readonly ready: Promise<void>

  private readonly config: Config

  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, 'onebot')
    this.config = config

    this.scope = ctx.settings.register(ONEBOT_SETTINGS_NS, TransportSchema)
    this.wss = new WebSocketServer({ noServer: true, clientTracking: false })
    this.server = this.makeServer()

    const initial = this.transport
    this.requested = { host: initial.host, port: initial.port }
    this.bound = { host: initial.host, port: initial.port }

    // `error` 也要接进 ready：EADDRINUSE 时 server 只发 error 事件 —— 不接的话，
    // `await ready` 永远悬挂（宿主若吞了 uncaughtException 就查无此错），且未监听的
    // 'error' 会把进程带崩、栈不指向端口冲突。
    this.ready = new Promise<void>((resolve, reject) => {
      this.server.once('listening', () => {
        // 端口传 0 时系统会分配一个 —— bound 必须记**真实**的那个，
        // 否则控制台下一改动就会被判成"监听点变了"而白白重听一次。
        this.bound = this.actualListenPoint()
        resolve()
      })
      this.server.once('error', (error) => reject(error))
    })

    this.armPing(initial.pingIntervalMs)

    // 监听是 effect：插件卸载时关掉监听并断开所有连接（spec §6 的副作用纪律）
    ctx.effect(() => {
      this.server.listen(initial.port, initial.host)
      this.log(
        'info',
        `OneBot 反向 WS 监听 ${initial.host}:${initial.port}（账号 ${this.config.accounts.length} 个；` +
          `端口 0 = 系统分配，就绪后以实际值为准）`,
      )
      return () => this.shutdown()
    }, 'yanxin-onebot.listen')

    // settings 一改就重听。观察者绑在 fiber 上，卸载时自动解除（§7.3 反例那条纪律）。
    ctx.effect(
      () =>
        this.scope.watch(() => {
          void this.reconcile()
        }),
      'yanxin-onebot.watch',
    )
  }

  /** 现在生效的传输参数：**settings → 行 config → {@link TRANSPORT_DEFAULTS}**，每次现读。 */
  get transport(): Transport {
    return resolveTransport(this.scope.get(), this.config)
  }

  /**
   * 写传输层参数（**控制台的唯一入口**）。
   *
   * 本方法**不做校验** —— 校验在 `src/console/pages/onebot.ts` 那边（它要给用户看得懂的
   * 拒绝理由）。这里只负责落 settings：写成功后 `scope.watch` 会触发 `reconcile()`，
   * 监听点变了就换绑，没变就等于改了几个运行期读取的字段（token / path / 超时）。
   *
   * ⚠️ 不记 token 的值：日志与审计里只留"改了什么类别"，值一律不落盘（§7.4-D）。
   */
  async updateTransport(patch: TransportOverride): Promise<void> {
    await this.scope.update(patch)
    // 不等就不确定：调用方（控制台）回"已改好"的时候可能还没换绑完，
    // 而运维下一步就是去 NapCat 填新端口 —— 差一拍就是"连不上且看不出原因"。
    // `watch` 那条路仍然留着：手改 `settings.yaml` 的人没人替他 await。
    await this.reconcile()
    const keys = Object.keys(patch)
    this.log(
      'info',
      `传输参数已更新（${keys.join(' / ')}），现在生效的是 ${this.bound.host}:${this.bound.port}`,
    )
  }

  /** 新建一个只用于 WS 升级的 HTTP 服务（普通请求回 426）。 */
  private makeServer(): Server {
    const server = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8', upgrade: 'websocket' })
      res.end('研心 OneBot 适配：此端口只接受 WebSocket 升级请求。\n')
    })
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
    // 常驻的 error 兜底：绑上之后还会出错（对端 RST 之类），没人接就会把进程带崩。
    server.on('error', (error: unknown) => {
      this.log('warn', `HTTP 服务出错：${error instanceof Error ? error.message : String(error)}`)
    })
    return server
  }

  /** 把 `server` 绑到 `t.host:t.port`；失败即 reject（调用方决定怎么办）。 */
  private listenOn(server: Server, t: Transport): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.once('listening', () => {
        server.removeListener('error', onError)
        // 报**真实**的监听点：端口 0 要给出分配到的那个，主机名也按内核实际绑上的写
        const addr = server.address()
        if (addr && typeof addr === 'object') resolve({ host: addr.address, port: addr.port })
        else resolve({ host: t.host, port: t.port })
      })
      server.listen(t.port, t.host)
    })
  }

  /**
   * 让当前生效的 settings 与真实状态对齐：**监听点变了就换，ping 间隔变了就重挂**。
   *
   * 顺序是刻意的：**先在新地址上听成功，再关旧的**。反过来做的话，端口被占用 /
   * 地址拼错 / 权限不够时我们会**既丢了旧监听又起不来新的** —— 她直接失联，
   * 而这恰恰是最需要"还能改回来"的时刻。
   */
  private async reconcile(): Promise<void> {
    if (this.closed) return
    const next = this.transport

    this.armPing(next.pingIntervalMs)

    // 比的是**请求值**（见 `requested` 的注释）：端口写 0 时真实端口一直在变，
    // 拿 bound 比会把"什么都没改的一次保存"判成换绑。
    if (sameListenPoint(this.requested, next)) return

    const previous = this.server
    const from = `${this.bound.host}:${this.bound.port}`
    const candidate = this.makeServer()
    try {
      const bound = await this.listenOn(candidate, next)
      this.server = candidate
      this.requested = { host: next.host, port: next.port }
      this.bound = bound
      previous.close() // close = 不再接受新连接；已经 upgrade 完的 socket 不受影响
      this.log('info', `OneBot 监听已从 ${from} 改到 ${bound.host}:${bound.port}（旧连接保持，只拒新连）`)
    } catch (error) {
      candidate.close()
      this.log(
        'warn',
        `改监听失败，**保持原来的 ${from} 在听**：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 真实绑上的监听点（端口传 0 时这里是系统分配到的值）。 */
  private actualListenPoint(): { host: string; port: number } {
    const addr = this.server.address()
    const t = this.transport
    if (addr && typeof addr === 'object') return { host: addr.address, port: addr.port }
    return { host: t.host, port: t.port }
  }

  /** 重挂存活检测（间隔没变就什么都不做）。 */
  private armPing(intervalMs: number): void {
    if (this.pingTimer !== undefined && this.pingInterval === intervalMs) return
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer)
    this.pingInterval = intervalMs
    // 0 会被 setInterval 当成 1 —— 那是"每毫秒 ping 一遍"，不是"关掉"。给一个下限。
    this.pingTimer = setInterval(() => this.pingAll(), Math.max(1000, intervalMs))
  }

  /** 真实绑上的监听点（控制台显示"现在在听哪儿"用；端口 0 时是系统分配的那个）。 */
  get listenPoint(): { host: string; port: number } {
    return this.bound
  }

  /** 实际监听端口。配置传 0 时由系统分配 —— 先 `await ready` 再读。 */
  get port(): number {
    const addr = this.server.address()
    if (addr && typeof addr === 'object') return addr.port
    return this.transport.port
  }

  // ── 对外的只读视图与查询 ────────────────────────────────────────────

  /** 已注册的账号列表。 */
  get accounts(): readonly AccountConfig[] {
    return this.config.accounts
  }

  /** 按 selfId 查账号配置。 */
  account(selfId: unknown): AccountConfig | undefined {
    const id = typeof selfId === 'string' ? selfId : typeof selfId === 'number' ? String(selfId) : ''
    if (!id) return undefined
    return this.config.accounts.find((a) => a.selfId === id)
  }

  /** 某个 selfId 当前有连接的角色的快照（测试与控制台用）。 */
  connectionsOf(selfId: string): ClientRole[] {
    const roles: ClientRole[] = []
    for (const [key, conn] of this.connections) {
      if (key.startsWith(`${selfId}:`)) roles.push(conn.role)
    }
    return roles.sort()
  }

  /** 是否具备发 API 调用的能力（需要 API 或 Universal 角色的连接）。 */
  canCall(selfId: string): boolean {
    return this.connectionsOf(selfId).some((r) => r === 'API' || r === 'Universal')
  }

  // ── 握手与升级 ──────────────────────────────────────────────────────

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? ''
    // ⚠️ 每次握手**现读**一遍：控制台刚改过 token / path，下一条重连就该按新值判。
    //    缓存到字段上等于"改了要重启才生效"，而 token 泄漏时"立刻换掉"正是这个功能的意义。
    const t = this.transport

    // 路径校验：配了 path 才校验（默认接受任意路径）
    if (t.path) {
      const actual = pathnameOf(url)
      if (actual !== t.path) {
        this.log('warn', `拒绝握手：路径 ${actual} 与配置的 ${t.path} 不符`)
        return rejectUpgrade(socket, 404, `路径不符：${actual}`)
      }
    }

    // 同时传 url：Authorization 头缺失时从 query 的 access_token 兜底
    const handshake = parseHandshake((name) => req.headers[name], url)

    if (!handshake.ok) {
      this.log('warn', `拒绝握手：${handshake.reason}`)
      return rejectUpgrade(socket, 400, handshake.reason)
    }

    // 鉴权：仅当配置了 token 才校验（规范：OneBot 侧没配 token 时不发 Authorization 头）。
    // 用 timingSafeEqual（与控制台同一实现）—— 本机反连的时序侧信道面很小，但两处口径
    // 该一致：一边是定时安全比较、一边是 `!==`，读代码的人会以为它们有语义差别
    if (t.token && !tokenEquals(handshake.token ?? '', t.token)) {
      this.log('warn', `拒绝握手：selfId=${handshake.selfId} 的 access token 不匹配`)
      return rejectUpgrade(socket, 401, 'access token 不匹配')
    }

    // 账号注册表：未注册的 selfId 一律拒绝
    if (!this.account(handshake.selfId)) {
      this.log('warn', `拒绝握手：未注册的 selfId=${handshake.selfId}`)
      return rejectUpgrade(socket, 403, `未注册的 selfId：${handshake.selfId}`)
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, handshake.selfId, handshake.role)
    })
  }

  private onConnection(ws: WebSocket, selfId: string, role: ClientRole): void {
    const key = `${selfId}:${role}`

    // 同一 (selfId, role) 重连时替换旧连接：NapCat 会不断重连，我们不能叠加
    const previous = this.connections.get(key)
    if (previous) {
      this.log('info', `${key} 重连，替换旧连接`)
      this.dropConnection(key, previous, 'replaced-by-reconnect')
      try {
        previous.ws.terminate()
      } catch {
        /* 旧连接可能已经死了 */
      }
    }

    const conn: Connection = { selfId, role, ws, pending: new Map(), alive: true }
    this.connections.set(key, conn)

    ws.on('message', (data) => this.onMessage(conn, data))
    ws.on('pong', () => {
      conn.alive = true
    })
    ws.on('close', () => {
      this.dropConnection(key, conn, 'socket-closed')
    })
    ws.on('error', (error) => {
      this.log('warn', `${key} socket 错误：${error.message}`)
    })

    this.log('info', `${key} 已连接`)
    this.ctx.emit('onebot/connected', selfId, role)
  }

  // ── 入站帧 ──────────────────────────────────────────────────────────

  private onMessage(conn: Connection, data: unknown): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(data))
    } catch {
      this.log('warn', `${conn.selfId}:${conn.role} 收到非 JSON 帧，丢弃`)
      return
    }

    const frame = classifyFrame(parsed)

    if (frame.kind === 'api-response') {
      if (!frame.echo) {
        this.log('warn', `${conn.selfId}:${conn.role} 收到无 echo 的 API 响应，无法关联，丢弃`)
        return
      }
      const pending = conn.pending.get(frame.echo)
      if (!pending) {
        this.log('warn', `${conn.selfId}:${conn.role} 收到未知 echo=${frame.echo} 的响应，丢弃`)
        return
      }
      conn.pending.delete(frame.echo)
      clearTimeout(pending.timer)
      pending.resolve({ status: frame.status, retcode: frame.retcode, data: frame.data })
      return
    }

    if (frame.kind === 'event') {
      // ⚠️ 双向身份校验（T9）：事件自带的 self_id 必须与握手头一致，
      // 否则是串号（一条连接冒充另一个账号）或实现侧有 bug —— 两种情况都不能放行。
      if (frame.selfId && frame.selfId !== conn.selfId) {
        this.log(
          'warn',
          `⚠️ 串号：连接声明 selfId=${conn.selfId}，但事件自带 self_id=${frame.selfId}，已丢弃该事件`,
        )
        return
      }

      // 链路可观测性：消息事件记一行，便于运维肉眼确认"事件真的在流"。
      // T11 的 bridge 接手真正的处理逻辑后，这行仍保留（它是最早的审计痕迹）。
      if (frame.postType === 'message') {
        this.log('info', `← ${describeMessageEvent(frame)}`)
      }

      this.ctx.emit('onebot/event', frame)
      return
    }

    this.log('warn', `${conn.selfId}:${conn.role} 无法分类的帧：${frame.reason}`)
  }

  // ── 出站：API 调用 ──────────────────────────────────────────────────

  /**
   * 向某个账号发一次 API 调用并等响应。
   *
   * 关联靠我们自己生成的 `echo` —— 规范未定义 echo 的唯一性或响应顺序，
   * 所以**不假设任何顺序**，只按 echo 匹配。
   */
  async call<T = unknown>(
    selfId: string,
    action: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const conn = this.apiConnectionOf(selfId)
    if (!conn) {
      throw new OneBotCallError(`selfId=${selfId} 没有可用的 API 连接`, 'no-connection')
    }

    const echo = `yx-${++this.echoSeq}`
    const timeoutMs = options.timeoutMs ?? this.transport.callTimeoutMs

    const response = await new Promise<{ status: string; retcode: number; data: unknown }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          conn.pending.delete(echo)
          reject(new OneBotCallError(`API 调用 ${action} 超时（${timeoutMs}ms）`, 'timeout'))
        }, timeoutMs)

        conn.pending.set(echo, { resolve, reject, timer })

        try {
          conn.ws.send(JSON.stringify(buildApiFrame(action, params, echo)))
        } catch (error) {
          conn.pending.delete(echo)
          clearTimeout(timer)
          reject(new OneBotCallError(`发送 ${action} 失败：${String(error)}`, 'closed'))
        }
      },
    )

    if (response.status !== 'ok') {
      throw new OneBotCallError(
        `API ${action} 返回 status=${response.status} retcode=${response.retcode}`,
        'api-failed',
        response.retcode,
      )
    }
    return response.data as T
  }

  private apiConnectionOf(selfId: string): Connection | undefined {
    for (const role of ['Universal', 'API'] as const) {
      const conn = this.connections.get(`${selfId}:${role}`)
      if (conn && conn.ws.readyState === WebSocket.OPEN) return conn
    }
    return undefined
  }

  // ── 存活检测 ────────────────────────────────────────────────────────

  private pingAll(): void {
    for (const [key, conn] of this.connections) {
      if (!conn.alive) {
        this.log('warn', `${key} 未响应 ping，判定为死连接`)
        this.dropConnection(key, conn, 'ping-timeout')
        try {
          conn.ws.terminate()
        } catch {
          /* 已经死了 */
        }
        continue
      }
      conn.alive = false
      try {
        conn.ws.ping()
      } catch {
        /* 下一轮会判定为死连接 */
      }
    }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  /** 从注册表摘掉一条连接，并把它的未决调用全部失败掉（不留悬挂的 promise）。 */
  private dropConnection(key: string, conn: Connection, reason: string): void {
    if (this.connections.get(key) !== conn) return
    this.connections.delete(key)

    for (const [echo, pending] of conn.pending) {
      clearTimeout(pending.timer)
      pending.reject(new OneBotCallError(`连接在等待响应时关闭（echo=${echo}）`, 'closed'))
    }
    conn.pending.clear()

    this.log('info', `${key} 已断开（${reason}）`)
    this.ctx.emit('onebot/disconnected', conn.selfId, conn.role, reason)
  }

  private shutdown(): void {
    if (this.closed) return
    this.closed = true

    if (this.pingTimer !== undefined) clearInterval(this.pingTimer)
    this.pingTimer = undefined

    for (const [key, conn] of [...this.connections]) {
      this.dropConnection(key, conn, 'service-disposing')
      try {
        conn.ws.close(1001, 'service disposing')
      } catch {
        /* 忽略 */
      }
    }

    this.wss.close()
    this.server.close()
    this.log('info', 'OneBot 适配已停止')
  }

  private log(level: 'info' | 'warn', message: string): void {
    // `LoggerService extends Record<LoggerType, LoggerMethod>`，所以可以直接按级别调用。
    // 不写 `?.` —— ctx.logger 由 Context 构造函数保证存在。
    this.ctx.logger[level](`[yanxin-onebot] ${message}`)
  }
}

/** 拒绝一次升级：回一个 HTTP 状态行再断开。规范未定义反向 WS 的失败语义，这里取惯例。 */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const text = `${status} ${message}`
  try {
    socket.write(
      `HTTP/1.1 ${text}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}`,
    )
  } catch {
    /* 对端可能已断开 */
  }
  socket.destroy()
}

/** 给消息事件做一行可读摘要（链路可观测性）。 */
function describeMessageEvent(frame: EventFrame): string {
  const raw = frame.raw
  const messageType = typeof raw.message_type === 'string' ? raw.message_type : '?'
  const userId = raw.user_id === undefined ? '?' : String(raw.user_id)
  const groupId = raw.group_id === undefined ? undefined : String(raw.group_id)

  const normalized = normalizeMessage(raw.message, raw.raw_message)
  const preview = normalized.text.length > 60 ? `${normalized.text.slice(0, 60)}…` : normalized.text

  const where = groupId ? `群 ${groupId}` : '私聊'
  const at = normalized.atAll
    ? ' at=全体'
    : normalized.at.length > 0
      ? ` at=${normalized.at.join(',')}`
      : ''
  return `${messageType} ${where} 来自 ${userId}${at}：${JSON.stringify(preview)}`
}
