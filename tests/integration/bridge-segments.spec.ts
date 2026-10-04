/**
 * 分段发送的**投递侧**验收（配 `tests/unit/onebot-segments.spec.ts` 那半边"该发几条"）。
 *
 * 单元测试抽不到的东西都在这：真的调了几次 `send_*_msg`、每次什么参数、
 * 失败的那条会不会引发整体重发、dryRun 时是不是**一条都没出去**、群里 @ 是不是只挂在第一条。
 * 这几条的失败模式都是"发出去了但不对"或"该发的没发"，只有接上桥才看得见。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageStats } from '../../src/onebot/stats.ts'
import {
  ALOYE,
  BOT,
  GROUP,
  makeBridgeEnv,
  messageFrame,
  type BridgeEnv,
} from '../support/fake-bridge-env.ts'

const OTHER = '2000000003'

const opened: BridgeEnv[] = []

async function env(options?: Parameters<typeof makeBridgeEnv>[0]): Promise<BridgeEnv> {
  const built = await makeBridgeEnv(options)
  built.onebot.accounts.set(BOT, { selfId: BOT, preset: 'xiaoyan-agent' })
  opened.push(built)
  return built
}

afterEach(async () => {
  while (opened.length) await opened.pop()?.dispose()
})

/** 第 i 次调用发出去的那条文本（私聊只有一个 text 段）。 */
function privateText(e: BridgeEnv, index: number): string {
  const params = e.onebot.calls[index]?.params as { message: Array<{ type: string; data: { text?: string } }> }
  return params.message[0]?.data.text ?? ''
}

/** 第 i 次调用的消息段数组（群聊带 at，段型要看整串）。 */
function segmentsOf(e: BridgeEnv, index: number): Array<{ type: string; data: Record<string, string> }> {
  const params = e.onebot.calls[index]?.params as {
    message: Array<{ type: string; data: Record<string, string> }>
  }
  return params.message
}

describe('分段发送 —— 一条回复发成多条', () => {
  it('⭐ 引号行各成一条：两次 send_private_msg，内容是把外层引号去掉的那两句', async () => {
    const e = await env()
    e.agents.reply = '"笨蛋爸爸，大半夜的还在跟代码打架啊。"\n"先停一下，别急着改。"'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls.map((c) => c.action)).toEqual(['send_private_msg', 'send_private_msg'])
    expect(privateText(e, 0)).toBe('笨蛋爸爸，大半夜的还在跟代码打架啊。')
    expect(privateText(e, 1)).toBe('先停一下，别急着改。')
  })

  it('一个引号行都没有 → 还是一条（回退路径是今天的主路径）', async () => {
    const e = await env()
    e.agents.reply = '我觉得它应该完成了吧，要去看看吗'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toHaveLength(1)
    expect(privateText(e, 0)).toBe('我觉得它应该完成了吧，要去看看吗')
  })

  it('stripReplyQuotes=false 时引号原样发出去（外层引号去留是可配项）', async () => {
    const e = await env({ config: { stripReplyQuotes: false } })
    e.agents.reply = '"在的。"'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(privateText(e, 0)).toBe('"在的。"')
  })

  it('⭐ 群里 @ 只挂在第一条（每条都 @ 是骚扰）', async () => {
    const e = await env()
    e.agents.reply = '"在的。"\n"怎么啦？"'

    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '小研' }))
    await e.settle()

    expect(e.onebot.calls).toHaveLength(2)
    expect(segmentsOf(e, 0).map((s) => s.type)).toEqual(['at', 'text'])
    expect(segmentsOf(e, 1).map((s) => s.type)).toEqual(['text'])
  })

  it('拆成多条时按 replySegmentGapMs 隔开发（连着发会被 QQ 当成刷屏）', async () => {
    const e = await env({ config: { replySegmentGapMs: 40 } })
    e.agents.reply = '"一。"\n"二。"\n"三。"'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toHaveLength(3)
    // 下限留了余量（定时器粗于 1ms），但 30ms 足够说明"没有连着发"
    const times = e.onebot.times
    expect(times).toHaveLength(3)
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(30)
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBeGreaterThanOrEqual(30)
  })

  it('超出条数上限时尾部并进最后一条，且给一条 warn（不是丢掉）', async () => {
    const e = await env({ config: { maxReplySegments: 2 } })
    e.agents.reply = '"一。"\n"二。"\n"三。"\n"四。"'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toHaveLength(2)
    expect(privateText(e, 0)).toBe('一。')
    expect(privateText(e, 1)).toBe('二。\n三。\n四。')
  })

  it('⭐ 非文本段不被当文字切碎：图片 CQ 码整块发出去', async () => {
    const e = await env({ config: { maxReplyCharsPerSegment: 10 } })
    e.agents.reply = '看这张图[CQ:image,file=a.jpg]好看吧'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '有图吗' }))
    await e.settle()

    const sent = e.onebot.calls.map((_, index) => privateText(e, index)).join('')
    expect(sent).toBe('看这张图[CQ:image,file=a.jpg]好看吧')
    expect(e.onebot.calls.map((_, index) => privateText(e, index))).toContain('[CQ:image,file=a.jpg]')
  })

  it('dryRun 时一条都不发', async () => {
    const e = await env({ config: { dryRun: true } })
    e.agents.reply = '"一。"\n"二。"'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toEqual([])
  })

  it('⭐ 中间某条失败不整体重发：剩下的照发，出去过的不重复', async () => {
    const e = await env()
    e.agents.reply = '"一。"\n"二。"\n"三。"'
    e.onebot.failAt = [1] // 第二条发不出去

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    // 三次调用、内容各不同 —— 没有"把这轮重发一遍"
    expect(e.onebot.calls).toHaveLength(3)
    expect(new Set(e.onebot.calls.map((_, index) => privateText(e, index)))).toHaveLength(3)
  })

  it('总长上限截断时不发出半截的 CQ 码（那是乱码，不是消息）', async () => {
    const e = await env({ config: { maxReplyChars: 6 } })
    e.agents.reply = '一二三[CQ:image,file=a.jpg]'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '有图吗' }))
    await e.settle()

    expect(e.onebot.calls).toHaveLength(1)
    expect(privateText(e, 0)).toBe('一二三')
  })

  it('统计只记真的发出去的那几条（失败的是"想说但没说出去"）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yanxin-bridge-segments-'))
    const dbPath = join(dir, 'stats.db')
    const closer = MessageStats.open(dbPath)
    try {
      const e = await env({ config: { stats: true, statsPath: dbPath } })
      e.agents.reply = '"一。"\n"二。"\n"三。"'
      e.onebot.failAt = [1]

      e.emit(messageFrame({ messageType: 'private', userId: ALOYE, text: '在吗' }))
      await e.settle()

      expect(closer.overview().todayOut).toBe(2)
    } finally {
      closer.close()
      while (opened.length) await opened.pop()?.dispose()
      await new Promise((resolve) => setTimeout(resolve, 50))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
