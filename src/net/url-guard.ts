/**
 * 出网 URL 守卫 —— spec §7.4-A 的落地实现。
 *
 * 覆盖两类目标工具：
 *   1. `web_fetch`（DSH 自带）
 *   2. 任意工具参数里带 `url` / `urls` 键的调用 —— 主要是 MCP 工具（`mcp__*`）
 *
 * 为什么要自己写：
 *   (a) `@deepseek-ai/dsh-web-fetch-http` 明确不实现私网防护 ——
 *       packages/web/web-fetch-http/src/provider.ts:6
 *         "Private-network and SSRF protection is not implemented; do not enable this provider where..."
 *       packages/web/web-fetch-http/src/policy.ts:18
 *         "(SSRF / private-network blocking is deferred — see the package Agent Note.)"
 *       它只做传输卫生：仅 http/https、拒 URL 内凭据、长度/字节/字符/超时/跳数上限、
 *       仅同源重定向、拒二进制。私网目标（127.0.0.1 / 10.* / 192.168.* / 169.254.169.254）它照发。
 *   (b) MCP 工具**绕过 preset 的能力裁剪**（ADR 0005 取证），所以不能指望"不给小研挂 MCP 工具"
 *       来解决 —— 只能在调用点守。
 *
 * 为什么递归扫描 `url` / `urls` 而不是逐工具硬编码：
 *   tavily 家族就不统一 —— `tavily_extract` 用 `urls`（数组），`tavily_crawl` / `tavily_map` 用 `url`（单值），
 *   而 `tavily_search` 根本没有 URL 参数（只有 `include_domains` 之类的域名列表，不该拦）。
 *   递归扫描对**未知的** MCP 工具也自动生效，不依赖我们去枚举每个工具的参数表。
 *
 * 挂载点 `tools/pre-execute`：DSH 官方说 per-call allow/deny/ask 策略属于这一层
 * （packages/shell/bash-local/README.md: "per-call allow/deny/ask policy belongs on tools/pre-execute"）。
 *
 * ⚠️ 已知残留风险（诚实记录）：本守卫先解析 DNS 再判定，而 provider 会自己再解析一次并连接。
 *    因此理论上仍存在 DNS rebinding 的时间窗。彻底关闭需要 provider 层支持"解析后锁定 IP"，
 *    超出我们的接缝能力。
 *
 * ⚠️ 装配纪律：本模块只用命名导出，不用 `export default` —— 两者混用会让 `inject` 被静默丢弃（ADR 0004）。
 */

import { lookup } from 'node:dns/promises'
import { redactSecrets } from '../audit/redact.ts'
import { writeAudit } from '../audit/log.ts'

export const name = 'yanxin-url-guard'
export const inject = ['tools']

/** DSH 自带抓取工具名（packages/web/tool-web/src/fetch.ts:437） */
const FETCH_TOOL = 'web_fetch'

/** 参数里出现这两个键（不区分大小写）就当作 URL 处理 */
const URL_KEYS = new Set(['url', 'urls'])

/** 递归深度上限，防御异常深层参数 */
const MAX_DEPTH = 6

/**
 * 审计日志（spec §5.2 的数据布局）。
 *
 * 为什么需要它：实测发现**被拒的调用在 session 日志里不留任何痕迹**（ADR 0005）——
 * 7 轮的会话里只有 1 条 `tool/call`，守卫的 reason 字符串出现 0 次。
 * 也就是说只看 session 无法证明守卫是否真的工作过；而一个"靠拒绝来保证安全"的机制
 * 必须能举出自己的证据。`ctx.logger.warn` 只到控制台，不落盘、不进会话，不够。
 *
 * ⚠️ 落盘走 `src/audit/log.ts`（**唯一出口**）：那里会做密钥脱敏 —— 这一条是必须的，
 * 因为 URL 里带密钥是常态（MCP 端点 `?tavilyApiKey=tvly-dev-…`，spec §7.4-D 的实例）。
 */
const AUDIT_KIND = 'url-guard' as const

/** IPv4 的私有 / 回环 / 链路本地 / 保留 / 多播段（spec §7.4-A 第 2 条） */
export function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((s) => Number(s))
  if (parts.length !== 4) return true
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const a = parts[0] as number
  const b = parts[1] as number
  if (a === 0) return true // 0.0.0.0/8        未指定
  if (a === 10) return true // 10/8            私有
  if (a === 127) return true // 127/8           回环
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10   CGNAT
  if (a === 169 && b === 254) return true // 169.254/16   链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12   私有
  if (a === 192 && b === 168) return true // 192.168/16  私有
  if (a === 192 && b === 0) return true // 192.0.0/24 & 192.0.2/24  文档 / 保留
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15  基准测试
  if (a >= 224) return true // 224/4 多播 + 240/4 保留
  return false
}

