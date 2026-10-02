/**
 * 对话页（T33）—— 事件时间轴：她收到过什么、回过什么、调过什么工具。
 *
 * ## 只看"活着的会话"（这条限度写在页面上）
 *
 * 事件来自 `ctx.sessions`（**内存里的 live session**）+ `readSessionEvents()`（跨版本适配层，
 * ADR 0011）。磁盘上的历史日志读不了 —— 它们按会话分目录、**分帧 zstd** 压缩
 * （`session.jsonl.zstd`），而 Node 的 zstd 解压只认第一帧：实测一个 400KB 的文件
 * 只解出 175 字节（就是那行 session 头）。要读全得自己扫帧边界，那是另一件事
 * （而且会读到一个没有文档保证的格式）。所以这一页**如实说明**它只覆盖本进程。
 *
 * ## 为什么按会话列出而不是"一条总时间轴"
 *
 * 会话 id 就是记忆的写回单位（spec §6.5：`agent:<selfId>:group:<gid>` / `admin:<uid>` /
 * `world:<selfId>`）—— 混在一起会看不出"这句话是在哪个场景说的"，而场景恰恰是
 * 决定她当时有什么能力、记忆写到哪里的东西。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Block } from '../logic.ts'
import { readSessionEvents, type SessionEventSource } from '../../onebot/session-api.ts'
import { brief, missingService, stampText } from './support.ts'

/** 装配纪律（ADR 0004）：命名导出 + `inject`，**不写 default**。 */
export const name = 'yanxin-console-talk-page'
export const inject = ['console']

/** 默认显示最近多少条（太多会把页面拖慢，翻页用 `?all=1`）。 */
export const DEFAULT_ROWS = 60

/** 会话服务在本页用到的最小面。 */
interface SessionsLike {
  list(): readonly (SessionEventSource & { id?: unknown })[]
  get(id: string): (SessionEventSource & { id?: unknown }) | undefined
}

/** 时间轴的一行（纯函数的输出，便于断言）。 */
export interface TimelineRow {
  at: number | null
  type: string
  text: string
}

/** 从事件负载里取字段：优先 `data`（DSH 的事件形状是 `{ type, seq, time, data }`），回退事件自身。 */
function pick(event: Record<string, unknown>, data: Record<string, unknown>, key: string): unknown {
  return data[key] !== undefined ? data[key] : event[key]
}

/** 把消息内容的 text 块拼起来（与 `session-trigger.ts` 的读法一致）。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text?: unknown } => block !== null && typeof block === 'object')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

/**
 * 一条事件 → 一行摘要。
 *
 * **必须是防御式的**：事件来自运行时（monorepo 形态），字段随上游变；不认识就只显示
 * 类型 —— 一个显示不全的时间轴，好过一个抛异常把页面打崩的时间轴。
 */
export function summarizeEvent(raw: unknown): TimelineRow {
  if (raw === null || typeof raw !== 'object') return { at: null, type: '?', text: '' }
  const event = raw as Record<string, unknown>
  const type = typeof event.type === 'string' ? event.type : '?'
  const at = typeof event.time === 'number' ? event.time : null
  const data = (event.data ?? {}) as Record<string, unknown>

  if (type === 'user/message' || type === 'assistant/message') {
    const message = pick(event, data, 'message') as { content?: unknown; source?: unknown } | undefined
    const source = (message?.source ?? {}) as { kind?: unknown; userId?: unknown; groupId?: unknown; mode?: unknown }
    const who =
      source.kind === 'qq'
        ? `【${source.mode ?? '?'}】${source.groupId === undefined ? '私聊' : `群 ${source.groupId}`} / ${source.userId ?? '?'}`
        : ''
    return { at, type, text: [who, textOf(message?.content)].filter((part) => part !== '').join(' ') }
  }

  if (type === 'tool/call') {
    // 变量名避开模块级的 `name`（那是插件的行名，别在函数里把它遮住）
    const toolName = pick(event, data, 'name')
    const args = pick(event, data, 'arguments')
    return { at, type, text: `${typeof toolName === 'string' ? toolName : '?'}(${brief(args, 140)})` }
  }

  if (type === 'tool/result') {
    const error = pick(event, data, 'error')
    return { at, type, text: error === undefined || error === null ? 'ok' : `失败：${brief(error, 140)}` }
  }

  if (type === 'turn/end') {
    return { at, type, text: brief(pick(event, data, 'reason'), 120) }
  }

  return { at, type, text: '' }
}

