/**
 * ReMe 回答拆分的用例（`src/memory/reme-answer.ts`）。
 *
 * 样本取自**真实后端**（2026-09-27 对 127.0.0.1:2333 的一次检索），
 * 只把正文截短 —— 头行的形态原样保留（那正是要测的东西）。
 */
import { describe, expect, it } from 'vitest'
import { splitRemeAnswer } from '../../src/memory/reme-answer.ts'

describe('拆命中头：来源 / 行号 / 分数都变得可用', () => {
  const real = [
    '========== daily/2026-09-26/xiaoyan-memory-recall-group-chat.md:54-140 [score=0.3065] ==========',
    '# 小研的记忆召回（群聊 3000000003）',
    '',
    '- 群 ID：3000000003',
    '',
    '========== daily/2026-09-27.md:1-20 [score=0.1234] ==========',
    '# 今天',
    '- 下午的光斜进来',
  ].join('\n')

  it('两条命中，各自带来源与行号与分数', () => {
    const hits = splitRemeAnswer(real)
    expect(hits).toHaveLength(2)

    expect(hits[0]?.source).toBe('daily/2026-09-26/xiaoyan-memory-recall-group-chat.md')
    expect(hits[0]?.lines).toEqual([54, 140])
    expect(hits[0]?.score).toBeCloseTo(0.3065)
    expect(hits[0]?.content).toContain('小研的记忆召回')
    expect(hits[0]?.content).not.toContain('=====') // 头行不留在正文里（列里已经有它）
    expect(hits[0]?.content).not.toContain('下午的光') // 不串到下一条

    expect(hits[1]?.source).toBe('daily/2026-09-27.md')
    expect(hits[1]?.lines).toEqual([1, 20])
    expect(hits[1]?.content).toContain('下午的光斜进来')
  })

  it('认不出一行头时退回"整段一条"（上游改格式 ≠ 她记性变差）', () => {
    const plain = '## 关于主人\n- 喜欢 某部番剧\n- 熬夜'
    expect(splitRemeAnswer(plain)).toEqual([{ content: plain, source: 'reme' }])
  })

  it('空/空白 → 空数组（正常的"没找到"）', () => {
    expect(splitRemeAnswer('')).toEqual([])
    expect(splitRemeAnswer('   \n  ')).toEqual([])
  })

  it('头行后面没有正文的那条被丢掉（不产生空记忆）', () => {
    const text = [
      '========== a.md:1-2 [score=0.5] ==========',
      '',
      '========== b.md:3-4 [score=0.4] ==========',
      '有正文',
    ].join('\n')
    const hits = splitRemeAnswer(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.source).toBe('b.md')
  })

  it('等号数量不同、分数是整数、路径里有冒号也能认', () => {
    const text = ['===== C:/x/y.md:7-9 [score=1] =====', '正文'].join('\n')
    const hits = splitRemeAnswer(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.source).toBe('C:/x/y.md')
    expect(hits[0]?.score).toBe(1)
  })

  it('普通文本里出现的 `====` 分隔线不会把整段切碎（要带 :行号 [score] 才认）', () => {
    const text = ['标题', '=====', '正文', '====='].join('\n')
    expect(splitRemeAnswer(text)).toEqual([{ content: text, source: 'reme' }])
  })
})