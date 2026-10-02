/**
 * OneBot v11 反向 WebSocket 的**纯协议层**：握手解析、帧分类、API 帧构造。
 *
 * 这里没有任何网络代码 —— 全部是纯函数，便于表驱动单测。网络部分在 `./service.ts`。
 *
 * ## 方向（容易搞反，先写清楚）
 *
 * 反向 WS 里 **OneBot 实现（NapCat）是客户端，主动连我们**；但 API 调用的方向是：
 *
 * | 帧 | 发出方 | 接收方 |
 * |---|---|---|
 * | API 请求（`action`/`params`/`echo`） | **我们** | NapCat |
 * | API 响应（`status`/`retcode`/`data`/`echo`） | NapCat | **我们** |
 * | 事件推送（`post_type`/…） | NapCat | **我们** |
 *
 * 即"NapCat 连过来之后，由我们向它发 API 调用"。依据：规范说"连接建立后，使用方式同正向
 * WebSocket"，且"API 客户端**提供** API 调用服务"。
 *
 * ## 规范依据
 *
 * 取自 `botuniverse/onebot-11`（master）：`communication/ws-reverse.md`、
 * `communication/authorization.md`、`communication/ws.md`、`api/public.md`、
 * `message/array.md`、`message/segment.md`、`event/README.md`。
 *
 * ⚠️ 规范**未定义**的部分（不要凭空补）：
 *   - 反向 WS 握手成功/失败的状态码（HTTP 侧才有 401/403 的定义；WS 侧只说"连接会直接断开"）
 *   - `status`/`retcode` 除 `ok`/`failed`/`async`、`0`/`1` 以及 1400/1401/1403/1404 之外的含义
 *   - `echo` 的唯一性、并发 API 调用的数量上限、响应与请求的顺序保证
 *   → 所以本层自己做 echo 关联，且**不假设任何顺序**。
 *
 * ## 本仓库的两条书写纪律（实测踩出来的）
 *
 *   - **不要用正则的 `.exec()`**，改用 `String.prototype.match()` —— Mimosa 钩子会把
 *     `.exec(` 启发式判为"命令注入"并阻断写入（ADR 0005 已记录两次误报）。
 *   - 本模块只用命名导出，不用 `export default`（ADR 0004）。
 */

/** 反向 WS 握手头的 `X-Client-Role`。规范明确只有这三个值。 */
export type ClientRole = 'API' | 'Event' | 'Universal'

const ROLES: readonly ClientRole[] = ['API', 'Event', 'Universal']

export function isClientRole(value: unknown): value is ClientRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/** 握手解析结果。 */
export type HandshakeResult =
  | { ok: true; selfId: string; role: ClientRole; token: string | undefined }
  | { ok: false; reason: string }

/** Node 的 `IncomingHttpHeaders` 值可能是数组；取第一个。 */
export type HeaderValue = string | string[] | undefined

