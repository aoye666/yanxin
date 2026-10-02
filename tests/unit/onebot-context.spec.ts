/**
 * 群里"她刚才听见了什么"的缓冲与注入（名字触发那档的配套）。
 *
 * 三条承诺各对应一处会出错的地方：
 *
 *   · **喂在决策之前**才有意义 —— 所以测"被略过的消息也在缓冲里"（那是这个功能的全部价值）
 *   · **空缓冲一个字节都不加** —— 与 `inject.ts` 同一条纪律，别给 prompt 塞空标题
 *   · **只留最近 N 条** —— 群是无限流的，不裁就是无界内存
 */
import { describe, expect, it } from 'vitest'
import { RecentChat, renderRecent, withContext } from '../../src/onebot/context.ts'

describe('RecentChat —— 环形缓冲', () => {
  it('⭐ 超出上限时丢最旧的，顺序保持"旧 → 新"', () => {
    const chat = new RecentChat(3)
    for (const text of ['a', 'b', 'c', 'd', 'e']) chat.push('group:1', { senderName: '某人', text })
    expect(chat.recent('group:1').map((line) => line.text)).toEqual(['c', 'd', 'e'])
  })

  it('按桶隔离：A 群的话不会漏进 B 群', () => {
    const chat = new RecentChat(5)
    chat.push('group:1', { senderName: '甲', text: '只给 1 群看' })
    chat.push('group:2', { senderName: '乙', text: '只给 2 群看' })
    expect(chat.recent('group:2').map((line) => line.text)).toEqual(['只给 2 群看'])
  })

  it('limit=0 等于不记（配置想关掉时不该留个空壳）', () => {
    const chat = new RecentChat(0)
    chat.push('group:1', { senderName: '甲', text: 'hi' })
    expect(chat.recent('group:1')).toEqual([])
  })

  it('⭐ beforeLast 排除当前这条 —— 它已经进缓冲了，不该在"刚才听见的"里重复', () => {
    const chat = new RecentChat(5)
    chat.push('group:1', { senderName: '甲', text: '前面那句' })
    chat.push('group:1', { senderName: '乙', text: '现在这条' })
    expect(chat.beforeLast('group:1').map((line) => line.text)).toEqual(['前面那句'])
  })

  it('recent 给的是副本：调用方 push 进返回值不影响内部状态', () => {
    const chat = new RecentChat(5)
    chat.push('group:1', { senderName: '甲', text: 'a' })
    chat.recent('group:1').push({ senderName: '伪造', text: 'b' })
    expect(chat.recent('group:1')).toHaveLength(1)
  })

  it('没听过的桶是空的，不是 undefined', () => {
    expect(new RecentChat(5).recent('group:999')).toEqual([])
  })
})

describe('renderRecent —— 措辞与"空即不加"', () => {
  it('⭐ 空数组 → 空串（这是"什么都没加"的信号）', () => {
    expect(renderRecent([])).toBe('')
  })

  it('全是空白文本也等于没听见（不留空标题）', () => {
    expect(renderRecent([{ senderName: '甲', text: '   ' }])).toBe('')
  })

  it('第一人称"你刚才听见"，不出现"上下文/历史/窗口"这类工程词', () => {
    const out = renderRecent([{ senderName: '小明', text: '今晚打游戏吗' }])
    expect(out).toContain('你刚才听见群里说')
    expect(out).toContain('- 小明：今晚打游戏吗')
    for (const word of ['上下文', '历史', '窗口', 'buffer', 'context']) expect(out).not.toContain(word)
  })

  it('每条一行，顺序与听见的一致', () => {
    const out = renderRecent([
      { senderName: '甲', text: '一' },
      { senderName: '乙', text: '二' },
    ])
    expect(out.indexOf('一')).toBeLessThan(out.indexOf('二'))
  })
})

describe('withContext —— 与 withMemories 同一条逐字节承诺', () => {
  it('⭐ 空上下文时原样返回（prompt 与从前逐字节一致）', () => {
    expect(withContext('小研你看这个', '')).toBe('小研你看这个')
  })

  it('有上下文时拼在前面，中间空一行', () => {
    expect(withContext('当前这条', '（背景）')).toBe('（背景）\n\n当前这条')
  })
})
