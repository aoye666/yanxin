/**
 * 控制台的**纯逻辑**（T31，spec §6.12）。
 *
 * 三件事都不碰网络与文件系统，因此可以表驱动地测：
 *
 *   · **谁在敲门**：只服务回环请求（`isLoopbackAddress`）—— 与"webServer 只绑 127.0.0.1"
 *     是两道独立的门，因为**绑定地址是 webServer 行的配置**（我们看不到它，也无法断言它），
 *     而这一道由我们自己的代码守，能被测试证伪
 *   · **能不能写**：写操作（非 GET）必须带 `YANXIN_CONSOLE_TOKEN`（`authorize`），
 *     且比对用**定时安全比较** —— 普通 `===` 会按字节提前返回，给暴力猜测留出时间侧信道
 *   · **没配 token 怎么办**：**fail-closed**（一律拒写）。"没配就等于不设防"是最坏的默认
 *
 * ## 为什么 token 只从环境变量来
 *
 * spec §7.4-B 的纪律：密钥不进仓库、不进 `settings.yaml`、不进 patch。`YANXIN_CONSOLE_TOKEN`
 * 只在启动环境里（DSH 由 shell 启动时的环境变量），所以控制台**读环境变量**而不是配置项。
 *
 * ## 页面是"数据"，不是 HTML（XSS 的根治办法）
 *
 * 控制台**不做服务端模板**：`/yanxin` 返回一个**字面量外壳**，页的内容走 JSON
 * （`Block[]`），浏览器端用 `createElement` + `textContent` 渲染。
 *
 * 这样"不可信数据进 HTML"这条路径**根本不存在**：能进 HTML 的只有下面那个写死的字面量，
 * 而 QQ 昵称 / 群消息 / 日志行 / 笔记正文全程只作为**文本节点**进入 DOM
 * （`textContent` 不解析标记，等价于输出上下文编码）。
 * 服务端模板要防的正是"某处忘了转义"，而这里没有可以忘的地方。
 */
import { timingSafeEqual } from 'node:crypto'

/** 环境变量名（只这一个来源）。 */
export const TOKEN_ENV = 'YANXIN_CONSOLE_TOKEN'

/** 默认挂载路径。 */
export const CONSOLE_DEFAULTS = {
  path: '/yanxin',
} as const

/**
 * 这个地址是不是回环。
 *
 * 认三种写法：IPv4（`127.0.0.1` / `127.x.x.x` 整段）、IPv6（`::1`）、
 * 以及 Node 在双栈 socket 上给出的 IPv4-mapped（`::ffff:127.0.0.1`）。
 * 空值（拿不到地址）判**不是**回环 —— fail-closed。
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const value = address.trim().toLowerCase()
  if (value === '') return false
  if (value === '::1') return true
  const mapped = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
  const parts = mapped.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return false
  return octets[0] === 127
}

/**
 * 读操作里**仍然要 token**的路径前缀。
 *
 * 为什么日志流不算"普通只读"：它先把实例日志的尾部 64 KB 推给请求方，再每 1.5s 推增量
 * （`index.ts` 的 `streamLog`）。日志里有什么不由我们决定 —— 插件的诊断行、异常消息、
 * 守卫打的那条"拦截了哪个 URL"都会进去。出口的 `redactValue` 只抹得掉**认得出的密钥形态**
 * （键名以 key/token/secret… 结尾），密钥藏在路径里或厂商前缀更新时就漏了。
 * 所以这一路的判据从"能不能读页面"改成"读的是不是运行时的原文"。
 *
 * 同一条纪律记忆里页早就在守（`pages/memory.ts`：检索走 POST 而不是免 token 的 GET）。
 */
const TOKENED_READ_PREFIXES: readonly string[] = ['/api/log/']

/** 读操作不需要 token（spec §6.12：只读页面可不带），**日志流除外**（见上）。 */
export function requiresToken(method: string | undefined, path?: string): boolean {
  const normalized = (method ?? 'GET').toUpperCase()
  if (normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS') return true
  return path !== undefined && TOKENED_READ_PREFIXES.some((prefix) => path.startsWith(prefix))
}

export interface AuthorizeInput {
  method: string | undefined
  /** 控制台内的相对路径（去掉挂载前缀），用于识别"要 token 的读操作"。 */
  path?: string
  /** 请求带来的 token（头或查询参数，调用方已取好）。 */
  provided: string | undefined
  /** 环境变量里的期望值（没配时 `undefined`）。 */
  expected: string | undefined
}

export type AuthorizeVerdict =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; reason: string }

/**
 * 这次请求能不能过。
 *
 * 顺序是刻意的：**先判这次要不要凭据**（普通只读连 token 都不看），再判配没配，最后才比对。
 * 三种拒绝态各自有明确的原因字符串（审计日志与响应体都用它）：
 *   · 免凭据的读操作 → 放行
 *   · 要凭据 + 没配 token → 403（fail-closed，"服务器没配 token，一律拒绝"）
 *   · 要凭据 + 没带 token → 401
 *   · 要凭据 + token 不对 → 401
 */