/** IPv6 的未指定 / 回环 / ULA / 链路本地 / 多播段，以及**内嵌 IPv4 的几种封装** */
export function isBlockedIpv6(raw: string): boolean {
  const g = parseIpv6(raw)
  if (!g) return true // fail-closed：解析不了的按拒绝处理
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g

  if (g.every((part) => part === 0)) return true // ::        未指定
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true // ::1       回环
  }

  // ⚠️ **内嵌 IPv4 的封装必须按"里面的 IPv4"判** —— 否则 `[::ffff:a9fe:a9fe]`
  //    （= 169.254.169.254，云元数据）会被当成一个普通 IPv6 放行。
  //    这不是理论：WHATWG URL 解析器**会把点分写法归一化成十六进制**
  //    （实测 `new URL('http://[::ffff:169.254.169.254]/').hostname` → `[::ffff:a9fe:a9fe]`），
  //    所以只认点分形态的判定等于没判。
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4(ipv4Of(g6, g7)) // ::ffff:a.b.c.d   IPv4-mapped
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(ipv4Of(g6, g7)) // ::a.b.c.d        IPv4-compatible（已弃用但仍可解析）
  }
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(ipv4Of(g6, g7)) // 64:ff9b::/96    NAT64 知名前缀
  }
  // ⚠️ 64:ff9b:1::/48 是 NAT64 **本地**前缀：RFC 8215 明确说它内嵌 IPv4 的**位置不保证**
  //    （运营商可按 RFC 6052 的 /48 布局放在 g3/g4）。这里按"末 32 位"读是一个**猜测**，
  //    fail-closed 兜底：前缀命中即拦，猜错的位置读到 0.0.0.0 也会拦 —— 实测各种形态
  //    都落在拒绝一侧，但理论上存在放行窗口（记录在案，见 ADR 0017 的续注）
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) {
    return isBlockedIpv4(ipv4Of(g6, g7))
  }
  if (g0 === 0x2002) return isBlockedIpv4(ipv4Of(g1, g2)) // 2002::/16  6to4（把 v4 嵌在前两组）

  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7   ULA
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10  链路本地
  if ((g0 & 0xffc0) === 0xfec0) return true // fec0::/10  站点本地（已弃用，fail-closed）
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8   多播
  return false
}