/** 页面的区块（纯函数）。 */
export function renderTalkBlocks(
  state: {
    sessions: readonly string[]
    selected?: string
    rows?: readonly TimelineRow[]
    total?: number
    shownAll?: boolean
    note?: string
  },
  base: string,
): readonly Block[] {
  const blocks: Block[] = []

  if (state.note !== undefined) blocks.push({ kind: 'notice', tone: 'warn', text: state.note })

  if (state.sessions.length === 0) {
    blocks.push({
      kind: 'notice',
      tone: 'info',
      text: '现在没有活着的会话（本次进程里还没有人跟她说过话）。她收到消息后会在这里出现。',
    })
    return blocks
  }

  blocks.push({
    kind: 'ul',
    items: state.sessions.map(
      (id) => `${id}${id === state.selected ? '  ← 正在看这个' : ''}`,
    ),
  })
  blocks.push({
    kind: 'p',
    text: '看哪个会话（点一个）：',
  })
  for (const id of state.sessions) {
    blocks.push({ kind: 'link', href: `${base}/talk?session=${encodeURIComponent(id)}`, text: id })
  }

  if (state.selected === undefined) {
    blocks.push({ kind: 'p', text: '上面点一个会话，就会显示它的时间轴。' })
    return blocks
  }

  if (state.rows === undefined || state.rows.length === 0) {
    blocks.push({ kind: 'p', text: `会话 ${state.selected} 里还没有事件。` })
    return blocks
  }

  const total = state.total ?? state.rows.length
  blocks.push({
    kind: 'table',
    caption:
      state.shownAll === true
        ? `时间轴：${state.selected}（全部 ${total} 条）`
        : `时间轴：${state.selected}（最近 ${state.rows.length} / 共 ${total} 条）`,
    head: ['时刻', '类型', '内容'],
    rows: state.rows.map((row) => [stampText(row.at), row.type, brief(row.text, 220)]),
  })
  if (state.shownAll !== true && total > state.rows.length) {
    blocks.push({
      kind: 'link',
      href: `${base}/talk?session=${encodeURIComponent(state.selected)}&all=1`,
      text: '显示全部',
    })
  }
  blocks.push({
    kind: 'p',
    text: '内容里带 `【模式】` 的是入站消息（模式 / 群或私聊 / 发送者）。工具调用与结果是那一轮里她实际做过的事。',
  })
  return blocks
}

/** 装页（**只有页，没有写接口**）。 */
export function apply(ctx: Context): void {
  ctx.console.page({
    slug: 'talk',
    title: '对话',
    render({ base, query }) {
      const sessions = ctx.get('sessions') as SessionsLike | undefined
      if (sessions === undefined) return missingService('会话（sessions）')

      const live = sessions.list()
      const ids = live.map((session) => (typeof session.id === 'string' ? session.id : '（无 id）'))
      const selected = query.get('session') ?? undefined
      const shownAll = query.get('all') === '1'

      if (selected === undefined) return renderTalkBlocks({ sessions: ids }, base)

      const session = sessions.get(selected)
      if (session === undefined) {
        return renderTalkBlocks({
          sessions: ids,
          selected,
          note: `会话 ${selected} 不在活着的列表里（重启后历史在磁盘上，这一页只覆盖本进程）。`,
        }, base)
      }

      let events: readonly unknown[]
      try {
        events = readSessionEvents(session, 0)
      } catch (error) {
        return renderTalkBlocks({
          sessions: ids,
          selected,
          note: `读事件失败：${error instanceof Error ? error.message : String(error)}`,
        }, base)
      }

      const all = events.map(summarizeEvent)
      const rows = shownAll ? all : all.slice(-DEFAULT_ROWS)
      return renderTalkBlocks({ sessions: ids, selected, rows, total: all.length, shownAll }, base)
    },
  })
}