/**
 * OneBot v11 消息归一化的验收（T10）。
 *
 * 核心断言：**`array`（消息段数组）与 `string`（CQ 码）两种形态必须归一到完全相同的结构**。
 * 因为 `event.message_format` 由部署侧配置决定，我们无法假设是哪一种。
 */
import { describe, expect, it } from 'vitest'
import { normalizeMessage, parseCqString, unescapeCq } from '../../src/onebot/message.ts'

describe('⚠️ 核心：array 与 string 两态归一到同一结构', () => {
  const asArray = [
    { type: 'text', data: { text: '你好 ' } },
    { type: 'at', data: { qq: '1000000001' } },
    { type: 'text', data: { text: ' 看看这个' } },
    { type: 'image', data: { file: 'a.jpg' } },
  ]
  const asString = '你好 [CQ:at,qq=1000000001] 看看这个[CQ:image,file=a.jpg]'

  it('两种形态的 text / at / images 完全一致', () => {
    const a = normalizeMessage(asArray, 'raw')
    const b = normalizeMessage(asString, 'raw')

    expect(a.text).toBe(b.text)
    expect(a.text).toBe('你好 @1000000001 看看这个[图片]')
    expect(a.at).toEqual(b.at)
    expect(a.at).toEqual(['1000000001'])
    expect(a.images).toEqual(b.images)
    expect(a.images).toEqual(['a.jpg'])
    expect(a.atAll).toBe(b.atAll)
    expect(a.replyTo).toBe(b.replyTo)
    expect(a.segments).toEqual(b.segments)
  })

  it('raw_message 原样带出', () => {
    expect(normalizeMessage(asArray, '原始串').raw).toBe('原始串')
    expect(normalizeMessage(asString, '原始串').raw).toBe('原始串')
  })
})

describe('CQ 码转义 —— 解码顺序有讲究', () => {
  it('&amp;#91; 应解码为字面量 &#91;，而不是 [', () => {
    // 若先解 &#91; 再解 &amp;，会得到 "&[" —— 语义错了
    expect(unescapeCq('&amp;#91;')).toBe('&#91;')
  })

  it('三种转义各自解码', () => {
    expect(unescapeCq('&#91;')).toBe('[')
    expect(unescapeCq('&#93;')).toBe(']')
    expect(unescapeCq('&#44;')).toBe(',')
    expect(unescapeCq('&amp;')).toBe('&')
  })

  it('参数里转义过的逗号不会被当作键值分隔符', () => {
    const parsed = parseCqString('[CQ:text,text=a&#44;b,c=d]')
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual({ type: 'text', data: { text: 'a,b', c: 'd' } })
  })

  it('参数里转义过的方括号不会截断 CQ 码', () => {
    const parsed = parseCqString('[CQ:text,text=&#91;不是CQ&#93;]')
    expect(parsed).toEqual([{ type: 'text', data: { text: '[不是CQ]' } }])
  })
})

describe('parseCqString —— 边界', () => {
  it('纯文本无 CQ 码', () => {
    expect(parseCqString('就是一句话')).toEqual([{ type: 'text', data: { text: '就是一句话' } }])
  })

  it('空串', () => {
    expect(parseCqString('')).toEqual([])
  })

  it('未闭合的 [CQ: 当纯文本，不丢内容', () => {
    expect(parseCqString('前面[CQ:at,qq=123')).toEqual([
      { type: 'text', data: { text: '前面' } },
      { type: 'text', data: { text: '[CQ:at,qq=123' } },
    ])
  })

  it('无参数段的 CQ 码', () => {
    expect(parseCqString('[CQ:shake]')).toEqual([{ type: 'shake', data: {} }])
  })

  it('多个 CQ 码连续', () => {
    const parsed = parseCqString('[CQ:at,qq=1][CQ:at,qq=2]')
    expect(parsed).toEqual([
      { type: 'at', data: { qq: '1' } },
      { type: 'at', data: { qq: '2' } },
    ])
  })
})

describe('normalizeMessage —— 结构化事实', () => {
  it('at 全体成员进 atAll，不进 at 列表', () => {
    const m = normalizeMessage([{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '在吗' } }])
    expect(m.atAll).toBe(true)
    expect(m.at).toEqual([])
    expect(m.text).toBe('@全体成员在吗')
  })

  it('多个 at 保序', () => {
    const m = normalizeMessage([
      { type: 'at', data: { qq: '111' } },
      { type: 'at', data: { qq: '222' } },
    ])
    expect(m.at).toEqual(['111', '222'])
  })

  it('reply 段被取出，且不占正文位置', () => {
    const m = normalizeMessage([
      { type: 'reply', data: { id: '99' } },
      { type: 'text', data: { text: '同意' } },
    ])
    expect(m.replyTo).toBe('99')
    expect(m.text).toBe('同意')
  })

  it('多个 reply 只取第一个', () => {
    const m = normalizeMessage([
      { type: 'reply', data: { id: '1' } },
      { type: 'reply', data: { id: '2' } },
    ])
    expect(m.replyTo).toBe('1')
  })

  it('image 的 url 可选', () => {
    const m = normalizeMessage([
      { type: 'image', data: { file: 'a.jpg', url: 'https://x/a.jpg' } },
      { type: 'image', data: { file: 'b.jpg' } },
    ])
    expect(m.images).toEqual(['a.jpg', 'b.jpg'])
    expect(m.segments[0]).toEqual({ kind: 'image', file: 'a.jpg', url: 'https://x/a.jpg' })
    expect(m.segments[1]).toEqual({ kind: 'image', file: 'b.jpg' })
  })

  it('face 段渲染为 [表情]', () => {
    expect(normalizeMessage([{ type: 'face', data: { id: '123' } }]).text).toBe('[表情]')
  })

  it('未识别的类型落到 other，不丢弃', () => {
    const m = normalizeMessage([{ type: 'json', data: { data: '{}' } }])
    expect(m.segments[0]).toEqual({ kind: 'other', type: 'json', data: { data: '{}' } })
    expect(m.text).toBe('[json]')
  })
})

describe('normalizeMessage —— 非法输入不抛异常', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['数字', 42],
    ['空数组', []],
    ['对象（非法形态）', { type: 'text' }],
  ])('%s → 空结果', (_label, value) => {
    const m = normalizeMessage(value)
    expect(m.segments).toEqual([])
    expect(m.text).toBe('')
    expect(m.at).toEqual([])
    expect(m.atAll).toBe(false)
    expect(m.replyTo).toBeUndefined()
    expect(m.images).toEqual([])
  })

  it('数组里夹杂非对象项时跳过，不抛异常', () => {
    const m = normalizeMessage([null, 1, 'x', { type: 'text', data: { text: 'ok' } }])
    expect(m.text).toBe('ok')
  })

  it('段里 data 缺失或非对象时按空处理', () => {
    const m = normalizeMessage([{ type: 'at' }, { type: 'text', data: null }, { type: 'text', data: [] }])
    expect(m.segments).toHaveLength(3)
    expect(m.at).toEqual([])
  })

  it('data 里数值被字符串化（规范说参数值几乎都是字符串，但不保证）', () => {
    const m = normalizeMessage([{ type: 'at', data: { qq: 12345 } }])
    expect(m.at).toEqual(['12345'])
  })
})
