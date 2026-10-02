/**
 * 发射闸门的验收（T23，spec §6.8）。
 *
 * 三个承诺：
 *
 *   ① **提交前零发射**：闸门与内核是"先落盘、后出口"的关系 —— 这里用真内核
 *      （`WorldKernel`）验证：`submit` 失败/未调用时，`deliver` 通道零调用。
 *   ② **恰好一次**：按 utterance id 幂等，跨重启也成立（回执落盘）。
 *   ③ **失败不当作成功、不重试**：失败记回执 + 告警，但**不重发** ——
 *      重试可能让群里看到两遍，对外可见的重复无法收回。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldKernel } from '../../src/world/kernel.ts'
import { OUTBOX_FILE, WorldOutbox, type OutboxItem } from '../../src/world/outbox.ts'
import type { TransactionProposal, Utterance } from '../../src/world/state.ts'

const dirs: string[] = []
const warnings: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
  warnings.length = 0
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yanxin-outbox-'))
  dirs.push(dir)
  return dir
}

/** 收集"发出去了什么"的假通道。 */
function collector(options: { fail?: (item: OutboxItem) => boolean } = {}) {
  const sent: OutboxItem[] = []
  const deliver = async (item: OutboxItem): Promise<void> => {
    if (options.fail?.(item) === true) throw new Error(`投递被拒：${item.id}`)
    sent.push(item)
  }
  return { sent, deliver }
}

function utterance(id: string, text: string, extra: Partial<Utterance> = {}): Utterance {
  return { id, speakerId: 'bot', text, at: 100, ...extra }
}

describe('T23 —— 提交前零发射（output commit）', () => {
  it('⭐ 只提交、不调 deliver → 通道零调用；提交成功后才发', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    const { sent, deliver } = collector()
    const outbox = await WorldOutbox.open(dir, { deliver, warn: (m) => warnings.push(m) })

    // 创世 + 一条 say（提交进日志，但**还没发**）
    const genesis: TransactionProposal = {
      idempotencyKey: 'g1',
      operations: [
        { op: 'create', entity: { id: 'bot', kind: 'actor', name: '小研', location: null } },
        { op: 'say', actorId: 'bot', text: '今天街上风很大' },
      ],
    }
    await kernel.submit(genesis)

    expect(sent).toEqual([]) // 提交本身不发射 —— 闸门没被调用
    expect(kernel.snapshot.utterances).toHaveLength(1) // 但"这件事"已经在日志里了

    // 闸门发出（接线在 T27：提交之后调用）
    await outbox.deliver(kernel.snapshot.utterances)
    expect(sent.map((item) => item.text)).toEqual(['今天街上风很大'])
  })

  it('⭐ 提案被内核拒绝 → 一个字节都没出去（失败在落盘之前拦下）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    const { sent, deliver } = collector()
    const outbox = await WorldOutbox.open(dir, { deliver, warn: (m) => warnings.push(m) })

    await expect(
      kernel.submit({ idempotencyKey: 'bad', operations: [{ op: 'say', actorId: '不存在的人', text: '你好' }] }),
    ).rejects.toThrow()
    // 被拒的提案没有进快照 → 也没有东西可发
    await outbox.deliver(kernel.snapshot.utterances)
    expect(sent).toEqual([])
  })
})

