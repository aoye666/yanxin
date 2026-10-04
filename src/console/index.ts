/**
 * 控制台（`ctx.console`）—— `/yanxin` 的路由与三道门（T31，spec §6.12）。
 *
 * ## 一条路由，多个页
 *
 * 只用 `ctx.webServer.register` 注册**一条** `prefix /yanxin` 路由，其余都是内部分发：
 *
 * ```
 * GET  /yanxin              → 外壳（内联了客户端脚本的静态 HTML，见 client.ts）
 * GET  /yanxin/api/page...  → 页的内容（JSON，见 api.ts）
 * GET  /yanxin/api/<route>  → 只读接口
 * POST /yanxin/api/<route>  → 写接口（**必须带 token**）
 * ```
 *
 * 为什么不分多条路由：`(kind, path)` 是**身份**，重复注册直接 throw（T15 实测），
 * 而"页"是会随插件装卸的东西 —— 让每个页各注册一条路由，冲突面等于页的数量。
 * 集中一条，页在**自己的 fiber** 里登记、卸载时自动摘掉（`registry.ts` 里做了这件事）。
 *
 * ## 三道门（都能被测试证伪）
 *
 * 1. **在哪儿敲门**：默认非回环一律 403（webServer 的 host 配置是另一道门，但那个我们看不到
 *    —— 自己再守一道）。Docker 形态要公网可达，所以有**默认关**的显式放行
 *    `YANXIN_CONSOLE_ALLOW_REMOTE=1`（打开时启动会打 WARN，见 `logic.ts`）
 * 2. **token**：写操作必须带 `YANXIN_CONSOLE_TOKEN`（`logic.ts` 的 `authorize`）。
 *    **没配 token = 一律拒写**（fail-closed），而不是"不设防"
 * 3. **审计**：所有写操作（含被拒的，**含被地址门拒的**）追加一行到
 *    `$DSH_HOME/yanxin/audit/console.jsonl`
 *
 * ⚠️ 门 1 与门 2 现在**合并进同一个 `authorize` 调用**：分成两处判，就会有人加一条新路径时
 *    只过了其中一处。
 *
 * ## 本文件不产出任何标记
 *
 * 它只做两件事：把请求分到"静态资源"（`client.ts` 的外壳常量，脚本已内联 —— 旧的
 * `/yanxin/client.js` 路由已废除）或"JSON 接口"（`api.ts` 的数据通道）。
 * **页的内容是数据不是 HTML** —— 浏览器端用 `textContent` 渲染，
 * 所以不可信数据（昵称、消息、日志行）没有变成标记的路径。见 `logic.ts` 的说明。
 *
 * ## 与其它服务的关系
 *
 *   · **不 inject 业务服务**（setup / admin / memory / onebot）：控制台是**只读的观察者**
 *     与少量写入口，用 `ctx.get` 软查 —— 某个服务不在时页面降级（区块里写"暂时不可用"），
 *     而不是整个控制台 pending 到起不来
 *   · 注册页/接口的插件**要自己 inject `console`**（子插件的作用域不继承，ADR 0004）
 *
 *   · 仪表盘聚合是例外里的小例外：它与**桥共享同一个 SQLite 文件**（WAL 支持多连接
 *     —— 桥写、这里读）。打不开（stats 关了 / 库损坏）就 `undefined`，首页如实显示
 *     "没有数据"，而不是整页挂掉。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MessageStats } from '../onebot/stats.ts'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { findApi, pagePayload, readJsonBody, sendJson } from './api.ts'
import { redirectToSlash, serveShell } from './client.ts'
import { WORLD_SETTINGS_NS, WORLD_SETTINGS_SCHEMA } from '../world/engine.ts'
import { locateLog, readIncrement } from './pages/log.ts'
import { redactValue } from '../audit/redact.ts'
import {
  authorize,
  CONSOLE_DEFAULTS,
  isLoopbackAddress,
  normalizePath,
  readToken,
  remoteAccessAllowed,
  safeDecode,
  sparkline,
  ALLOW_REMOTE_ENV,
  TOKEN_ENV,
  type Block,
} from './logic.ts'
import {
  auditWrite,
  registerApi,
  registerPage,
  type ConsoleApi,
  type ConsolePage,
  type Registry,
} from './registry.ts'
// 类型层面：让 `ctx.webServer` 可见（不 import 就报 "does not exist on type Context"）
import type {} from '@deepseek-ai/dsh-host-webserver'

declare module '@deepseek-ai/cordis' {
  interface Context {
    console: ConsoleService
  }
  interface Events {
    /** 一次写操作落定（含被拒的）。审计与将来的控制台日志订阅它。 */
    'yanxin/console-write'(record: { path: string; method: string; ok: boolean; reason?: string }): void
  }
}