/** 两个 16 位分组还原成点分 IPv4（供内嵌 IPv4 的封装判定使用） */
function ipv4Of(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/**
 * 解析 IPv6 文本为 8 个 16 位分组；解析不了返回 `undefined`。
 *
 * 为什么要自己解析，而不是继续用字符串前缀判断：前缀判断对**压缩与归一化**的写法很脆 ——
 * URL 解析器输出的是规范形态（`[::ffff:a9fe:a9fe]`），而"点分内嵌"只出现在人手输入里。
 * 数字分组是唯一能把这两条路合成一条的表示。
 *
 * 处理三种形态：完整 8 组、`::` 压缩（含省略全零段）、末尾内嵌 IPv4（先折算成两组）。
 * 带 `%zone` 的（fe80::1%eth0）先剥掉 zone 再判。
 */
export function parseIpv6(raw: string): number[] | undefined {
  let s = raw.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)

  // 末尾内嵌 IPv4 → 折算成两组十六进制，之后只走"分组"这一条路
  const dotted = s.match(/(^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted?.[2] !== undefined) {
    const octets = dotted[2].split('.').map((n) => Number(n))
    if (octets.length !== 4) return undefined
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
    const [a = 0, b = 0, c = 0, d = 0] = octets
    s = `${s.slice(0, s.length - dotted[2].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }

  const toGroups = (text: string): number[] | undefined => {
    if (text === '') return []
    const out: number[] = []
    for (const part of text.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined
      out.push(Number.parseInt(part, 16))
    }
    return out
  }

  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const left = toGroups(halves[0] ?? '')
  const right = halves.length === 2 ? toGroups(halves[1] ?? '') : []
  if (left === undefined || right === undefined) return undefined

  if (halves.length === 2) {
    const fill = 8 - left.length - right.length
    if (fill < 0) return undefined
    return [...left, ...Array<number>(fill).fill(0), ...right]
  }
  return left.length === 8 ? left : undefined
}

/** 内网主机名（spec §7.4-A 第 2 条的 localhost 类） */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.home.arpa')
  )
}

function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[/, '').replace(/\]$/, '')
  return /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')
}

/**
 * 递归收集参数里所有 `url` / `urls` 键的字符串值。
 * 导出以便单测（T38/T35 会用它写表驱动用例，含 tavily 的 `urls` 数组形态）。
 */
export function collectUrlArgs(args: unknown, depth = 0): string[] {
  if (depth > MAX_DEPTH || args === null || typeof args !== 'object') return []
  const out: string[] = []
  if (Array.isArray(args)) {
    for (const item of args) out.push(...collectUrlArgs(item, depth + 1))
    return out
  }
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (URL_KEYS.has(key.toLowerCase())) {
      if (typeof value === 'string') out.push(value)
      else if (Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string') out.push(item)
      }
      continue // 已按 URL 语义取过值，不再往下钻
    }
    out.push(...collectUrlArgs(value, depth + 1))
  }
  return out
}

/**
 * 检查一个 URL 是否可安全发起。返回拒绝原因；`undefined` 表示放行。
 */
export async function checkUrl(raw: string): Promise<string | undefined> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // 折进一行、截断：解不开的串是**任意输入**，原样进日志等于让人能往日志里伪造换行
    return `URL 无法解析：${raw.replace(/\s+/g, ' ').slice(0, 200)}`
  }

  // 1. 仅 http / https
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `仅允许 http/https，收到 ${url.protocol}`
  }

  // 2. URL 内不允许携带凭据
  if (url.username || url.password) return 'URL 内不允许携带凭据'

  const host = url.hostname

  // 3. 内网主机名
  if (isBlockedHostname(host)) return `拒绝内网主机名：${host}`

  // 4. IP 字面量：直接判，不做 DNS 解析
  if (isIpLiteral(host)) {
    const blocked = host.includes(':') ? isBlockedIpv6(host) : isBlockedIpv4(host)
    return blocked ? `拒绝内网 / 保留地址：${host}` : undefined
  }

  // 5. 域名：先解析、再对解析结果判定（spec §7.4-A 第 3 条，防 DNS 指向内网）
  let addrs: Array<{ address: string; family: number }>
  try {
    addrs = (await lookup(host, { all: true, verbatim: true })) as Array<{
      address: string
      family: number
    }>
  } catch {
    return `域名解析失败：${host}`
  }
  if (!addrs.length) return `域名无解析结果：${host}`

  const bad = addrs.find((a) => (a.family === 4 ? isBlockedIpv4(a.address) : isBlockedIpv6(a.address)))
  if (bad) return `域名 ${host} 解析到内网 / 保留地址 ${bad.address}，已拒绝`

  return undefined
}

export function apply(ctx: any): void {
  ctx.on(
    'tools/pre-execute',
    async (exec: any, next: () => Promise<any>) => {
      const toolName: unknown = exec?.name
      if (typeof toolName !== 'string') return next()

      // 收集本调用要发起的全部出网 URL
      const urls =
        toolName === FETCH_TOOL
          ? typeof exec?.arguments?.url === 'string'
            ? [exec.arguments.url]
            : []
          : collectUrlArgs(exec?.arguments)

      if (!urls.length) return next()

      for (const url of urls) {
        const reason = await checkUrl(url)
        if (reason) {
          // ⚠️ 出口就脱敏：这一行会进实例日志，而实例日志会被控制台的实时流推给浏览器
          // （`src/console/index.ts` 的 streamLog）。审计那条走 writeAudit 已经脱过一层，
          // logger 这条**没有**同样的保护 —— 带 `?tavilyApiKey=…` 的端点就是这样进日志的。
          ctx.logger?.warn('[yanxin-url-guard] 拦截 %s：%s', toolName, redactSecrets(reason))
          await writeAudit(AUDIT_KIND, { decision: 'deny', tool: toolName, url, reason })
          return { kind: 'deny', reason: `[yanxin-url-guard] ${reason}` }
        }
      }
      await writeAudit(AUDIT_KIND, { decision: 'allow', tool: toolName, urls })
      return next()
    },
    { prepend: true }, // 先于其它 pre-execute 监听器
  )
}
