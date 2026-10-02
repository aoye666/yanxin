/**
 * 窗口判定的表驱动用例（T18）。
 *
 * 分组：
 *   A parseClockTime   —— "HH:mm" 解析的合法与非法形态
 *   B withinAnyWindow  —— 同日 / 跨天 / 空列表 / 零长度 / 多窗口 / 相邻 / 非法项
 *   C minutesInWindow  —— 非法窗口返回 `undefined`，与"合法关闭"的 `false` 可区分
 *   D normalizeWindows —— 不可信输入（手改 settings.yaml）的过滤
 *
 * 判定粒度是**分钟**（秒不参与）：B 组里专门用带秒的时刻验证这一点
 * （如 14:00:59 仍算窗内、18:00:00 已算窗外）。
 *
 * ⚠️ 这里只测**纯逻辑**。服务层的接线（settings 回退、loader 启停、事件、
 * 生命周期回滚）在 `tests/integration/mode-switch.spec.ts`（T19）。
 */
import { describe, expect, it } from 'vitest'
import {
  minutesInWindow,
  normalizeWindows,
  parseClockTime,
  withinAnyWindow,
  type WindowSpec,
} from '../../src/window/logic.ts'

/**
 * 构造本地时间的时刻。日期固定（2026-09-26），判定只看时分 ——
 * 用本地时间构造，与实现里 `getHours()` 的取法一致（换时区跑也对得上）。
 */
function at(hours: number, minutes: number, seconds = 0): Date {
  return new Date(2026, 8, 26, hours, minutes, seconds)
}

describe('A) parseClockTime —— "HH:mm" 解析', () => {
  const valid: Array<[string, string, number]> = [
    ['零点', '00:00', 0],
    ['一位数小时（手写配置很常见）', '9:05', 545],
    ['常规两位', '09:05', 545],
    ['整点', '14:00', 840],
    ['一天最后一分钟', '23:59', 1439],
    ['首尾空白被修剪', ' 14:30 ', 870],
  ]

  it.each(valid)('%s', (_label, text, expected) => {
    expect(parseClockTime(text)).toBe(expected)
  })

  const invalid: Array<[string, unknown]> = [
    ['小时越界 24:00', '24:00'],
    ['分钟越界 23:60', '23:60'],
    ['分钟一位 9:5（有歧义）', '9:5'],
    ['分钟一位 09:5（有歧义）', '09:5'],
    ['带秒 14:00:00（粒度是分钟）', '14:00:00'],
    ['全角冒号 14：00', '14：00'],
    ['非数字 abc', 'abc'],
    ['空串', ''],
    ['只有小时 14', '14'],
    ['缺分钟 14:', '14:'],
    ['缺小时 :30', ':30'],
    ['全空白', '  '],
    ['负数 -1:00', '-1:00'],
    ['带正号 +1:00', '+1:00'],
    ['数字而非字符串', 840],
    ['null', null],
    ['undefined', undefined],
    ['对象', {}],
    ['数组', ['14:00']],
  ]

  it.each(invalid)('%s → undefined', (_label, value) => {
    expect(parseClockTime(value)).toBeUndefined()
  })
})

