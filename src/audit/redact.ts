/**
 * 密钥脱敏 —— spec §7.4-D 的落地：**审计与日志里不得出现任何 key / token**。
 *
 * 为什么需要它（而不是"注意别记密钥"）：审计的用途恰恰是**如实记录**，
 * 而命令与 URL 里带密钥是常态 —— 最典型的是 MCP 端点
 * `https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-dev-…`（spec §7.4-D 实测记录在案，
 * 那个 key 就是这样泄漏进会话记录的）。所以纪律不能靠"记得别写"，
 * 必须在**落盘的唯一出口**上做一遍机械脱敏（`./log.ts`）。
 *
 * 取舍（诚实记录）：脱敏会让审计里的命令**不再是逐字节的原文**。
 * 我们在记录里同时写 `commandRedacted: true`，让读审计的人知道"这行被改过"，
 * 而不是以为原文张这样。**保留结构、抹掉密钥值**是这里的取向。
 *
 * ⚠️ 只用命名导出（ADR 0004）。
 */

/** 各类凭据的**可检索前缀**形态（厂商给密钥定的字面量前缀） */
const PREFIX_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-'],
  [/\btvly-[A-Za-z0-9_-]{8,}/g, 'tvly-'],
  [/\bghp_[A-Za-z0-9]{16,}/g, 'ghp_'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, 'github_pat_'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza'],
  [/\bya29\.[0-9A-Za-z._-]{20,}/g, 'ya29.'],
]

/** 令牌形态：`Bearer xxx`（HTTP 头里最常见的一种） */
const BEARER = /\b([Bb]earer\s+)([A-Za-z0-9._~+/-]{8,}=*)/g

/** PEM 私钥整块 */
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/**
 * 键值形态：`名称 … 分隔符 … 值`。
 *
 * 名称的判据是**词尾**（`key` / `token` / `secret` / `password` …）——
 * 这样 `tavilyApiKey=`、`YANXIN_CONSOLE_TOKEN=`、`access_token=`、`.password=` 都能覆盖，
 * 而不必去枚举厂商。
 *
 * 值的下限 `{4,}` 是**有意的取舍**：压掉 `key=x` / `token=1` 这类占位/开关值的误报
 * —— 代价是少于 4 字符的真密钥会漏脱（现实密钥没有这么短的，取可读性）。
 */
const PAIR = /([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pwd|credential)[A-Za-z0-9_.-]*\s*[=:]\s*)("?)([^\s"'&,;«»]{4,})\2/gi

/** 命令行开关形态：`--token xxx` / `--api-key xxx`（值以空格分隔） */
const FLAG = /(--?[A-Za-z0-9-]*(?:key|token|secret|password|passwd|pwd)\s+)(\S{4,})/gi

/** 脱敏后的占位（带类别，便于人读时知道抹掉了什么） */
function mask(kind: string): string {
  return `«redacted:${kind}»`
}

/** 把文本里的密钥值换成占位符，保留其余结构。 */
export function redactSecrets(text: string): string {
  let out = text
  out = out.replace(PRIVATE_KEY, mask('private-key'))
  out = out.replace(BEARER, (_all, head: string) => `${head}${mask('bearer')}`)
  for (const [pattern, label] of PREFIX_RULES) out = out.replace(pattern, mask(label))
  out = out.replace(PAIR, (_all, head: string, _quote: string) => `${head}${mask('value')}`)
  out = out.replace(FLAG, (_all, head: string) => `${head}${mask('value')}`)
  return out
}

/** 这段文本里是否有密钥（脱敏会改变它）—— 用于在记录上打 `redacted` 标记。 */
export function hasSecret(text: string): boolean {
  return redactSecrets(text) !== text
}

/**
 * 递归深度上限。
 *
 * ⚠️ 这个值**不能小**：控制台的一页 payload 是
 * `{ data: { blocks: [ { kind:'table', rows: [ [cell, cell] ] } ] } }` —— 光正常结构就有
 * 5 层，而 `sendJson` 的出口也要过这一层。T36 初版把它设成 4，于是**表格的 rows 整块**
 * 被换成了 `«redacted:depth»`（浏览器里看到的是"这一格没内容"）。
 * 集成用例（`console-pages.spec.ts` 的世界/对话两页）逮到了它。
 *
 * 现在的取值是"比任何真实结构都深，但仍有限"：超过它的只可能是被塞进来的异常结构，
 * 那时整体替换比继续递归安全（递归没有上限就等着栈溢出）。
 */
const MAX_DEPTH = 16

/**
 * 递归脱敏一个值：字符串走 `redactSecrets`，数组与普通对象逐层下钻。
 * 非字符串标量（数字/布尔/null）原样返回；超出深度上限的内容整体替换。
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return mask('depth')
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // 键名不脱敏：它是结构信息（`token=` 这样的键名恰恰说明这行记的是什么）
    out[key] = redactValue(item, depth + 1)
  }
  return out
}