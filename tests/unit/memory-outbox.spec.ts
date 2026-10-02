/**
 * 写回 outbox 的攒批语义（T42）。
 *
 * 本文件**不起 Cordis Context**：`MemoryOutbox` 刻意做成纯 IO + 计数（`send`/`warn` 注入），
 * 就是为了能这样直接驱动 —— 攒批的正确性（阈值、串行、崩溃保留）不该被服务装配挡住。
 *
 * ⚠️ 全部写进 `mkdtemp` 临时目录。绝不许落到真实 `$DSH_HOME/yanxin/memory-outbox`：
 * 跑单测污染生产缓冲，症状是"她莫名记住了测试内容"。
 *
 * 关键不变量（逐条对应下面的用例）：
 *   · 未满阈值不打扰 provider；攒够才发**一次**，且带上全部轮次
 *   · `batchRounds = 1` 精确退化为旧的"每轮即写"
 *   · send 失败 → 缓冲**保留**（宁可下次重复发，不可丢整批）
 *   · session id 过 `remeSessionId`：原始值与净化值是**同一个** entry（否则重启后阈值分裂）
 *   · 同一 session 并发 append 不丢轮
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MemoryOutbox, outboxFileOf, type OutboxRound } from '../../src/memory/outbox.ts'

/** 一次沉淀调用的记录。 */
interface Sent {
  sessionId: string
  messages: string[]
}

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yanxin-outbox-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 造一条一轮轨迹（user + assistant），内容可辨认，便于断言顺序。 */
function round(tag: string) {
  return {
    messages: [
      { role: 'user' as const, content: `问-${tag}` },
      { role: 'assistant' as const, content: `答-${tag}` },
    ],
  }
}

/** 建一个 outbox，并把 send / warn 收集起来。 */
function harness(options: {
  rounds: number
  send?: (sessionId: string, count: number) => Promise<void>
}): { outbox: MemoryOutbox; sent: Sent[]; warns: string[] } {
  const sent: Sent[] = []
  const warns: string[] = []
  const outbox = new MemoryOutbox({
    dir,
    rounds: options.rounds,
    send: async (trajectory, sessionId) => {
      if (options.send !== undefined) await options.send(sessionId, sent.length)
      sent.push({ sessionId, messages: trajectory.messages.map((message) => message.content) })
    },
    warn: (message) => warns.push(message),
  })
  return { outbox, sent, warns }
}

