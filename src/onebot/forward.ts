/**
 * 合并转发（"折叠的聊天记录"）的展开：把转发的内容渲染成**给模型读的一段话**。
 *
 * ## 为什么单独一个文件
 *
 * 入站归一化（`message.ts`）是纯函数，而展开转发**要调 API**（`get_forward_msg`）。
 * 把那一次网络往返留在归一化里会把纯/不纯混起来，所以 `message.ts` 只负责
 * "认出有这么一段转发、把 id 和内联节点带出来"，展开在这里。
 *
 * ## 三条边界
 *
 *   · **深度上限**：转发里可以再套转发，套娃的展开是 prompt 膨胀的入口。
 *     `FORWARD_MAX_DEPTH` 之外的层留占位符 `[forward]`（她看得见"这里还有一层"）。
 *   · **条数上限**：一条合并转发可以有几十上百条消息，`FORWARD_MAX_NODES` 是总预算，
 *     超了就停并如实标注"还有 N 条没展开"——比静默截半条要好。
 *   · **拉不到不吞消息**：API 失败 / 没有 id / 超时，都**保留占位符并 warn 一条**
 *     （带转发 id，查的时候能直接对上）。整条消息被丢掉是不可诊断的。
 *
 * 只用命名导出（ADR 0004）。
 */
import { normalizeMessage, renderText, type Segment } from './message.ts'

/** 顶层转发记第 1 层；再往里超过这个深度就只留占位符。 */
export const FORWARD_MAX_DEPTH = 3
/** 一次入站消息里最多渲染多少条被转发的原话（prompt 膨胀的总闸）。 */
export const FORWARD_MAX_NODES = 40
/** 每条原话的字数上限（超出截断并加省略号）。 */
export const FORWARD_MAX_CHARS_PER_NODE = 300
/** 拉不到 / 超深度时留下的占位符（与 `message.ts` 的渲染值一致）。 */
export const FORWARD_PLACEHOLDER = '[forward]'

/** 只用到一个 API 调用，所以依赖是个函数而不是整个服务（测试直接塞假的）。 */
export type ForwardCall = (action: string, params: Record<string, unknown>) => Promise<unknown>

export interface ForwardRef {
  id: string
  /** 数组形态下可能已经内联在 `data.content` 里的那些节点。 */
  inline: unknown
}

/** 渲染预算（跨嵌套层共享，所以是可变对象）。 */
interface Budget {
  left: number
}