const ConfigSchema = z.object({
  path: z.string().description('控制台挂载路径（无尾斜杠）。'),
  logFile: z
    .string()
    .description(
      '日志页读的实例日志文件（绝对路径）。不配则扫系统临时目录下最新的 `yanxin*.log`' +
        '（nohup 启动的默认形态）。',
    ),
  worldGroupId: z
    .string()
    .description(
      '她的世界群号（作为 `yanxin-world` settings 的静态层）。写在 console 行而不是引擎行：' +
        '引擎卸下时群号仍然可见、可改。',
    ),
})

interface ConsoleConfig {
  path?: string
  logFile?: string
  worldGroupId?: string
  /** 统计库路径。缺省与桥一致（`$DSH_HOME/yanxin/stats.db`）—— 两边必须指向同一个文件。 */
  statsPath?: string
}

export default class ConsoleService extends Service {
  /**
   * 只依赖 `webServer`（它不在就没地方挂路由）。
   *
   * ⚠️ 业务服务一个都不 inject（见文件头）—— 用 `ctx.get` 软查，缺谁就哪一页降级。
   */
  static readonly inject = ['webServer']

  static readonly Config: z<ConsoleConfig> = ConfigSchema

  private readonly base: string
  /** 行 config 的日志文件路径（日志页读它；`undefined` = 让日志页自己扫）。 */
  private readonly logFile: string | undefined
  /** 行 config 的世界群号（`yanxin-world` settings 的静态层，见 `ensureWorldScope`）。 */
  private readonly worldGroupId: string | undefined
  /** `yanxin-world` 的 scope（惰性注册 —— 见 `ensureWorldScope`）。 */
  private worldScope:
    | { get(): { worldGroupId?: string }; update(patch: object): Promise<void> }
    | undefined
  /** 仪表盘聚合的读取连接（与桥共享库文件；打不开 = 首页显示"没有数据"）。 */
  private readonly stats: MessageStats | undefined
  private readonly registry: Registry = { pages: [], apis: [] }

  constructor(ctx: Context, config: ConsoleConfig = {}) {
    super(ctx, 'console')
    this.base = normalizePath(config.path ?? CONSOLE_DEFAULTS.path)
    // 日志页的数据源（行 config；不配则日志页自己扫 tmpdir 的最新 yanxin*.log）。
    this.logFile = config.logFile
    this.worldGroupId = config.worldGroupId

    // 仪表盘的读取连接：与桥共享同一个库（WAL 多连接）。打不开不拦启动 ——
    // 首页降级显示"没有数据"，控制台其余功能照常。
    const statsPath = config.statsPath ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'yanxin', 'stats.db')
    try {
      this.stats = MessageStats.open(statsPath, { warn: (message) => this.ctx.logger.warn(message) })
      ctx.effect(() => () => this.stats?.close(), 'yanxin-console.stats-close')
    } catch (error) {
      this.ctx.logger.warn(`[yanxin-console] 统计库打不开（${statsPath}），首页仪表盘将没有数据：${error instanceof Error ? error.message : String(error)}`)
    }
    // `yanxin-world` 的注册**不在这里做**：构造期 settings 往往还没装载（ctx.get
    // 只同步返回已就绪的服务，不等待），注册会静默落空。挪到 `ensureWorldScope()`
    //（第一次有页面/接口要用它时注册——那时请求都能处理了，settings 必然就绪）。

