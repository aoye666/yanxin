/**
 * 时段页（T32）—— 主动行为窗口（`yanxin-window` 的 `windows`）。
 *
 * 这一页是"她什么时候可以主动做事"的阀门：窗口关着时 World 引擎那一行会被
 * **卸载**（timer / 订阅 / 世界循环全部回滚，T19 验收过），窗口开了才装回来。
 *
 * ## 写进去之后怎么生效
 *
 * 走 `ctx.settings.update('yanxin-window', { windows })` —— 窗口服务**watch 着自己的
 * 命名空间**，一次提交就触发重新裁决（`evaluate()`），把引擎行装上/卸下。
 * 也就是说**不用重启**；页面上如实写着这一点（含 tickMs）。
 *
 * ## 为什么输入是一个文本框而不是两组时间选择器
 *
 * `Block` 的表单字段只有 文本 / 密码 / 隐藏 / 勾选 四种（见 `../logic.ts`）——
 * 没有 `time` 也没有"多行列表"。与其造一套字段类型（浏览器端也要跟着改），
 * 不如定一个**能一眼看懂、能被单测覆盖**的写法：`14:00-18:00`，多个用逗号或换行隔开。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Block } from '../logic.ts'
import { brief, missingService } from './support.ts'

/** 装配纪律（ADR 0004）：命名导出 + `inject`，**不写 default**。 */
export const name = 'yanxin-console-window-page'
export const inject = ['console']

/** 窗口服务在本页用到的最小面。 */
interface WindowLike {
  readonly windows: readonly { start: string; end: string }[]
  readonly isOpen: boolean
  readonly tickMs: number
  readonly engineEntryId: string
}

/** 时间窗（左闭右开，允许跨天 —— `22:00-07:00`）。 */
export interface WindowSpec {
  start: string
  end: string
}

export type WindowParse = { ok: true; windows: WindowSpec[] } | { ok: false; reason: string }

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * 解析文本框里的时段。
 *
 * 分隔符：逗号、分号、空白（含换行）都行 —— 运营者手写习惯不统一，不该因此报错。
 * **一个都不给 = 报错**，而不是"清空配置"：清空会让窗口恒关（她永远不主动做事），
 * 而那是多半误操作。真要恒关，写一个不可能的窗口（如 `00:00-00:01`）反而看得见。
 */
export function parseWindows(text: unknown): WindowParse {
  if (typeof text !== 'string') return { ok: false, reason: '没给时段' }
  // 先把连字符两侧的空白收掉：`14:00 - 18:00` 与 `14:00-18:00` 是同一个意思，
  // 而空白又恰好是时段之间的分隔符 —— 不收掉的话前者会被切成三段。
  const parts = text
    .replace(/\s*-\s*/g, '-')
    .split(/[,，;；\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) {
    return { ok: false, reason: '至少要写一个时段（例如 `14:00-18:00`；多个用逗号隔开）' }
  }

  const windows: WindowSpec[] = []
  for (const part of parts) {
    const [start, end, extra] = part.split('-')
    if (start === undefined || end === undefined || extra !== undefined) {
      return { ok: false, reason: `看不懂这个时段：${part}（要写成 开始-结束，如 14:00-18:00）` }
    }
    if (!TIME.test(start) || !TIME.test(end)) {
      return { ok: false, reason: `时间要写成 HH:mm（00:00–23:59）：${part}` }
    }
    if (start === end) return { ok: false, reason: `开始与结束不能相同：${part}` }
    windows.push({ start, end })
  }
  return { ok: true, windows }
}

/** 把解析出来的时段拼回文本框的初始值。 */
export function windowsText(windows: readonly WindowSpec[]): string {
  return windows.map((window) => `${window.start}-${window.end}`).join(', ')
}

/** 页面的区块（纯函数）。 */
export function renderWindowBlocks(state: {
  windows: readonly WindowSpec[]
  isOpen: boolean
  tickMs: number
  engineEntryId: string
}, base: string): readonly Block[] {
  const blocks: Block[] = [
    {
      kind: 'notice',
      tone: 'info',
      text: state.isOpen
        ? '现在是**开放时段**：World 引擎应该正装载着（她在过日子）。'
        : '现在是**关闭时段**：World 引擎那一行被卸载（timer / 订阅 / 世界循环都停了）。她仍会被动回话。',
    },
    {
      kind: 'table',
      caption: '当前时段',
      head: ['开始', '结束', '说明'],
      rows:
        state.windows.length === 0
          ? [['—', '—', '没有配置（引擎不会装载）']]
          : state.windows.map((window) => [
              window.start,
              window.end,
              window.start > window.end ? '跨天（到第二天）' : '同一天',
            ]),
    },
    {
      kind: 'form',
      action: `${base}/api/window/set`,
      submit: '保存时段',
      fields: [
        {
          name: 'windows',
          label: '时段（本地时间）',
          value: windowsText(state.windows),
          hint: '格式 `开始-结束`，多个用逗号隔开；支持跨天（22:00-07:00）',
        },
      ],
    },
    {
      kind: 'p',
      text: `保存后立刻重新裁决（不用重启）；引擎行是 \`${state.engineEntryId}\`，定时裁决每 ${state.tickMs}ms 一次。`,
    },
    {
      kind: 'p',
      text: '时间窗是左闭右开（14:00-18:00 表示 14:00 起、18:00 前）；写 `00:00-23:59` 等于整天开放。',
    },
  ]
  return blocks
}

/** 装页与接口。 */
export function apply(ctx: Context): void {
  ctx.console.page({
    slug: 'window',
    title: '时段',
    render({ base }) {
      const window = ctx.get('window') as WindowLike | undefined
      if (window === undefined) return missingService('窗口')
      return renderWindowBlocks(
        { windows: window.windows, isOpen: window.isOpen, tickMs: window.tickMs, engineEntryId: window.engineEntryId },
        base,
      )
    },
  })

  ctx.console.api({
    route: 'window/set',
    method: 'POST',
    async handler({ body }) {
      const settings = ctx.get('settings') as { update(ns: string, patch: object): Promise<void> } | undefined
      if (settings === undefined) return { error: 'settings 服务不在 —— 改不了时段（它得持久化）' }

      const parsed = parseWindows((body as { windows?: unknown } | undefined)?.windows)
      if (!parsed.ok) return { error: parsed.reason }

      try {
        await settings.update('yanxin-window', { windows: parsed.windows })
      } catch (error) {
        return { error: `写时段失败：${brief(error instanceof Error ? error.message : error, 200)}` }
      }
      const text = windowsText(parsed.windows)
      return { detail: `已保存 ${parsed.windows.length} 个时段：${text}（窗口服务会立刻重新裁决）` }
    },
  })
}