/** 一条被转发的原话。 */
interface ForwardLine {
  name: string
  time: string
  /** 已经渲染好的正文（嵌套转发也展开了，或者留了占位符）。 */
  body: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 秒级 unix 时间戳 → `MM-DD HH:mm`；没有或非法就给空串（渲染时省掉时间）。 */
function formatTime(value: unknown): string {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const date = new Date(seconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 把 `get_forward_msg` 的返回摊成节点数组。
 *
 * 两种真实形态都见过：官方的 `{ messages: [...] }`，和 NapCat 直接回一个数组。
 * 每个元素又可能是 `{ type: 'node', data: {...} }` 或裸的 `{ nickname, content }`。
 */
export function forwardNodes(value: unknown): Record<string, unknown>[] {
  const wrapped = asRecord(value)
  const list = Array.isArray(value)
    ? value
    : Array.isArray(wrapped?.messages)
      ? wrapped.messages
      : Array.isArray(wrapped?.data)
        ? wrapped.data
        : []
  return list.map((item) => {
    const record = asRecord(item)
    if (record === undefined) return undefined
    const data = asRecord(record.data)
    return data ?? record
  }).filter((item): item is Record<string, unknown> => item !== undefined)
}

/** 内联节点（数组形态转发段自带的 `data.content`）也是同一批形状。 */
export function inlineNodes(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? forwardNodes(value) : []
}

/** 一段转发正文（`content`）→ 可读文本，必要时递归展开里面的转发。 */
async function renderSegments(
  call: ForwardCall,
  segments: readonly Segment[],
  depth: number,
  warn: (message: string) => void,
  budget: Budget,
): Promise<string> {
  const parts: string[] = []
  for (const seg of segments) {
    if (seg.kind !== 'forward') {
      parts.push(renderText([seg]))
      continue
    }
    if (depth >= FORWARD_MAX_DEPTH) {
      // 到深度上限了：留占位符，让她知道"这里还有一层没打开"
      parts.push(FORWARD_PLACEHOLDER)
      continue
    }
    parts.push(await expand(call, { id: seg.id, inline: seg.inline }, depth + 1, warn, budget))
  }
  return parts.join('')
}

/**
 * 整条入站消息的正文（含转发时才有必要调）。
 *
 * **不是**在 `normalized.text` 上找占位符再替换：展开结果自己也可能带占位符（套娃到上限、
 * 或某一轮拉失败），按位置替换会把第一个占位符认成"下一个要展开的那个"，内容就错位了。
 * 这里按**段**走，一段对应一次展开，顺序天然对上。
 */
export async function renderInboundText(
  call: ForwardCall,
  segments: readonly Segment[],
  warn: (message: string) => void,
): Promise<string> {
  return renderSegments(call, segments, 0, warn, { left: FORWARD_MAX_NODES })
}

/** 一段转发正文（`content`）→ 可读文本，必要时递归展开里面的转发。 */
async function describeContent(
  call: ForwardCall,
  content: unknown,
  depth: number,
  warn: (message: string) => void,
  budget: Budget,
): Promise<string> {
  return renderSegments(call, normalizeMessage(content).segments, depth, warn, budget)
}

/**
 * 展开一个转发引用，返回给模型读的那段话。
 *
 * 失败时返回 {@link FORWARD_PLACEHOLDER} —— 调用方可以直接把它接回原文，消息不丢。
 */
export async function expand(
  call: ForwardCall,
  ref: ForwardRef,
  depth: number,
  warn: (message: string) => void,
  budget: Budget = { left: FORWARD_MAX_NODES },
): Promise<string> {
  const nodes = inlineNodes(ref.inline)
  if (nodes.length === 0) {
    if (ref.id === '') {
      warn(`转发段没有 id 也没有内联节点，留占位符不展开`)
      return FORWARD_PLACEHOLDER
    }
    let fetched: unknown
    try {
      fetched = await call('get_forward_msg', { message_id: ref.id })
    } catch (error) {
      warn(`拉合并转发 ${ref.id} 失败，留占位符：${error instanceof Error ? error.message : String(error)}`)
      return FORWARD_PLACEHOLDER
    }
    const parsed = forwardNodes(fetched)
    if (parsed.length === 0) {
      warn(`合并转发 ${ref.id} 拉到了但没有节点，留占位符`)
      return FORWARD_PLACEHOLDER
    }
    return renderLines(call, parsed, depth, warn, budget)
  }
  return renderLines(call, nodes, depth, warn, budget)
}

/** 顶层入口（桥只需要这个）。 */
export async function expandForward(
  call: ForwardCall,
  ref: ForwardRef,
  warn: (message: string) => void,
): Promise<string> {
  return expand(call, ref, 1, warn)
}

async function renderLines(
  call: ForwardCall,
  nodes: readonly Record<string, unknown>[],
  depth: number,
  warn: (message: string) => void,
  budget: Budget,
): Promise<string> {
  const lines: ForwardLine[] = []
  for (const node of nodes) {
    if (budget.left <= 0) break
    budget.left -= 1
    const body = await describeContent(call, node.content ?? node.text, depth, warn, budget)
    const name = typeof node.nickname === 'string' && node.nickname !== '' ? node.nickname : String(node.user_id ?? '未知')
    lines.push({ name, time: formatTime(node.time), body })
  }
  const omitted = nodes.length - lines.length
  const header = `[转发消息 · 共 ${nodes.length} 条${omitted > 0 ? `，已展开 ${lines.length} 条` : ''}]`
  const indent = '  '.repeat(Math.max(0, depth - 1))
  const rendered = lines.map((line) => {
    const at = line.time === '' ? line.name : `${line.name}（${line.time}）`
    return `${indent}- ${at}：${clip(line.body)}`
  })
  if (omitted > 0) {
    rendered.push(`${indent}- （还有 ${omitted} 条没展开，超过 ${FORWARD_MAX_NODES} 条的预算）`)
  }
  return [header, ...rendered].join('\n')
}

/**
 * 逐行压空格 + 限长，但**保留换行与行首缩进**。
 *
 * 正文里可能已经嵌着一层展开好的转发块（那些行的缩进就是"这是被转发的转发"的唯一记号），
 * 整段 `replace(/\s+/g,' ')` 会把那个块糊成一行， nests 的层次就看不出来了。
 */
function clip(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const indent = line.slice(0, line.length - line.trimStart().length)
      const body = `${indent}${line.trimStart().replace(/[ \t]+/g, ' ')}`.trimEnd()
      if (body.length <= FORWARD_MAX_CHARS_PER_NODE) return body
      return `${body.slice(0, FORWARD_MAX_CHARS_PER_NODE)}…`
    })
    .join('\n')
    .trim()
}