/** 缓冲文件当前攒了几行（直接查盘，绕过内存计数）。 */
async function linesOnDisk(sessionId: string): Promise<string[]> {
  try {
    const raw = await readFile(outboxFileOf(dir, sessionId), 'utf8')
    return raw.split('\n').filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

describe('T42 —— 阈值与批量', () => {
  it('未满阈值不打扰 provider；攒够只发一次，且带全部轮次', async () => {
    const { outbox, sent } = harness({ rounds: 3 })

    await outbox.append('admin:1', round('a'))
    await outbox.append('admin:1', round('b'))
    expect(sent, '2/3 轮时不该发起沉淀').toEqual([])
    expect(outbox.pendingRounds('admin:1')).toBe(2)

    await outbox.append('admin:1', round('c'))
    await outbox.flush('admin:1') // 等链排空（append 内部是后台 flush）

    expect(sent).toHaveLength(1)
    expect(sent[0]?.messages).toEqual(['问-a', '答-a', '问-b', '答-b', '问-c', '答-c'])
    // ⚠️ 交给 provider 的是**原始** id（文件名只是存储键）—— 否则 `MemoryProvider`
    // 的契约会被攒批偷偷改掉，换一个需要原始 id 的后端时就露馅。
    expect(sent[0]?.sessionId).toBe('admin:1')
    expect(outbox.pendingRounds('admin:1')).toBe(0)
    await expect(linesOnDisk('admin:1')).resolves.toEqual([])
  })

  it('`batchRounds = 1` 精确退化为旧的"每轮即写"', async () => {
    const { outbox, sent } = harness({ rounds: 1 })

    await outbox.append('admin:1', round('a'))
    await outbox.append('admin:1', round('b'))
    await outbox.flush('admin:1')

    expect(sent.map((entry) => entry.messages)).toEqual([
      ['问-a', '答-a'],
      ['问-b', '答-b'],
    ])
  })

  it('不同 session 各攒各的，互不混批', async () => {
    const { outbox, sent } = harness({ rounds: 2 })

    await outbox.append('admin:1', round('私聊'))
    await outbox.append('agent:2:group:3', round('群聊'))
    expect(sent, '两个 session 各 1 轮，都不该触发').toEqual([])

    await outbox.append('admin:1', round('私聊2'))
    await outbox.flush('admin:1')

    // 只断言 admin 这一批：群聊那轮**不该被混进来**，仍单独在盘上。
    // （刻意不去 flush 群聊 —— `flush` 的语义是“未满批也强发”，那样会变成第二次 send，
    // 与本用例要证的“不混批”无关。）
    expect(sent).toHaveLength(1)
    expect(sent[0]?.sessionId).toBe('admin:1')
    expect(sent[0]?.messages).toEqual(['问-私聊', '答-私聊', '问-私聊2', '答-私聊2'])
    expect(await linesOnDisk('agent:2:group:3'), '群聊那轮仍单独攒着').toHaveLength(1)
    expect(outbox.pendingRounds('agent:2:group:3')).toBe(1)
  })

  it('同一 session 并发 append 不丢轮（串行链的作用）', async () => {
    const { outbox, sent } = harness({ rounds: 5 })

    await Promise.all([
      outbox.append('admin:1', round('1')),
      outbox.append('admin:1', round('2')),
      outbox.append('admin:1', round('3')),
      outbox.append('admin:1', round('4')),
      outbox.append('admin:1', round('5')),
    ])
    await outbox.flush('admin:1')

    expect(sent).toHaveLength(1)
    // 5 轮 × 2 条 = 10 条，一条都不能因为并发写盘而丢
    expect(sent[0]?.messages).toHaveLength(10)
    for (let i = 1; i <= 5; i += 1) {
      expect(sent[0]?.messages).toContain(`问-${i}`)
      expect(sent[0]?.messages).toContain(`答-${i}`)
    }
  })
})

describe('T42 —— 崩溃语义：宁可重复，不可丢', () => {
  it('send 抛错 → 缓冲原样保留 + warn 带原因（下次会连这批再发）', async () => {
    const failure = new Error('ReMe auto_memory 返回 HTTP 500')
    const { outbox, sent, warns } = harness({
      rounds: 10, // 高阈值：让它永不自动触发，只靠下面的手动 flush
      send: async () => {
        throw failure
      },
    })

    await outbox.append('admin:1', round('a'))
    await outbox.flush('admin:1')

    expect(sent, 'send 抛错了，不该记成已发出').toEqual([])
    expect(warns.join('\n')).toContain(failure.message)
    expect(await linesOnDisk('admin:1'), '缓冲必须还在').toHaveLength(1)
    expect(outbox.pendingRounds('admin:1')).toBe(1)
  })

  it('缓冲里混进半行 JSON（写盘被截断）→ 跳过它，不炸整批', async () => {
    await writeFile(outboxFileOf(dir, 'admin-1'), `${JSON.stringify(round('好1'))}\n{"ts":1,"mes\n`, 'utf8')
    const { outbox, sent } = harness({ rounds: 1 })

    await outbox.flush('admin:1')

    expect(sent).toHaveLength(1)
    expect(sent[0]?.messages).toEqual(['问-好1', '答-好1'])
  })

  it('⭐ 残片被**物理截断**：读一次之后，新 append 不粘在残片后面（一次撕裂写只丢一轮）', async () => {
    // 崩溃残片：一行完整 + 半行（没有换行）
    await writeFile(outboxFileOf(dir, 'admin-1'), `${JSON.stringify(round('好1'))}\n{"ts":1,"mes`, 'utf8')
    const { outbox } = harness({ rounds: 10 }) // 高阈值：recover 只读不冲

    await outbox.recover() // 读一次 —— 残片此刻被截掉
    await outbox.append('admin:1', round('好2'))

    // 修复前：append 粘在残片后（两行物理合并），新那轮也进不了沉淀
    const lines = await linesOnDisk('admin:1')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('provider 被卸下 → 沉淀延后且缓冲保留（不是"写回失败"）', async () => {
    // 复刻 MemoryService 注入的 send：取不到 active provider 时抛
    const { outbox, warns } = harness({
      rounds: 1,
      send: async () => {
        throw new Error('provider 已被卸下，本轮沉淀延后')
      },
    })

    await outbox.append('admin:1', round('a'))
    await outbox.flush('admin:1')

    expect(warns.join('\n')).toContain('沉淀延后')
    expect(await linesOnDisk('admin:1')).toHaveLength(1)
  })
})

describe('T42 —— session id 归一（重启不分裂）', () => {
  it('原始 `admin:1000000001` 写出的文件，能用净化后的 `admin-1000000001` 接着攒', async () => {
    const { outbox, sent } = harness({ rounds: 3 })

    await outbox.append('admin:1000000001', round('a'))
    // 重启后的世界：只剩净化值（recover 从文件名读出来的就是它）
    await outbox.recover()

    expect(outbox.pendingRounds('admin-1000000001'), '净化值必须看到同一份计数').toBe(1)
    expect(outbox.pendingRounds('admin:1000000001'), '两个写法必须是同一个 entry').toBe(1)

    await outbox.append('admin-1000000001', round('b'))
    await outbox.append('admin:1000000001', round('c'))
    await outbox.flush('admin:1000000001')

    expect(sent).toHaveLength(1)
    expect(sent[0]?.messages).toEqual(['问-a', '答-a', '问-b', '答-b', '问-c', '答-c'])
  })

  it('recover：已达阈值的残留补发（并恢复原始 id），未满的只恢复计数', async () => {
    await writeOutboxFile('admin-1', 2, 'admin:1000000001') // 阈值 2 → 该补发
    await writeOutboxFile('group-9', 1, 'group:9') // 阈值 2 → 只恢复

    const { outbox, sent } = harness({ rounds: 2 })
    await outbox.recover()

    expect(sent.map((entry) => entry.sessionId)).toEqual(['admin:1000000001'])
    expect(outbox.pendingRounds('group:9')).toBe(1)
    expect(await linesOnDisk('group:9'), '未满批的仍在盘上继续攒').toHaveLength(1)
  })

  it('目录不存在时 recover 安静返回（一条都没攒过是正常形态）', async () => {
    const { outbox, warns } = harness({ rounds: 2 })
    await rm(dir, { recursive: true, force: true })

    await expect(outbox.recover()).resolves.toBeUndefined()
    expect(warns, '没有残留不该产生噪声').toEqual([])
  })
})

/**
 * 用测试自己的目录布局写若干轮（形状与 `OutboxRound` 一致）。
 *
 * @param sessionFileStem 文件名（净化后的 id）
 * @param sessionId 写进记录里的**原始** id —— 模拟"上次崩溃前存的就是它"
 */
async function writeOutboxFile(sessionFileStem: string, count: number, sessionId: string): Promise<void> {
  const rounds: OutboxRound[] = Array.from({ length: count }, (_unused, index) => ({
    ts: 1_700_000_000_000 + index,
    sessionId,
    messages: [
      { role: 'user', content: `预置问-${index}` },
      { role: 'assistant', content: `预置答-${index}` },
    ],
  }))
  const body = rounds.map((entry) => JSON.stringify(entry)).join('\n')
  await writeFile(join(dir, `${sessionFileStem}.jsonl`), body === '' ? '' : `${body}\n`, 'utf8')
}