export function authorize(input: AuthorizeInput): AuthorizeVerdict {
  if (!requiresToken(input.method, input.path)) return { allowed: true }

  if (input.expected === undefined || input.expected === '') {
    return {
      allowed: false,
      status: 403,
      reason: `服务器没配 ${TOKEN_ENV} —— 需要凭据的请求一律拒绝（fail-closed）`,
    }
  }

  if (input.provided === undefined || input.provided === '') {
    return { allowed: false, status: 401, reason: '这个请求需要 token' }
  }

  if (!tokenEquals(input.provided, input.expected)) {
    return { allowed: false, status: 401, reason: 'token 不对' }
  }

  return { allowed: true }
}

/**
 * 定时安全比较。
 *
 * 长度不同时 `timingSafeEqual` 会抛（两边必须是等长 Buffer）—— 所以先比长度：
 * 长度本身不是秘密（token 的长度看一眼请求就知道），提前返回这一点点信息是**可接受的**，
 * 而逐字节的内容比较留给定时安全实现。
 */
export function tokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 从请求头/查询里取 token（头优先：查询串会进日志与浏览器历史）。
 *
 * ⚠️ 但**日志流只能用查询串**：`EventSource` 不允许自定义请求头，所以 `client.ts` 给流地址
 * 拼 `?token=`。这就是为什么 `TOKENED_READ_PREFIXES` 里那一路的凭据会出现在 URL 里 ——
 * 换来的是"没有 token 就读不到运行时日志"，两害取其轻。别把这个值再打进日志。
 */
export function readToken(
  headers: Record<string, string | string[] | undefined>,
  query: URLSearchParams,
): string | undefined {
  const header = headers['x-yanxin-token']
  const fromHeader = Array.isArray(header) ? header[0] : header
  if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader

  const authorization = headers['authorization']
  const bearer = Array.isArray(authorization) ? authorization[0] : authorization
  if (typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')) {
    const value = bearer.slice('bearer '.length).trim()
    if (value !== '') return value
  }

  const fromQuery = query.get('token')
  return fromQuery === null || fromQuery === '' ? undefined : fromQuery
}

/** 路径规范化：保证以 `/` 开头、没有尾斜杠。 */
export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  if (trimmed === '') return CONSOLE_DEFAULTS.path
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/**
 * 一串数字 → 一行微柱图（`▁▂▃▄▅▆▇`）。
 *
 * 零依赖的趋势显示：字符高度按 `value / peak` 线性映射，全零给全 `▁`（看得见"这七天
 * 没动静"），负值按 0 处理。峰值由调用方传（多列共用一个尺度才有可比性）。
 */
export function sparkline(values: readonly number[], peak: number): string {
  const bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇']
  const safePeak = peak > 0 && Number.isFinite(peak) ? peak : 1
  return values
    .map((value) => {
      const clamped = Math.max(0, Math.min(value, safePeak))
      const level = Math.round((clamped / safePeak) * (bars.length - 1))
      return bars[level]
    })
    .join('')
}

// ── 页的内容：区块（**数据**，不是 HTML）──────────────────────────────────

/**
 * 一个区块 —— 页面的**线格式**：服务端给数据，浏览器端渲染成 DOM。
 *
 * 加新形态时只需在 `CONSOLE_CLIENT_SCRIPT`（`client.ts`）的渲染器里加一支 ——
 * 服务端一行不用改，也就没有"服务端拼 HTML"的机会。
 */
export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: readonly string[] }
  | { kind: 'stream'; url: string }
  | { kind: 'table'; caption?: string; head?: readonly string[]; rows: readonly (readonly string[])[] }
  | { kind: 'code'; text: string }
  | { kind: 'notice'; tone: 'info' | 'warn'; text: string }
  | { kind: 'link'; href: string; text: string }
  | {
      kind: 'form'
      /** 提交地址（相对控制台路径给也行 —— 页用 `PageInput.base` 拼）。 */
      action: string
      submit?: string
      fields: readonly {
        name: string
        label: string
        /**
         * `hidden` 不给标签（值由页填好，运营者看不见也不用填）；
         * `checkbox` 提交 `'true'` / `'false'`。
         */
        type?: 'text' | 'password' | 'hidden' | 'checkbox'
        value?: string
        hint?: string
      }[]
    }

/**
 * 浏览器端渲染器（**字面量**，服务端不参与拼接）。
 *
 * 三条纪律写在这里：
 *   · 只用 `createElement` / `textContent` / `append` —— **没有 `innerHTML`**，
 *     所以昵称、消息、日志里的 `<script>` 只会原样显示成文字
 *   · 表单提交带 `x-yanxin-token` 头（token 由使用者在页面上填一次，存在 sessionStorage）
 *   · 所有请求都相对控制台自己的路径，没有外部资源
 */

/**
 * 解码路径片段（`%E4%B8%8D` → `不`）。
 *
 * 用在拼"没有这一页：X"这类**给人看**的信息上 —— 原样的百分号编码很难读。
 * 解不开（坏编码）就原样返回：那是请求的错误，不该让处理流程抛。
 */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