describe('T23 —— 恰好一次（幂等）', () => {
  it('⭐ 同一批 utterances 发两次 → 第二次一条都不重发', async () => {
    const dir = await makeDir()
    const { sent, deliver } = collector()
    const outbox = await WorldOutbox.open(dir, { deliver, warn: (m) => warnings.push(m) })

    const batch = [utterance('1:0', '嗯？'), utterance('1:1', '在的哦')]
    const first = await outbox.deliver(batch)
    const second = await outbox.deliver(batch)

    expect(first.map((r) => r.status)).toEqual(['delivered', 'delivered'])
    expect(second).toEqual([]) // 全跳过
    expect(sent).toHaveLength(2)
    expect(outbox.deliveredCount).toBe(2)
  })

  it('⭐ 跨重启幂等：重开闸门后已发的仍不重发（回执落盘）', async () => {
    const dir = await makeDir()
    const first = collector()
    const firstOutbox = await WorldOutbox.open(dir, { deliver: first.deliver, warn: (m) => warnings.push(m) })
    await firstOutbox.deliver([utterance('1:0', '记住了')])

    const second = collector()
    const secondOutbox = await WorldOutbox.open(dir, { deliver: second.deliver, warn: (m) => warnings.push(m) })
    await secondOutbox.deliver([utterance('1:0', '记住了')])

    expect(first.sent).toHaveLength(1)
    expect(second.sent).toEqual([]) // 重启后依然不重发
    expect(secondOutbox.deliveredCount).toBe(1)

    const raw = JSON.parse(await readFile(join(dir, OUTBOX_FILE), 'utf8')) as { receipts: unknown[] }
    expect(raw.receipts).toHaveLength(1)
  })

  it('新的一条（新 id）会正常发出 —— 幂等不会误伤后来的话', async () => {
    const dir = await makeDir()
    const { sent, deliver } = collector()
    const outbox = await WorldOutbox.open(dir, { deliver, warn: (m) => warnings.push(m) })

    await outbox.deliver([utterance('1:0', '第一句')])
    await outbox.deliver([utterance('2:0', '第二句')])

    expect(sent.map((item) => item.text)).toEqual(['第一句', '第二句'])
  })
})

describe('T23 —— 失败不当作成功、不重试', () => {
  it('⭐ 投递失败 → 记 failed 回执 + 告警；再发一次也不重试', async () => {
    const dir = await makeDir()
    const { sent, deliver } = collector({ fail: (item) => item.text === '会失败的' })
    const outbox = await WorldOutbox.open(dir, { deliver, warn: (m) => warnings.push(m) })

    const batch = [utterance('1:0', '会失败的'), utterance('1:1', '这条没事')]
    const receipts = await outbox.deliver(batch)

    expect(receipts.map((r) => r.status)).toEqual(['failed', 'delivered']) // 逐条独立
    expect(receipts[0]?.reason).toContain('投递被拒')
    expect(sent.map((item) => item.text)).toEqual(['这条没事']) // 失败的那条没发出去
    expect(warnings.some((m) => m.includes('发射失败'))).toBe(true)

    // 再调一次：失败的**不重试**（否则群里可能看到两遍）
    const again = await outbox.deliver(batch)
    expect(again).toEqual([])
    expect(sent).toHaveLength(1)
  })

  it('失败的回执会落盘（她下次感知能读到"那句话没说出去"）', async () => {
    const dir = await makeDir()
    const { deliver } = collector({ fail: () => true })
    const outbox = await WorldOutbox.open(dir, { deliver, warn: (m) => warnings.push(m) })
    await outbox.deliver([utterance('1:0', '你好')])

    const raw = JSON.parse(await readFile(join(dir, OUTBOX_FILE), 'utf8')) as {
      receipts: { id: string; status: string }[]
    }
    expect(raw.receipts[0]?.status).toBe('failed')
  })

  it('失败的 id 落定（不进"成功"计数，但换来"不再重投"）', async () => {
    const dir = await makeDir()
    const { sent, deliver } = collector({ fail: (item) => item.id === '1:0' })
    const outbox = await WorldOutbox.open(dir, { deliver, warn: (m) => warnings.push(m) })

    await outbox.deliver([utterance('1:0', '失败的')])
    expect(outbox.deliveredCount).toBe(0) // 没有一条成功过

    // 重开：failed 回执仍在表里 → 仍然不重发（判据是"有没有回执"，不是"成没成功"）
    const reopened = await WorldOutbox.open(dir, { deliver, warn: (m) => warnings.push(m) })
    const receipts = await reopened.deliver([utterance('1:0', '失败的')])
    expect(receipts).toEqual([]) // 连回执都不再产生 —— 投递机会已经用完了
    expect(sent).toEqual([])
  })
})

describe('T23 —— 回执可读（给观测投影用）', () => {
  it('recent() 给出最近回执；audience 随条目带走', async () => {
    const dir = await makeDir()
    const { sent, deliver } = collector()
    const outbox = await WorldOutbox.open(dir, { deliver, warn: (m) => warnings.push(m) })

    await outbox.deliver([utterance('1:0', '早上好', { audience: ['group:3000000003'] })])

    expect(sent[0]?.audience).toEqual(['group:3000000003'])
    expect(outbox.recent(5)).toHaveLength(1)
    expect(outbox.recent(5)[0]?.id).toBe('1:0')
  })
})