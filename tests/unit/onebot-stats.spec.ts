/**
 * 消息统计（SQLite）的验收 —— 仪表盘的数字必须是对的。
 *
 * 全部用 `:memory:`（快、不留盘）。这一层锁三件事：
 *   ① 记账与聚合一一对应（记几条数几条，today/total/分组不串）
 *   ② 按"本地自然日"聚合且**补零**（没消息的天也有行，趋势图不跳）
 *   ③ 它是旁路：record 永不抛（库坏了只 warn，聊天照常）
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageStats, type StatEntry } from '../../src/onebot/stats.ts'

const opened: MessageStats[] = []

afterEach(async () => {
  while (opened.length) opened.pop()?.close()
  vi.restoreAllMocks()
})

function entry(over: Partial<StatEntry> = {}): StatEntry {
  return { ts: Date.now(), direction: 'in', channel: 'group', groupId: '3000000003', sender: '1000000001', ...over }
}

describe('记账与聚合一一对应', () => {
  it('⭐ 记 N 条数 N 条：today / total / 触发数 / 群分布各归各位', () => {
    const stats = MessageStats.open(':memory:')
    opened.push(stats)

    stats.record(entry())                                                    // 群里被 @（触发）
    stats.record(entry({ responded: true }))                                 // 又一条触发
    stats.record(entry({ responded: false, sender: '2991064865' }))          // 没触发的潜水消息
    stats.record(entry({ direction: 'out' }))                                // 她的回复
    stats.record(entry({ direction: 'out' }))
    stats.record(entry({ channel: 'private', groupId: undefined, sender: '1000000001' })) // 私聊

    const overview = stats.overview()
    expect(overview.todayIn).toBe(4)
    // entry() 默认没带 responded（未触发），只有显式 responded:true 的那条算触发
    expect(overview.todayTriggered).toBe(1)
    expect(overview.todayOut).toBe(2)
    expect(overview.totalIn).toBe(4)
    expect(overview.totalOut).toBe(2)
    // 群分布只数 in 且有 groupId 的
    expect(overview.groups[0]).toEqual({ groupId: '3000000003', count: 3 })
  })

  it('自己的回声不进库是**桥的职责**，这里只保证按收到的记（不替上层过滤）', () => {
    const stats = MessageStats.open(':memory:')
    opened.push(stats)
    stats.record(entry({ sender: '2000000002' }))
    expect(stats.overview().totalIn).toBe(1)
  })
})

describe('按本地自然日聚合（补零）', () => {
  it('⭐ 近 7 天每天一行（没消息的天是 0），旧→新', () => {
    const stats = MessageStats.open(':memory:')
    opened.push(stats)

    // 一条 3 天前的消息 + 一条现在的
    stats.record(entry({ ts: Date.now() - 3 * 86_400_000 }))
    stats.record(entry({ direction: 'out', ts: Date.now() }))

    const days = stats.overview().days
    expect(days).toHaveLength(7)
    // 今天只有 out（那件 3 天前的事是 in）
    expect(days[6]?.outCount).toBe(1)
    expect(days[6]?.inCount).toBe(0)
    const threeDaysAgo = days[3]
    expect(threeDaysAgo?.inCount).toBeGreaterThanOrEqual(1)
    // 其余天补零
    expect(days[0]?.inCount).toBe(0)
  })

  it('overview 的 days 长度随 days 参数走', () => {
    const stats = MessageStats.open(':memory:')
    opened.push(stats)
    expect(stats.overview(3).days).toHaveLength(3)
  })
})

describe('旁路纪律：坏了只 warn，不抛', () => {
  it('⭐ 库关闭后 record 不抛（warn 限频：同分钟最多一条）', () => {
    const warns: string[] = []
    const stats = MessageStats.open(':memory:', { warn: (message) => warns.push(message) })
    stats.close()

    expect(() => {
      for (let index = 0; index < 5; index += 1) stats.record(entry())
    }).not.toThrow()
    expect(warns).toHaveLength(1) // 限频生效（不是 5 条）
  })

  it('overview 在读失败时给全零形状（页面显示"没有数据"而不是 500）', () => {
    const stats = MessageStats.open(':memory:')
    stats.close()
    const overview = stats.overview()
    expect(overview).toEqual({
      todayIn: 0,
      todayOut: 0,
      todayTriggered: 0,
      totalIn: 0,
      totalOut: 0,
      days: [],
      groups: [],
    })
  })
})

describe('文件库：重启后数据还在（落盘的意义）', () => {
  it('⭐ 记账 → 关闭 → 重新打开 → 总数还在', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yanxin-stats-'))
    const path = join(dir, 'stats.db')
    try {
      const first = MessageStats.open(path)
      first.record(entry())
      first.record(entry({ direction: 'out' }))
      first.close()

      // ⚠️ Windows 上"句柄还开着就删目录"是 EBUSY —— 断言完先关再删
      const second = MessageStats.open(path)
      const overview = second.overview()
      second.close()
      expect(overview.totalIn).toBe(1)
      expect(overview.totalOut).toBe(1)
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 50))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
