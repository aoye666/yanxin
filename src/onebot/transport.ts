/**
 * OneBot 传输层参数的**运行期来源** —— `src/onebot/service.ts` 的接缝。
 *
 * ## 为什么要有这一层
 *
 * `host` / `port` / `token` / `path` 原本是**行 config**（profile 的部署层，
 * 见 `deploy/profile.example.cordis.patch.yml`），要改就得改文件重启实例 ——
 * 而换 token、换端口恰恰是最常做的两件事（token 泄漏了要立刻换；8080 撞了要挪走）。
 * 这里把它们提到 settings 命名空间 `yanxin-onebot`，控制台可以改、`watch` 会触发重听，
 * **不用重启**。
 *
 * ## 取值顺序（与 `src/memory/service.ts` 同一套三级回退）
 *
 * **settings → 行 config → 这里的默认**。
 *
 * ⚠️ 本文件的 schema **刻意不写 `.default()`**：写了 schema 就会给 settings 文档
 * 无中生有填上值，于是**部署层（行 config）被静默忽略** —— memory 那边实测踩过
 * （测试传 `searchLimit: 3` 拿到 5）。默认值只放在 {@link TRANSPORT_DEFAULTS} 一处常量里。
 *
 * ## 为什么 `accounts` 不在这里
 *
 * 账号注册表决定"这个 QQ 号的会话挂哪套能力集（preset）" —— 那是**能力构成**，
 * 不是运营参数，改它等于改权限边界。所以它仍然只在行 config 里，控制台只读显示。
 *
 * ⚠️ 装配纪律：只用命名导出（ADR 0004）。
 */
import z from '@deepseek-ai/schemastery'
import { isLoopbackAddress, tokenEquals } from '../console/logic.ts'

/** settings 命名空间名（⚠️ 只能小写字母/数字/连字符，点号不合法 —— ADR 0007）。 */
export const ONEBOT_SETTINGS_NS = 'yanxin-onebot'

/** 传输层参数（全部必填后的成品形态）。 */
export interface Transport {
  host: string
  port: number
  path: string
  token: string
  pingIntervalMs: number
  callTimeoutMs: number
}

/** settings 里**可能不全**的那一份（缺的项回退到行 config）。 */
export interface TransportOverride {
  host?: string | undefined
  port?: number | undefined
  path?: string | undefined
  token?: string | undefined
  pingIntervalMs?: number | undefined
  callTimeoutMs?: number | undefined
}

/**
 * `yanxin-onebot` 的 schema。**不要加 `.default()`**（理由见文件头）。
 */
export const TransportSchema = z.object({
  host: z.string().description('监听地址。回环（127.0.0.1 / ::1）以外都算对外监听。'),
  port: z.natural().description('监听端口。0 = 交给系统分配。'),
  path: z.string().description('只接受这个路径的升级请求（如 /onebot/v11）。空串 = 接受任意路径。'),
  token: z.string().description('OneBot 侧的 access token。空串 = 不校验（只绑回环时才可以这样）。'),
  pingIntervalMs: z.natural().description('WS 协议层 ping 间隔（存活检测）。'),
  callTimeoutMs: z.natural().description('API 调用的响应超时。'),
})

/** 第三级回退（行 config 也没给的时候）。`path` / `token` 的默认是"不设限"，只在回环下安全。 */
export const TRANSPORT_DEFAULTS = {
  host: '127.0.0.1',
  path: '',
  token: '',
  pingIntervalMs: 30_000,
  callTimeoutMs: 15_000,
} as const

/** 行 config 提供的那一份（可能缺 path/token）。 */
export interface TransportBaseline {
  host?: string | undefined
  port?: number | undefined
  path?: string | undefined
  token?: string | undefined
  pingIntervalMs?: number | undefined
  callTimeoutMs?: number | undefined
}

/**
 * 三级回退：settings → 行 config → {@link TRANSPORT_DEFAULTS}。
 *
 * `port` 在行 config 的 schema 里是 **required**（`z.natural().required()`），
 * 所以只有"两处都没给"这种不该发生的情况才会落到默认值 —— 默认给 8080 是为了
 * 让这个函数**总能**产出一个可用端口，而不是返回 undefined 让调用方各自猜。
 */
export function resolveTransport(
  override: TransportOverride,
  baseline: TransportBaseline,
): Transport {
  return {
    host: pick(override?.host, baseline?.host, TRANSPORT_DEFAULTS.host),
    port: pick(override?.port, baseline?.port, 8080),
    path: pick(override?.path, baseline?.path, TRANSPORT_DEFAULTS.path),
    token: pick(override?.token, baseline?.token, TRANSPORT_DEFAULTS.token),
    pingIntervalMs: pick(override?.pingIntervalMs, baseline?.pingIntervalMs, TRANSPORT_DEFAULTS.pingIntervalMs),
    callTimeoutMs: pick(override?.callTimeoutMs, baseline?.callTimeoutMs, TRANSPORT_DEFAULTS.callTimeoutMs),
  }
}