describe('B) withinAnyWindow —— 时刻 × 窗口', () => {
  const sameDay: WindowSpec[] = [{ start: '14:00', end: '18:00' }]
  const overnight: WindowSpec[] = [{ start: '22:00', end: '07:00' }]
  const empty: WindowSpec[] = []
  const zeroLength: WindowSpec[] = [{ start: '08:00', end: '08:00' }]
  const overlapping: WindowSpec[] = [
    { start: '09:00', end: '12:00' },
    { start: '11:00', end: '14:00' },
  ]
  const adjacent: WindowSpec[] = [
    { start: '09:00', end: '12:00' },
    { start: '12:00', end: '15:00' },
  ]
  const brokenPlusGood: WindowSpec[] = [
    { start: '25:00', end: '08:00' }, // 非法：整条跳过
    { start: '09:00', end: '12:00' },
  ]
  const mixed: WindowSpec[] = [
    { start: '14:00', end: '18:00' },
    { start: '22:00', end: '07:00' },
  ]

  const cases: Array<[string, WindowSpec[], Date, boolean]> = [
    // 同日窗口：[14:00, 18:00) 左闭右开
    ['同日 13:59 未开', sameDay, at(13, 59), false],
    ['同日 14:00 开（左闭）', sameDay, at(14, 0), true],
    ['同日 17:59 仍开', sameDay, at(17, 59), true],
    ['同日 18:00 关（右开）', sameDay, at(18, 0), false],
    ['同日 18:01 关', sameDay, at(18, 1), false],
    ['同日 00:00 关', sameDay, at(0, 0), false],
    // 秒不参与判定（分钟粒度）
    ['同日 13:59:59 仍关', sameDay, at(13, 59, 59), false],
    ['同日 14:00:59 仍开', sameDay, at(14, 0, 59), true],
    ['同日 17:59:59 仍开', sameDay, at(17, 59, 59), true],
    ['同日 18:00:00 已关', sameDay, at(18, 0, 0), false],
    // 跨天窗口：[22:00, 24:00) ∪ [00:00, 07:00)
    ['跨天 21:59 未开', overnight, at(21, 59), false],
    ['跨天 22:00 开', overnight, at(22, 0), true],
    ['跨天 23:30 开', overnight, at(23, 30), true],
    ['跨天 23:59 开', overnight, at(23, 59), true],
    ['跨天 00:00 仍开（午夜不抖）', overnight, at(0, 0), true],
    ['跨天 03:00 开', overnight, at(3, 0), true],
    ['跨天 06:30 开', overnight, at(6, 30), true],
    ['跨天 06:59 开', overnight, at(6, 59), true],
    ['跨天 07:00 关（右开）', overnight, at(7, 0), false],
    ['跨天 12:00 关', overnight, at(12, 0), false],
    // 空列表 / 零长度：fail-safe 恒关闭
    ['空列表 任何时刻关闭', empty, at(15, 0), false],
    ['零长度 08:00 关闭（start==end 不解释为全天）', zeroLength, at(8, 0), false],
    ['零长度 07:59 关闭', zeroLength, at(7, 59), false],
    ['零长度 08:01 关闭', zeroLength, at(8, 1), false],
    ['零长度 00:00 关闭', zeroLength, at(0, 0), false],
    // 多窗口重叠：取并集
    ['重叠 08:59 关', overlapping, at(8, 59), false],
    ['重叠 09:00 开（第一条左闭）', overlapping, at(9, 0), true],
    ['重叠 11:30 开（两窗都覆盖）', overlapping, at(11, 30), true],
    ['重叠 13:59 开（第二条）', overlapping, at(13, 59), true],
    ['重叠 14:00 关', overlapping, at(14, 0), false],
    // 相邻窗口：前一条的右开与后一条的左闭无缝衔接
    ['相邻 11:59 开', adjacent, at(11, 59), true],
    ['相邻 12:00 开（第二条左闭）', adjacent, at(12, 0), true],
    ['相邻 14:59 开', adjacent, at(14, 59), true],
    ['相邻 15:00 关', adjacent, at(15, 0), false],
    // 非法项跳过，但不影响同列表里的合法窗口
    ['非法+合法 06:00 关', brokenPlusGood, at(6, 0), false],
    ['非法+合法 10:00 开（合法那条生效）', brokenPlusGood, at(10, 0), true],
    ['非法+合法 13:00 关', brokenPlusGood, at(13, 0), false],
    // 同日窗 + 跨天窗混合
    ['混合 07:30 关（两窗都不在）', mixed, at(7, 30), false],
    ['混合 15:00 开（同日窗）', mixed, at(15, 0), true],
    ['混合 23:00 开（跨天窗）', mixed, at(23, 0), true],
  ]

  it.each(cases)('%s', (_label, windows, now, expected) => {
    expect(withinAnyWindow(now, windows)).toBe(expected)
  })
})

describe('C) minutesInWindow —— 非法窗口与"合法关闭"可区分', () => {
  it('非法时刻 → undefined（而不是 false）', () => {
    expect(minutesInWindow(600, { start: '25:00', end: '08:00' })).toBeUndefined()
    expect(minutesInWindow(600, { start: '09:00', end: '12:60' })).toBeUndefined()
  })

  it('合法但关闭 → false（与 undefined 严格区分）', () => {
    expect(minutesInWindow(600, { start: '14:00', end: '18:00' })).toBe(false)
  })

  it('合法且开放 → true', () => {
    expect(minutesInWindow(840, { start: '14:00', end: '18:00' })).toBe(true)
  })
})

describe('D) normalizeWindows —— 不可信输入过滤', () => {
  it('非数组 → 空列表（fail-safe：没有配置 = 不开放）', () => {
    for (const raw of [undefined, null, '14:00-18:00', {}, 42, true]) {
      expect(normalizeWindows(raw)).toEqual([])
    }
  })

  it('混合输入：只保留形状与格式都合法的项，"半个窗口"整条丢弃', () => {
    const raw = [
      { start: '09:00', end: '12:00' },
      { start: 'aa', end: '12:00' }, // start 非法 → 整条丢
      { start: '09:00' }, // 缺 end → 丢
      { start: '09:00', end: 1200 }, // end 非字符串 → 丢
      null,
      42,
      ['09:00', '12:00'], // 数组不是窗口对象 → 丢
      { start: ' 14:30 ', end: '18:00' }, // 空白可解析 → 保留（原文不动）
      { start: '22:00', end: '07:00' }, // 跨天 → 保留
    ]

    expect(normalizeWindows(raw)).toEqual([
      { start: '09:00', end: '12:00' },
      { start: ' 14:30 ', end: '18:00' },
      { start: '22:00', end: '07:00' },
    ])
  })

  it('空数组 → 空列表（显式的"全关"与缺省同义）', () => {
    expect(normalizeWindows([])).toEqual([])
  })
})