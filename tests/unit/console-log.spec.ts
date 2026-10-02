/**
 * 日志页的纯函数验收：挑文件、切尾部、渲染区块。
 *
 * 真实 IO（扫 tmpdir）留给集成（console-pages.spec）—— 这里把"怎么挑、怎么切、
 * 怎么说"锁住，因为这三件事是这一页的全部逻辑。
 */
import { describe, expect, it } from 'vitest'
import { pickLogFile, renderLogBlocks, tailOf, type LogCandidate } from '../../src/console/pages/log.ts'

describe('挑日志文件：最新的 yanxin*.log 才是"当前轮"', () => {
  it('按 mtime 取最新（重启开新文件后自然跟上）', () => {
    const candidates: LogCandidate[] = [
      { name: 'yanxin-20261001P.log', mtimeMs: 1000 },
      { name: 'yanxin-20261001Q.log', mtimeMs: 3000 },
      { name: 'yanxin-20261001N.log', mtimeMs: 500 },
    ]
    expect(pickLogFile(candidates)?.name).toBe('yanxin-20261001Q.log')
  })

  it('空列表 → undefined（页面上如实说"没找到"）', () => {
    expect(pickLogFile([])).toBeUndefined()
  })

  it('文件名不参与排序：mtime 相同时随便一个都算对（稳定即可）', () => {
    const candidates: LogCandidate[] = [
      { name: 'yanxin-a.log', mtimeMs: 7 },
      { name: 'yanxin-b.log', mtimeMs: 7 },
    ]
    const picked = pickLogFile(candidates)
    expect(['yanxin-a.log', 'yanxin-b.log']).toContain(picked?.name)
  })
})

describe('切尾部：最后 N 行（结尾空行不算内容）', () => {
  it('行数足够 → 精确取最后 N 行', () => {
    const text = Array.from({ length: 300 }, (_, i) => `行 ${i}`).join('\n') + '\n'
    const { tail, lines } = tailOf(text, 150)
    expect(lines).toBe(150)
    expect(tail.split('\n')[0]).toBe('行 150')
    expect(tail.split('\n').at(-1)).toBe('行 299')
  })

  it('行数不足 → 全给（不凑空行）', () => {
    const { tail, lines } = tailOf('a\nb\n', 150)
    expect(lines).toBe(2)
    expect(tail).toBe('a\nb')
  })

  it('空文件 → 空串、0 行（不是 undefined，页面按空渲染）', () => {
    expect(tailOf('', 150)).toEqual({ tail: '', lines: 0 })
  })

  it('超长单行不截断（报错原因经常在长行里，横向滚动比看不到强）', () => {
    const long = 'x'.repeat(5000)
    const { tail, lines } = tailOf(`短行\n${long}\n`, 10)
    expect(lines).toBe(2)
    expect(tail).toContain(long)
  })
})

describe('渲染：有日志给 notice + stream 区块；没有给可操作的话', () => {
  it('找到文件：带路径、修改时间与流地址', () => {
    const blocks = renderLogBlocks(
      { file: '/tmp/yanxin-Q.log', mtimeText: '2026/10/1 17:27', tail: 'boot ok', lines: 1 },
      '/yanxin',
    )
    const text = JSON.stringify(blocks)
    expect(text).toContain('yanxin-Q.log')
    expect(text).toContain('17:27')
    expect(text).toContain('"kind":"stream"')
    expect(text).toContain('/yanxin/api/log/stream')
  })

  it('没找到：说清"哪种启动方式才有日志"，不装作页面坏了', () => {
    const text = JSON.stringify(renderLogBlocks({ file: undefined, mtimeText: '', tail: '', lines: 0 }, '/yanxin'))
    expect(text).toContain('没找到日志文件')
    expect(text).toContain('yanxin*.log')
  })
})