/** `??` 的语义在这里够用但类型上难看：三层都可能 undefined，最后一层一定是值。 */
function pick<T>(...candidates: readonly (T | undefined)[]): T {
  for (const candidate of candidates) if (candidate !== undefined) return candidate
  throw new Error('resolveTransport: 所有来源都没有值')
}

/** 改完之后是不是同一个监听点（只有这两项变了才需要重听）。 */
export function sameListenPoint(a: { host: string; port: number }, b: { host: string; port: number }): boolean {
  return a.host === b.host && a.port === b.port
}

// ── 控制台写入这一层时的校验 ──────────────────────────────────────────────

/** 一条校验结果。 */
export type TransportVerdict = { ok: true; patch: TransportOverride } | { ok: false; reason: string }

/** 合法的监听地址：回环、 unspecified（=所有网卡）、或一个点分 IPv4。别的都拒。 */
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

/** 这个地址是不是"对外可见"（不是回环、也不是 ::1）。 */
export function isPublicBindHost(host: string): boolean {
  const h = host.trim()
  if (h === '0.0.0.0' || h === '::') return true // 全接口
  return !isLoopbackAddress(h) // 127/8、::1、::ffff:127.x 都算回环
}

/**
 * 校验一份待写入的传输层参数。**这是服务端判据**，不是给浏览器玩的：
 * 控制台的写请求已经带 token 过了门，这里只管"这次改动会不会把她暴露出去"。
 *
 * 三条硬规则：
 *   1. `host` 要么回环，要么是 `0.0.0.0` / 一个 IPv4 字面量；其它写法（主机名、带端口、
 *      带 scheme）一律拒 —— 拼错了监听成一个怪地址，比不监听更糟。
 *   2. **非回环 + 空 token = 拒**。这个端口没有鉴权的话，任何能连上它的人都能冒充
 *      NapCat 推事件、并被回发消息（§7.4-A 的守卫管不到它，因为它不是 harness 发起的请求）。
 *   3. 要改成非回环，必须同时带 `confirm_public=true` —— 一句勾选，让"对外开"这个决定
 *      是**按下过的**，不是端口打错字的副作用。
 */
export function validateTransportInput(input: Record<string, unknown>, current: Transport): TransportVerdict {
  const patch: TransportOverride = {}

  const host = typeof input.host === 'string' ? input.host.trim() : ''
  if (host !== '') {
    const loopback = isLoopbackAddress(host)
    if (!loopback && host !== '0.0.0.0' && host !== '::' && !IPV4.test(host)) {
      return { ok: false, reason: `监听地址看不懂：${host}（要 127.0.0.1 / ::1 / 0.0.0.0 / 一个 IPv4）` }
    }
    for (const octet of host.matchAll(/\d{1,3}/g)) {
      if (Number(octet[0]) > 255) return { ok: false, reason: `IPv4 的段超出 0–255：${host}` }
    }
    patch.host = host
  }

  const portText = typeof input.port === 'string' ? input.port.trim() : String(input.port ?? '')
  if (portText !== '') {
    if (!/^\d{1,5}$/.test(portText)) return { ok: false, reason: `端口要是一个数字：${portText}` }
    const port = Number(portText)
    // 0 是合法语义（系统分配），1–1023 是特权/常见保留段，本机也一并放过但由上面的确认兜住风险
    if (port > 65535) return { ok: false, reason: `端口超出 65535：${port}` }
    patch.port = port
  }

  const path = typeof input.path === 'string' ? input.path.trim() : ''
  if (path !== '') {
    if (!path.startsWith('/')) return { ok: false, reason: `路径要以 / 开头：${path}` }
    if (/[\s?#]/.test(path)) return { ok: false, reason: `路径里不能有空格、? 或 #：${path}` }
    patch.path = path
  }

  // token 只在"这次真的填了值"时才改 —— 空白提交 = 不改，而不是"清空"
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (token !== '') patch.token = token

  for (const key of ['pingIntervalMs', 'callTimeoutMs'] as const) {
    const text = input[key]
    if (typeof text !== 'string' || text.trim() === '') continue
    if (!/^\d{1,9}$/.test(text.trim())) return { ok: false, reason: `${key} 要是一个毫秒数：${text}` }
    patch[key] = Number(text.trim())
  }

  // 生效后的形态（用于判定"改完是不是对外了"）
  const next = resolveTransport(patch, current)
  const willBePublic = isPublicBindHost(next.host)
  const tokenKnown = next.token !== '' || patch.token !== undefined

  if (willBePublic && input.confirm_public !== 'true') {
    return {
      ok: false,
      reason: `要把监听改成 ${next.host}（对外可访问）—— 需要显式勾选确认`,
    }
  }
  if (willBePublic && !tokenKnown) {
    return {
      ok: false,
      reason: `对外监听（${next.host}）不能没有 access token：那样任何能连上 ${next.port} 的人都可以冒充她的客户端`,
    }
  }

  return { ok: true, patch }
}

/** token 要不要跟现值比一下（避免把"用户没填"当成"清空 token"）。 */
export function tokenChanged(next: string, previous: string): boolean {
  return next !== previous && !tokenEquals(next, previous)
}
