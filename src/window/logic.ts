/**
 * 窗口判定的纯逻辑。
 *
 * 单独成文件的原因与 `admin/logic.ts` 同构：
 *   1. 规则需要**表驱动单测**（T18），单测不该被迫搭一个真实的 Cordis Context；
 *   2. 装配纪律（ADR 0004）：插件模块要么只用命名导出、要么只 `export default`。
 *      纯函数放这里，`index.ts` 那边就能保持"只 export default 一个类"。
 *
 * ## 语义约定（T17 定案）
 *
 *   · 时刻用 **"HH:mm" 24 小时制**（本地时区），比较粒度是**分钟** —— 秒与毫秒不参与。
 *   · 同日窗口是**左闭右开** `[start, end)`：`start <= now < end`。
 *     于是相邻窗口 `09:00-12:00` 与 `12:00-15:00` 接得上，且没有哪一分钟被算两次。
 *   · 跨天窗口（`start > end`，如 `22:00 → 07:00`）取并集：
 *     `now >= start || now < end`。午夜两侧都在窗内，不会在 00:00 抖一下。
 *   · **`start === end` 恒为关闭**。零长度的窗口没有意义，而"把它当天"是个危险的
 *     默认 —— 一个笔误会让主动行为 24 小时不受限。宁可不开放。
 *   · **空列表恒为关闭**。没有配置 = 不开放（fail-safe）。
 *   · **非法项跳过**（非 "HH:mm"、越界的小时/分钟、非字符串）：它不参与判定，
 *     也不抛异常。配置写坏时的症状是"这个窗口不开"，而不是"服务炸了"。
 */

/** 一条开放时段（"HH:mm"，本地时间）。 */
export interface WindowSpec {
  start: string
  end: string
}

/**
 * 解析 "HH:mm" 为当天的分钟数（0–1439）。
 *
 * 非法输入一律返回 `undefined`（不抛）：调用方是**判定**而不是解析器 ——
 * 手改 settings.yaml 的一个笔误不该让窗口服务崩溃。
 *
 * 接受一位数小时（`9:05`）—— 手写配置时很自然；分钟必须两位（`9:5` 拒绝，
 * 因为它有歧义：是 9:05 还是 9:50？）。
 */
export function parseClockTime(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const matched = raw.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (matched === null) return undefined
  const hours = Number(matched[1])
  const minutes = Number(matched[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/**
 * 一条窗口在给定分钟是否开放。
 *
 * 返回 `undefined` 表示**这条窗口非法**（时刻解析失败）—— 调用方按"跳过"处理。
 * 与 `false`（合法的关闭）分开表达，是为了让测试能区分两种情形。
 */
export function minutesInWindow(minuteOfDay: number, window: WindowSpec): boolean | undefined {
  const start = parseClockTime(window.start)
  const end = parseClockTime(window.end)
  if (start === undefined || end === undefined) return undefined
  if (start === end) return false // 零长度：恒关闭（刻意不解释为"全天"）
  if (start < end) return minuteOfDay >= start && minuteOfDay < end
  return minuteOfDay >= start || minuteOfDay < end // 跨天：[start, 24:00) ∪ [00:00, end)
}

/**
 * 当前是否落在**任意一条**窗口内。
 *
 * `now` 取**本地时间**分钟数 —— 有意如此：窗口说的是"这台机器所在时区的
 * 14:00-18:00"，而不是 UTC。单机部署下这是最不容易错的解释。
 */
export function withinAnyWindow(now: Date, windows: readonly WindowSpec[]): boolean {
  const minuteOfDay = now.getHours() * 60 + now.getMinutes()
  for (const window of windows) {
    if (minutesInWindow(minuteOfDay, window) === true) return true
  }
  return false
}

/**
 * 把**不可信输入**（手改的 settings.yaml、行 config）规范化为合法窗口列表。
 *
 * 逐项过滤：不是对象的、start/end 不是字符串的、格式解析失败的 —— 一律丢弃。
 * 注意是**连整条窗口一起丢**，而不是只丢一个字段：只留半个窗口（start 合法、
 * end 非法）没有意义。
 *
 * 服务层读配置时过一遍这里：schema 保证"是数组、元素是对象、字段是字符串"
 * （若写了对象结构约束），而"HH:mm"格式的校验在纯函数里做。双保险，
 * 代价只是一个 O(n) 遍历。
 */
export function normalizeWindows(raw: unknown): WindowSpec[] {
  if (!Array.isArray(raw)) return []
  const out: WindowSpec[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const { start, end } = item as Record<string, unknown>
    if (typeof start !== 'string' || typeof end !== 'string') continue
    if (parseClockTime(start) === undefined || parseClockTime(end) === undefined) continue
    out.push({ start, end })
  }
  return out
}