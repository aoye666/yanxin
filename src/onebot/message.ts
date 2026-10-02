/**
 * OneBot v11 消息归一化：把 `array`（消息段数组）与 `string`（CQ 码）两种形态
 * 归一到**同一内部表示**。
 *
 * ## 为什么需要
 *
 * 规范：`event.message_format` 默认 `string`（CQ 码），可配 `array`（消息段数组）；
 * 事件里的 `message` 字段**实际类型随配置而变**。而 `raw_message` 恒为 string。
 *
 * ⚠️ NapCat 侧的配置键名是它自己的（`messagePostFormat`），规范里没有这个名字 ——
 *    所以**不能假设部署用的是哪种**，两种都必须处理。
 *
 * ## 归一化的两个消费者
 *   1. **LLM**：需要一段可读文本 → 用 `text`（at/图片/表情转成占位符）
 *   2. **路由与判定**：需要结构化事实 → 用 `at` / `atAll` / `replyTo` / `images`
 *
 * 所以两者都产出，而不是只给一个。
 *
 * ## 书写纪律
 *   - 不用正则的 `.exec()`（Mimosa 会误判为命令注入，ADR 0005 已两次）。
 *   - 只用命名导出（ADR 0004）。
 */

/** 归一化后的消息段。未识别的类型落到 `other`，**不丢弃**。 */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'at'; qq: string }
  | { kind: 'image'; file: string; url?: string }
  | { kind: 'reply'; id: string }
  | { kind: 'face'; id: string }
  | { kind: 'other'; type: string; data: Record<string, string> }

export interface NormalizedMessage {
  /** 给 LLM 读的文本。at → `@qq`；图片 → `[图片]`；表情 → `[表情]`；回复 → 不占位。 */
  text: string
  /** 结构化分段（原文保序，未识别类型也在） */
  segments: Segment[]
  /** 被 at 的 QQ 号（**不含** `all`） */
  at: string[]
  /** 是否 at 了全体成员 */
  atAll: boolean
  /** 被回复的消息 id（若有） */
  replyTo: string | undefined
  /** 图片的 file 字段列表 */
  images: string[]
  /** 原始 `raw_message`（恒为 string，供诊断与兜底） */
  raw: string
}

/** 把 data 里的值统一成 string（规范：除合并转发外，消息段参数值几乎都是字符串）。 */
function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 解码 CQ 码参数里的转义。
 *
 * ⚠️ **顺序有讲究**：`&amp;` 必须**最后**解码。否则 `&amp;#91;`（字面量 `&#91;` 文本）
 *    会先被 `&#91;→[` 变成 `&[`，再被 `&amp;→&` 变成 `&[` —— 语义就错了。
 *    正确结果应是 `&#91;` 这 5 个字符。
 */
export function unescapeCq(text: string): string {
  return text
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')
}

/** 解析一段 CQ 码字符串为分段（纯文本与 `[CQ:...]` 混合）。 */
export function parseCqString(input: string): Array<{ type: string; data: Record<string, string> } | { type: 'text'; data: { text: string } }> {
  const out: Array<{ type: string; data: Record<string, string> } | { type: 'text'; data: { text: string } }> = []
  let rest = input

  while (rest.length > 0) {
    const start = rest.indexOf('[CQ:')
    if (start === -1) {
      out.push({ type: 'text', data: { text: unescapeCq(rest) } })
      break
    }
    if (start > 0) {
      out.push({ type: 'text', data: { text: unescapeCq(rest.slice(0, start)) } })
    }
    const end = rest.indexOf(']', start)
    if (end === -1) {
      // 未闭合的 `[CQ:` —— 当纯文本处理，不丢内容
      out.push({ type: 'text', data: { text: unescapeCq(rest.slice(start)) } })
      break
    }
    const body = rest.slice(start + 4, end) // 去掉 "[CQ:" 与 "]"
    const parts = body.split(',')
    const type = (parts.shift() ?? '').trim()
    const data: Record<string, string> = {}
    for (const part of parts) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      // 先按 ',' 切分，再解码 —— 否则参数里转义过的逗号会把键值对切断
      data[part.slice(0, eq).trim()] = unescapeCq(part.slice(eq + 1))
    }
    if (type) out.push({ type, data })
    rest = rest.slice(end + 1)
  }

  return out
}

/** 把 `{type, data}` 形态的一段转成归一化分段。 */
export function toSegment(type: string, data: Record<string, string>): Segment {
  switch (type) {
    case 'text':
      return { kind: 'text', text: data.text ?? '' }
    case 'at':
      return { kind: 'at', qq: data.qq ?? '' }
    case 'image':
      return data.url ? { kind: 'image', file: data.file ?? '', url: data.url } : { kind: 'image', file: data.file ?? '' }
    case 'reply':
      return { kind: 'reply', id: data.id ?? '' }
    case 'face':
      return { kind: 'face', id: data.id ?? '' }
    default:
      return { kind: 'other', type, data }
  }
}

/** 从 `array` 形态的 `message` 取分段。 */
function fromArray(value: unknown[]): Array<{ type: string; data: Record<string, string> }> {
  const out: Array<{ type: string; data: Record<string, string> }> = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type : ''
    if (!type) continue
    const rawData = obj.data
    const data: Record<string, string> = {}
    if (rawData !== null && typeof rawData === 'object' && !Array.isArray(rawData)) {
      for (const [k, v] of Object.entries(rawData as Record<string, unknown>)) data[k] = asString(v)
    }
    out.push({ type, data })
  }
  return out
}

/** 分段 → 给 LLM 读的文本。 */
function renderText(segments: readonly Segment[]): string {
  const parts: string[] = []
  for (const seg of segments) {
    switch (seg.kind) {
      case 'text':
        parts.push(seg.text)
        break
      case 'at':
        parts.push(seg.qq === 'all' ? '@全体成员' : `@${seg.qq}`)
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'face':
        parts.push('[表情]')
        break
      case 'reply':
        // 回复引用不占正文位置：它表达的是"这条消息在回谁"，不是内容
        break
      case 'other':
        parts.push(`[${seg.type}]`)
        break
    }
  }
  return parts.join('')
}

/**
 * 归一化事件的 `message` 字段。两种形态（array / string）产出**完全相同**的结构。
 *
 * `rawMessage` 传入时用于填充 `raw`。
 */
export function normalizeMessage(message: unknown, rawMessage?: unknown): NormalizedMessage {
  const raw = typeof rawMessage === 'string' ? rawMessage : ''

  let pairs: Array<{ type: string; data: Record<string, string> }>
  if (Array.isArray(message)) {
    pairs = fromArray(message)
  } else if (typeof message === 'string') {
    pairs = parseCqString(message)
  } else {
    pairs = []
  }

  const segments = pairs.map((p) => toSegment(p.type, p.data))

  const at: string[] = []
  let atAll = false
  let replyTo: string | undefined
  const images: string[] = []

  for (const seg of segments) {
    if (seg.kind === 'at') {
      if (seg.qq === 'all') atAll = true
      else if (seg.qq) at.push(seg.qq)
    } else if (seg.kind === 'reply') {
      if (!replyTo && seg.id) replyTo = seg.id
    } else if (seg.kind === 'image') {
      if (seg.file) images.push(seg.file)
    }
  }

  return { text: renderText(segments), segments, at, atAll, replyTo, images, raw }
}
