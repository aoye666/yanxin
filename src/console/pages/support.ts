/**
 * 控制台几页共用的小件（T32/T33）。
 *
 * 只有三件事：**降级成一句话**、**把值压成一行**、**把时刻说成人话**。
 * 它们都不碰服务也不碰文件，所以可以并进单元用例里表驱动地测。
 *
 * ⚠️ 只用命名导出（ADR 0004）。
 */
import type { Block } from '../logic.ts'

/**
 * 服务不在时的降级区块。
 *
 * 与 T34 的向导页同一取向：**页面不崩、也不假装** —— 说清楚"哪个服务不在"，
 * 运营者据此知道去看哪一行 patch。
 */
export function missingService(what: string): readonly Block[] {
  return [
    { kind: 'notice', tone: 'warn', text: `${what}服务不在（对应的插件行没装载）—— 这一页暂时不可用。` },
  ]
}

/** 把任意值压成一行（表格里用）。太长就截断，并**如实说**截了多少。 */
export function brief(value: unknown, limit = 160): string {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = '(无法序列化)'
    }
  }
  return text.length > limit ? `${text.slice(0, limit)}…（共 ${text.length} 字符）` : text
}

/** 现实时刻 → 本地可读（`2026-09-27 05:52`）。拿不到就显示 `—`。 */
export function clockText(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 时间戳（事件里的 `time`）→ 本地可读（带秒，时间轴上够用）。 */
export function stampText(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return `${clockText(ms)}:${String(new Date(ms).getSeconds()).padStart(2, '0')}`
}