function firstHeader(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * 解析反向 WS 握手头。
 *
 * 必需：`X-Self-ID`（机器人 QQ 号）与 `X-Client-Role`（`API`/`Event`/`Universal`）。
 * 可选：`Authorization: Bearer <token>` —— 仅在 OneBot 侧配了 `auth.access_token` 时出现。
 *
 * `url` 传入时，会在**没有** Authorization 头的情况下从 query 里找 `access_token` 兜底：
 * 规范只定义了 header 形式，但部分实现的界面同时提供 "Authorization Header / URL Query"
 * 两条路（实测 SnowLuma 的 UI 就这么写），所以两种都得认。
 *
 * 不在这里判定的：这个 selfId 是不是**我们认识的账号** —— 那需要账号注册表，见 service.ts。
 */
export function parseHandshake(get: (name: string) => HeaderValue, url?: string): HandshakeResult {
  const selfId = firstHeader(get('x-self-id'))?.trim()
  if (!selfId) return { ok: false, reason: '缺少 X-Self-ID' }
  if (!/^\d+$/.test(selfId)) return { ok: false, reason: `X-Self-ID 不是数字串：${selfId}` }

  const rawRole = firstHeader(get('x-client-role'))?.trim()
  if (!rawRole) return { ok: false, reason: '缺少 X-Client-Role' }
  if (!isClientRole(rawRole)) {
    return { ok: false, reason: `X-Client-Role 非法：${rawRole}（只允许 ${ROLES.join(' / ')}）` }
  }

  let token: string | undefined

  const auth = firstHeader(get('authorization'))?.trim()
  if (auth) {
    // 用 match 而非 exec —— 见文件头的书写纪律
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (!m?.[1]) return { ok: false, reason: `Authorization 头不是 Bearer 形式：${auth}` }
    token = m[1].trim()
  }

  if (!token && url) {
    const q = url.indexOf('?')
    if (q >= 0) {
      const t = new URLSearchParams(url.slice(q + 1)).get('access_token')?.trim()
      if (t) token = t
    }
  }

  return { ok: true, selfId, role: rawRole, token }
}

/** 取 URL 的 pathname（去掉 query/hash）。用于校验反向 WS 的接入路径。 */
export function pathnameOf(url: string | undefined): string {
  if (!url) return ''
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

// ── 帧分类 ──────────────────────────────────────────────────────────────

export interface EventFrame {
  kind: 'event'
  postType: string
  /** 事件自带的 self_id（字符串化）。**必须与握手头一致**，否则视为串号（见 T9）。 */
  selfId: string
  raw: Record<string, unknown>
}

export interface ApiResponseFrame {
  kind: 'api-response'
  status: string
  retcode: number
  data: unknown
  echo: string | undefined
  raw: Record<string, unknown>
}

export interface UnknownFrame {
  kind: 'unknown'
  reason: string
  raw: unknown
}

export type IncomingFrame = EventFrame | ApiResponseFrame | UnknownFrame

function asSelfId(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value
  return ''
}

/**
 * 分类一个入站帧（NapCat → 我们）。
 *
 * ⚠️ **必须先看 `post_type`**。原因：**心跳事件同时带 `post_type` 与 `status`**
 * （`meta_event` / `heartbeat` / `status: {...}` / `interval`），而 API 响应也带 `status`。
 * 若先按 `status` 判定，心跳会被误判成 API 响应 —— 且它的 `status` 是**对象**不是字符串，
 * 后续逻辑会以更难懂的方式炸掉。这个顺序有专门的单测守着。
 */
export function classifyFrame(value: unknown): IncomingFrame {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unknown', reason: '不是 JSON 对象', raw: value }
  }
  const obj = value as Record<string, unknown>

  if (typeof obj.post_type === 'string') {
    return { kind: 'event', postType: obj.post_type, selfId: asSelfId(obj.self_id), raw: obj }
  }

  // API 响应：以 `status` 为准。`echo` 可选（规范："echo 字段是可选的"），
  // 但我们会一直发 echo，所以正常情况下它存在。
  if (typeof obj.status === 'string') {
    return {
      kind: 'api-response',
      status: obj.status,
      retcode: typeof obj.retcode === 'number' ? obj.retcode : -1,
      data: obj.data,
      echo: typeof obj.echo === 'string' ? obj.echo : undefined,
      raw: obj,
    }
  }

  return { kind: 'unknown', reason: '既无 post_type 也无 status', raw: value }
}

/**
 * 反向 WS 的连接建立元事件（NapCat 每次(重)连都会发，`sub_type` 为 `connect`）。
 *
 * ⚠️ 目前**仅测试消费**（存活检测走 service.ts 自己的 ping/pong，见 isHeartbeat 的说明）——
 * 留作协议形态的表驱动锚点。
 */
export function isLifecycleConnect(frame: EventFrame): boolean {
  return (
    frame.postType === 'meta_event' &&
    frame.raw.meta_event_type === 'lifecycle' &&
    frame.raw.sub_type === 'connect'
  )
}

/**
 * 是否为心跳。
 *
 * ⚠️ 规范：`heartbeat.enable` **默认 false**，`heartbeat.interval` 默认 15000。
 *    所以**不能依赖心跳做存活检测**，必须自己实现应用层 ping/pong（见 service.ts）。
 */
export function isHeartbeat(frame: EventFrame): boolean {
  return frame.postType === 'meta_event' && frame.raw.meta_event_type === 'heartbeat'
}

// ── API 帧构造（我们 → NapCat）────────────────────────────────────────────

export interface ApiRequestFrame {
  action: string
  params: Record<string, unknown>
  echo: string
}

/**
 * 构造一个 API 请求帧。
 *
 * `echo` 是我们自己生成的关联 id —— 规范只说它"可选、原样返回"，**未定义唯一性或顺序保证**，
 * 所以关联责任在我们这边（见 service.ts 的 pending 表）。
 */
export function buildApiFrame(
  action: string,
  params: Record<string, unknown>,
  echo: string,
): ApiRequestFrame {
  return { action, params, echo }
}
