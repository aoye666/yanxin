/**
 * 分段器（`src/onebot/segments.ts`）的验收。
 *
 * 这里只验"该发几条、各是什么"，不验投递（投递在桥那边，见 `bridge.spec.ts`）。
 * 三条重点各有一组用例，因为它们的**失败模式不一样**：
 *
 *   · 回退不成立 → 她**完全不回话**（静默，最严重）
 *   · 混合行丢内容 → 她真正想说的话被吞（不可逆）
 *   · CQ 段被切断 → 图 / @ 变成一堆乱码字（发出去了但坏了）
 */
import { describe, expect, it } from 'vitest'
import { clipTotal, planReply, REPLY_STRIP_QUOTES_DEFAULT, type ReplyPlanOptions } from '../../src/onebot/segments.ts'

const BASE: ReplyPlanOptions = {
  maxSegments: 4,
  maxCharsPerSegment: 200,
  stripQuotes: REPLY_STRIP_QUOTES_DEFAULT,
  mixed: 'keep-all',
}

const plan = (text: string, over: Partial<ReplyPlanOptions> = {}) => planReply(text, { ...BASE, ...over })

describe('引号行 = 一条消息', () => {
  it('⭐ 一行一句、整行包直引号时，每个引号行各成一条（默认去掉外层引号）', () => {
    const result = plan('"笨蛋爸爸，别熬夜了。"\n"这样吧，先停一下。"')

    expect(result.messages).toEqual(['笨蛋爸爸，别熬夜了。', '这样吧，先停一下。'])
    expect(result.fellBack).toBe(false)
  })

  it('引号只去最外一对：她话里的引号原样留着', () => {
    expect(plan('"她说「先停一下」，我就停了。"').messages).toEqual(['她说「先停一下」，我就停了。'])
  })

  it('stripQuotes=false 时外层引号保留（这是可配项，默认值才是"去掉"）', () => {
    expect(plan('"第一条"\n"第二条"', { stripQuotes: false }).messages).toEqual(['"第一条"', '"第二条"'])
  })

  it('行与行之间的空行不占一条（发出去不会是一条空白消息）', () => {
    expect(plan('"一"\n\n"二"').messages).toEqual(['一', '二'])
  })
})

describe('一个引号行都没有 —— 回退是一等公民', () => {
  it('⭐ 整条原样发出（不能变成"不回话"）', () => {
    const result = plan('我觉得它应该完成了吧\n要去看看吗')

    expect(result.fellBack).toBe(true)
    expect(result.messages).toEqual(['我觉得它应该完成了吧\n要去看看吗'])
  })

  it('回退的那条仍然受单条长度上限（按字切，不丢内容）', () => {
    const result = plan('一二三四五六七八九十', { maxCharsPerSegment: 4 })

    expect(result.fellBack).toBe(true)
    expect(result.messages.join('')).toBe('一二三四五六七八九十')
    expect(result.messages.every((entry) => entry.length <= 4)).toBe(true)
  })

  it('空回复 / 全空白 → 一条都不发（不是发一条空消息）', () => {
    expect(plan('').messages).toEqual([])
    expect(plan('   \n  ').messages).toEqual([])
  })
})

describe('引号行与裸行混在一起', () => {
  it('⭐ 默认 keep-all：裸行也发，排在引号行之后（内容一条不丢）', () => {
    const result = plan('"这是要发的。"\n这段没包引号，也发出去')

    expect(result.messages).toEqual(['这是要发的。', '这段没包引号，也发出去'])
  })

  it('quoted-only：只发引号行（裸行当独白吞掉 —— 要严格分行时才开）', () => {
    const result = plan('"这是要发的。"\n这段没包引号', { mixed: 'quoted-only' })

    expect(result.messages).toEqual(['这是要发的。'])
  })
})

describe('条数上限', () => {
  it('⭐ 超出上限时尾部**并进最后一条**，不是丢掉', () => {
    const result = plan('"一"\n"二"\n"三"\n"四"\n"五"', { maxSegments: 3 })

    expect(result.mergedOverflow).toBe(true)
    expect(result.messages).toEqual(['一', '二', '三\n四\n五'])
  })

  it('刚好到上限不合并（不触发 mergedOverflow）', () => {
    const result = plan('"一"\n"二"\n"三"', { maxSegments: 3 })

    expect(result.mergedOverflow).toBe(false)
    expect(result.messages).toEqual(['一', '二', '三'])
  })

  it('maxSegments 配成 0 也至少发一条 —— 静默不回话比少发严重', () => {
    expect(plan('"在的"').messages.length).toBe(1)
    expect(plan('"在的"', { maxSegments: 0 }).messages).toEqual(['在的'])
  })
})

describe('CQ 段是原子（按长度切不能把它切断）', () => {
  const image = '[CQ:image,file=abc.jpg]' // 23 字

  it('⭐ 图片码整块落在一条里，前后文本按上限排', () => {
    const result = plan(`看这张图${image}好看吧`, { maxCharsPerSegment: 10 })

    expect(result.messages.some((entry) => entry === image)).toBe(true)
    expect(result.messages.join('')).toBe(`看这张图${image}好看吧`)
    // 关键：没有任何一条把 CQ 码从中间切开
    for (const entry of result.messages) {
      const open = entry.split('[CQ:').length - 1
      expect(entry.split(']').length - 1 >= open).toBe(true)
    }
  })

  it('单段比上限还长时它自己一条（切了会坏段，只能超）', () => {
    const result = plan(`${image}${image}`, { maxCharsPerSegment: 5 })

    expect(result.messages).toEqual([image, image])
  })

  it('未闭合的 [CQ: 当普通文本（与 message.ts 的"不丢内容"同取向）', () => {
    // 上限压到 8 才会真的走按字切那条路 —— 否则整条不切，测不到这里
    const result = plan('这里有个半截的 [CQ:image,file=', { maxCharsPerSegment: 8 })

    expect(result.messages.join('')).toBe('这里有个半截的 [CQ:image,file=')
  })
})

describe('总长裁剪（maxReplyChars）也不切坏 CQ 段', () => {
  const image = '[CQ:image,file=a.jpg]' // 23 字

  it('普通文本按上限截', () => {
    expect(clipTotal('一二三四五六', 4)).toBe('一二三四')
    expect(clipTotal('短的', 100)).toBe('短的')
  })

  it('装不下的段整段留在外面，而不是切一半发出去', () => {
    expect(clipTotal(`一${image}二`, 3)).toBe('一')
    expect(clipTotal(`一${image}二`, image.length + 1)).toBe(`一${image}`)
  })

  it('开头那段本身就超上限时仍然发（切了会坏段，超一条更可恢复）', () => {
    expect(clipTotal(`${image}二`, 3)).toBe(image)
  })
})