    // ⚠️ **必须包 `ctx.effect`**：`register()` 返回 disposer 但不是 effect，
    //    不包的话插件卸载后路由仍在，而下次注册同一路径会直接 throw（T15 的反例）。
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: this.base,
          handler: (req, res) => this.handle(req, res),
        }),
      'yanxin-console.route',
    )

    this.ctx.logger.info(`[yanxin-console] 控制台挂载在 ${this.base}（写操作需要 ${TOKEN_ENV}）`)

    // 远程放行是**安全边界的放宽**，不能只在配置里静静存在 —— 每次启动都喊一声。
    // 本轮（Docker 形态）没有会话凭据，唯一的门就是那个 token，所以这句话必须出现在日志里，
    // 让人在把端口暴露出去之前看见它。凭据改造（密码 + 会话）落地后这条 WARN 改成"已开密码"。
    if (remoteAccessAllowed()) {
      this.ctx.logger.warn(
        `[yanxin-console] 已允许远程访问（${ALLOW_REMOTE_ENV}=1）：当前唯一凭据是 ${TOKEN_ENV} —— ` +
          '公网可达 + 管理员私聊带未沙箱 shell，请只在受控网络里这样跑，测完把这一档关掉',
      )
    }
  }

  /** 挂载路径（页与接口注册时用）。 */
  get path(): string {
    return this.base
  }

  /** 日志页的数据源（行 config 给的绝对路径；没配时日志页自己扫 tmpdir）。 */
  get logFilePath(): string | undefined {
    return this.logFile
  }

  /**
   * 拿到 `yanxin-world` 的 settings scope（惰性注册，幂等）。
   *
   * 为什么惰性：构造期 settings 服务多半还没装载，`ctx.get` 同步软查会拿到
   * undefined，注册静默落空。这个方法在**请求处理时**被世界页调用 —— 那时
   * settings 必然就绪。行 config 的 worldGroupId 作为**静态层**（base）传进去，
   * 于是"用户没写过群号"时它也有值（引擎卸下时同样可见）。
   *
   * 注册挂在本服务的 fiber 上（`register` 内部用 `ctx.effect`）：console 是常驻
   * root 行，fiber 活着注册就在 —— 世界引擎卸下也不影响控制台读写。
   */
  ensureWorldScope(): { get(): { worldGroupId?: string }; update(patch: object): Promise<void> } {
    if (this.worldScope !== undefined) return this.worldScope
    const settings = this.ctx.get('settings') as
      | { register(namespace: string, schema: unknown, options?: object): { get(): { worldGroupId?: string }; update(patch: object): Promise<void> } }
      | undefined
    this.worldScope = settings?.register(WORLD_SETTINGS_NS, WORLD_SETTINGS_SCHEMA, {
      base: { worldGroupId: this.worldGroupId },
    })
    if (this.worldScope === undefined) {
      this.ctx.logger.warn('[yanxin-console] settings 服务不在 —— 世界群号读不了也存不了（页面会显示空）')
    }
    return this.worldScope as { get(): { worldGroupId?: string }; update(patch: object): Promise<void> }
  }

  /** 注册一个页（登记绑调用方 fiber：注册它的插件卸载时自动摘掉）。 */
  page(entry: ConsolePage): void {
    registerPage(this.ctx, this.registry, entry)
  }

  /** 注册一个接口（同上）。 */
  api(entry: ConsoleApi): void {
    registerApi(this.ctx, this.registry, entry)
  }

  // ── 分发 ────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const relative = safeDecode(url.pathname.slice(this.base.length)) // '' | '/world' | '/api/page/world'

    // 门一 + 门二：都在 `authorize` 里判（地址那一维 + token 那一维）——
    // 分成两处写就会出现"某一条路径绕过了其中一处"，而那是最难查的一类洞。
    // 为什么地址门不能只看 webServer 的 host 配置：那是**行 config**，我们看不到也无法断言；
    // 这一道由我们的代码守，能被测试证伪（`logic.ts` 的表驱动用例）。
    const verdict = authorize({
      method: req.method,
      path: relative,
      provided: readToken(req.headers, url.searchParams),
      expected: process.env[TOKEN_ENV],
      loopback: isLoopbackAddress(req.socket.remoteAddress ?? undefined),
      allowRemote: remoteAccessAllowed(),
    })
    if (!verdict.allowed) {
      await auditWrite(this.ctx, { path: url.pathname, method: req.method ?? '', ok: false, reason: verdict.reason })
      sendJson(res, verdict.status, { ok: false, error: verdict.reason })
      return
    }

    try {
      // 裸挂载路径 → 带尾斜杠（否则页内相对路径会跑到上一级去；见 client.ts 的说明）
      if (relative === '' && url.pathname !== `${this.base}/`) {
        redirectToSlash(res, this.base)
        return
      }
      if (!relative.startsWith('/api/')) {
        serveShell(res)
        return
      }
      // SSE 不走 serveApi（那条路是"一问一答"的 JSON 形状，流式需要持有 res）
      if (relative === '/api/log/stream') {
        await this.streamLog(res)
        return
      }
      await this.serveApi(req, res, relative.slice('/api/'.length), url.searchParams)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`[yanxin-console] ${url.pathname} 处理失败：${message}`)
      sendJson(res, 500, { ok: false, error: `控制台出错：${message}` })
    }
  }

  /**
   * 实时日志流（SSE）。页面打开时先推一段尾部（`reset`），之后每 1.5s 检查文件
   * 增量推一行 —— `EventSource` 断了会自动重连，不需要额外的重连协议。
   *
   * 生命周期：`res.on('close')` 清掉 interval（浏览器关页/断线后不能再写响应）。
   * 每一拍失败都静默跳过（文件被清/正被写是常态，下一拍自然恢复）。
   */
  private async streamLog(res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 3000\n\n')

    let current: string | undefined
    let offset = 0
    let closed = false
    res.on('close', () => {
      closed = true
    })

    const send = (payload: { reset?: boolean; text: string }): void => {
      if (closed) return
      // 出口脱敏与 sendJson 同一条纪律：日志行里出现密钥形态也要抹掉
      res.write(`data: ${JSON.stringify(redactValue(payload) ?? {})}\n\n`)
    }

    const tick = async (): Promise<void> => {
      if (closed) return
      try {
        const located = await locateLog(this.logFile)
        if (located.file === undefined) return
        if (located.file !== current) {
          // 轮换 / 首次：从尾部 64KB 的行首起，推一条 reset（客户端清空重填）
          current = located.file
          offset = Math.max(0, located.size - 64 * 1024)
          const { text, nextOffset } = await readIncrement(current, offset)
          offset = nextOffset
          const aligned = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : ''
          send({ reset: true, text: aligned })
          return
        }
        if (located.size > offset) {
          const { text, nextOffset } = await readIncrement(current, offset)
          offset = nextOffset
          if (text !== '') send({ text })
        } else if (located.size < offset) {
          // 文件被截断（清日志）—— 下一拍按轮换处理
          current = undefined
        }
      } catch {
        // 单拍失败忽略：文件正被写/刚好被清是常态
      }
    }

    await tick()
    const timer = setInterval(() => void tick(), 1500)
    res.on('close', () => clearInterval(timer))
  }

  private async serveApi(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,    query: URLSearchParams,
  ): Promise<void> {
    // 页的内容（外壳据此渲染）—— 控制台自己的接口，单独一支
    if (route === 'page' || route.startsWith('page/')) {
      const slug = route === 'page' ? '/' : `/${route.slice('page/'.length)}`
      sendJson(
        res,
        200,
        await pagePayload({
          slug,
          query,
          base: this.base,
          pages: this.registry.pages,
          indexBlocks: this.indexBlocks(),
        }),
      )
      return
    }

    const method = (req.method ?? 'GET').toUpperCase()
    const entry = findApi(this.registry.apis, route, method)
    if (entry === undefined) {
      sendJson(res, 404, { ok: false, error: `没有这个接口：${method} ${route}` })
      return
    }

    const body = method === 'POST' ? await readJsonBody(req) : undefined
    const result = await entry.handler({ body, query, base: this.base })
    // 各页的失败约定是「HTTP 200 + data 里带 error」（客户端读 data.error 显示）——
    // 审计必须认得这个形状：业务失败也是失败，不能跟成功写混在同一栏里
    const failure =
      result !== null && typeof result === 'object' && 'error' in result && (result as { error?: unknown }).error !== undefined
      ? String((result as { error: unknown }).error).slice(0, 200)
      : undefined
    if (method !== 'GET') {
      await auditWrite(this.ctx, {
        path: `${this.base}/api/${route}`,
        method,
        ok: failure === undefined,
        ...(failure === undefined ? {} : { reason: failure }),
      })
    }
    sendJson(res, 200, { ok: true, data: result ?? null })
  }

  // ── 首页（骨架：列出已注册的页与接口）──────────────────────────────────

  /**
   * 首页 = **仪表盘**：一句话状态 + 消息统计（今天/累计/近 7 天趋势/最热闹的群）
   * + 页面导航。统计读与桥共享的 SQLite；stats 不在时统计区块如实显示"没有数据"。
   */
  private indexBlocks(): readonly Block[] {
    const blocks: Block[] = []

    // ── 一句话状态（软查：不在的服务不渲染那一半）────────────────────────
    const window = this.ctx.get('window') as { paused?: boolean; isOpen?: boolean } | undefined
    const world = this.ctx.get('world') as { status?(): { ready: boolean; sequence: number | null } } | undefined
    if (window?.paused === true) {
      blocks.push({ kind: 'notice', tone: 'warn', text: '世界引擎已被**手动暂停**（世界页的开关）—— 她不主动过日子，被动回话照常。' })
    } else if (world?.status?.().ready === true) {
      blocks.push({ kind: 'notice', tone: 'info', text: '她在过自己的日子（世界开着）：下面是消息面，世界账目在「世界」页。' })
    } else {
      blocks.push({ kind: 'notice', tone: 'info', text: '聊天线活着：群里 @ 她或叫她名字她会应。世界引擎现在没装载（时段外或未恢复）。' })
    }

    // ── 消息统计（SQLite；桥记、这里读）────────────────────────────────
    const overview = this.stats?.overview()
    if (overview === undefined) {
      blocks.push({ kind: 'notice', tone: 'warn', text: '没有统计数据 —— 统计库没接上（桥的 stats 配置关了，或库打不开）。' })
    } else {
      const triggerRate =
        overview.todayIn === 0 ? '—' : `${Math.round((overview.todayTriggered / overview.todayIn) * 100)}%`
      blocks.push({
        kind: 'table',
        caption: '今天',
        head: ['收到', '触发会话', '回复', '触发率'],
        rows: [[`${overview.todayIn}`, `${overview.todayTriggered}`, `${overview.todayOut}`, triggerRate]],
      })
      blocks.push({
        kind: 'table',
        caption: '累计',
        head: ['总收到', '总回复'],
        rows: [[`${overview.totalIn}`, `${overview.totalOut}`]],
      })

      const peak = Math.max(1, ...overview.days.map((day) => day.inCount))
      blocks.push({
        kind: 'table',
        caption: '近 7 天（趋势：收到消息的热度）',
        head: ['日期', '收到', '回复', '趋势'],
        rows: overview.days.map((day) => [
          day.day.slice(5),
          `${day.inCount}`,
          `${day.outCount}`,
          sparkline([day.inCount], peak),
        ]),
      })

      blocks.push({
        kind: 'table',
        caption: '近 7 天最热闹的群（按收到计）',
        head: ['群号', '消息'],
        rows:
          overview.groups.length === 0
            ? [['—', '0']]
            : overview.groups.map((group) => [group.groupId, `${group.count}`]),
      })
    }

    // ── 页面导航（首页作为目录）───────────────────────────────────────
    if (this.registry.pages.length > 0) {
      blocks.push({
        kind: 'ul',
        items: this.registry.pages.map((page) => `${page.title} —— ${this.base}/${page.slug}`),
      })
    }
    return blocks
  }
}