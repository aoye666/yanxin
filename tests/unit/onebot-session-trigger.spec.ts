/**
 * session 命名 / 触发策略 / 消息渲染 / 回复抽取 的验收（T11 + T12 的纯逻辑部分）。
 *
 * 触发策略是**行为政策**，不是技术细节：它决定小研会不会在一个几百人的群里
 * 对每条消息都应答。所以这里用矩阵把所有分支钉住。
 */
import { describe, expect, it } from 'vitest'
import {
  buildReply,
  decideTrigger,
  extractAssistantTurn,
  renderInbound,
  sessionIdFor,
  type TriggerInput,
} from '../../src/onebot/session-trigger.ts'

const BOT = '2000000002'
const OWNER_QQ = '1000000001'

// ── session 命名 ──────────────────────────────────────────────────────

describe('sessionIdFor —— 记忆写回的粒度（spec §6.5）', () => {
  it.each([
    ['agent', 'group:3000000003', `agent:${BOT}:group:3000000003`],
    ['agent', 'private:1000000001', `agent:${BOT}:private:${OWNER_QQ}`],
    ['admin', 'private:1000000001', `admin:${OWNER_QQ}`],
    ['world', 'group:3000000003', `world:${BOT}`],
    ['world', 'private:1000000001', `world:${BOT}`],
  ] as const)('%s + %s → %s', (mode, channelSpec, expected) => {
    const [kind, id] = channelSpec.split(':') as ['group' | 'private', string]
    const channel = kind === 'group' ? ({ kind: 'group', groupId: id } as const) : ({ kind: 'private', userId: id } as const)
    expect(sessionIdFor(mode, BOT, channel)).toBe(expected)
  })

  it('不同群 → 不同 session（写回隔离）；同一群 → 同一 session', () => {
    const a = sessionIdFor('agent', BOT, { kind: 'group', groupId: '1' })
    const b = sessionIdFor('agent', BOT, { kind: 'group', groupId: '2' })
    const a2 = sessionIdFor('agent', BOT, { kind: 'group', groupId: '1' })
    expect(a).not.toBe(b)
    expect(a).toBe(a2)
  })

  it('admin 的 session 按【人】切而不按 bot 账号 —— 换账号不该换她的记忆', () => {
    const onBot1 = sessionIdFor('admin', '111', { kind: 'private', userId: OWNER_QQ })
    const onBot2 = sessionIdFor('admin', '222', { kind: 'private', userId: OWNER_QQ })
    expect(onBot1).toBe(onBot2)
  })

  it('world 是单一天然会话流，不按频道切', () => {
    const g = sessionIdFor('world', BOT, { kind: 'group', groupId: '1' })
    const p = sessionIdFor('world', BOT, { kind: 'private', userId: OWNER_QQ })
    expect(g).toBe(p)
  })

  it('三种模式的 session 互不冲突', () => {
    const channel = { kind: 'private', userId: OWNER_QQ } as const
    const ids = new Set([
      sessionIdFor('agent', BOT, channel),
      sessionIdFor('admin', BOT, channel),
      sessionIdFor('world', BOT, channel),
    ])
    expect(ids.size).toBe(3)
  })
})

// ── 触发策略 ──────────────────────────────────────────────────────────

function trigger(over: Partial<TriggerInput> = {}): TriggerInput {
  return {
    knownAccount: true,
    channel: { kind: 'group', groupId: '3000000003' },
    senderId: OWNER_QQ,
    selfId: BOT,
    at: [],
    atAll: false,
    text: '你好',
    groupTrigger: 'mention',
    ...over,
  }
}

describe('decideTrigger —— 私聊一律回应', () => {
  it('私聊（对方不是自己）→ 回应', () => {
    const d = decideTrigger(trigger({ channel: { kind: 'private', userId: OWNER_QQ } }))
    expect(d).toEqual({ respond: true, reason: 'private' })
  })

  it('群里没被 @ → 不回应（人格设定是"喜欢潜水"）', () => {
    const d = decideTrigger(trigger())
    expect(d.respond).toBe(false)
    if (!d.respond) expect(d.reason).toContain('没被 @')
  })
})

describe('decideTrigger —— 群聊只在被 @ 时回应', () => {
  it('被 @ → 回应', () => {
    expect(decideTrigger(trigger({ at: [BOT] }))).toEqual({ respond: true, reason: 'mentioned' })
  })

  it('被 @全体 → 回应', () => {
    expect(decideTrigger(trigger({ atAll: true }))).toEqual({ respond: true, reason: 'mentioned' })
  })

  it('@ 的是别人 → 不回应', () => {
    expect(decideTrigger(trigger({ at: ['123456'] })).respond).toBe(false)
  })

  it('同时 @ 了别人和自己 → 回应', () => {
    expect(decideTrigger(trigger({ at: ['123456', BOT] })).respond).toBe(true)
  })

  it('groupTrigger=never 时即使被 @ 也不回应', () => {
    const d = decideTrigger(trigger({ at: [BOT], groupTrigger: 'never' }))
    expect(d.respond).toBe(false)
    if (!d.respond) expect(d.reason).toContain('never')
  })

  it('groupTrigger=never 不影响私聊', () => {
    const d = decideTrigger(trigger({ channel: { kind: 'private', userId: OWNER_QQ }, groupTrigger: 'never' }))
    expect(d.respond).toBe(true)
  })
})

describe('decideTrigger —— groupTrigger=name：文本里出现名字也叫一次', () => {
  const named = { groupTrigger: 'name' as const, text: '小研你看这个', nameWords: ['小研'] }

  it('⭐ 没被 @ 但文本里有名字 → named（不是 mentioned）', () => {
    expect(decideTrigger(trigger(named))).toEqual({ respond: true, reason: 'named' })
  })

  it('被 @ 优先：仍是 mentioned', () => {
    expect(decideTrigger(trigger({ ...named, at: [BOT] }))).toEqual({ respond: true, reason: 'mentioned' })
  })

  it('名字都不出现 → 照旧潜水', () => {
    const d = decideTrigger(trigger({ groupTrigger: 'name', text: '今天猫好可爱', nameWords: ['小研'] }))
    expect(d.respond).toBe(false)
  })

  it('可配多个字样，空串不算（否则任何文本都命中）', () => {
    expect(decideTrigger(trigger({ ...named, nameWords: ['毕小研', '小研'] })).respond).toBe(true)
    expect(decideTrigger(trigger({ ...named, nameWords: ['毕小研'] })).respond).toBe(false)
    expect(decideTrigger(trigger({ ...named, nameWords: [''] })).respond).toBe(false)
    expect(decideTrigger(trigger({ ...named, nameWords: [] })).respond).toBe(false)
  })

  it('mention 档不受影响：有名字也不调用', () => {
    expect(decideTrigger(trigger({ text: '小研你看这个' })).respond).toBe(false)
  })

  it('never 仍然最高优先：有名字也不回应', () => {
    expect(decideTrigger(trigger({ ...named, groupTrigger: 'never' })).respond).toBe(false)
  })

  it('自己发的消息带自己名字 → 仍算自回环（不形成回环）', () => {
    const d = decideTrigger(trigger({ ...named, senderId: BOT }))
    expect(d.respond).toBe(false)
    if (!d.respond) expect(d.reason).toContain('自回环')
  })
})

describe('decideTrigger —— 自回环与未注册账号', () => {
  it('自己发的群消息 → 不回应（防御性，即使 OneBot 侧配了上报自身消息）', () => {
    const d = decideTrigger(trigger({ senderId: BOT, at: [BOT] }))
    expect(d.respond).toBe(false)
    if (!d.respond) expect(d.reason).toContain('自回环')
  })

  it('自己给自己私聊 → 不回应', () => {
    const d = decideTrigger(trigger({ channel: { kind: 'private', userId: BOT }, senderId: BOT }))
    expect(d.respond).toBe(false)
  })

  it('未注册账号 → 不回应（连接层已拒，这里是双保险）', () => {
    expect(decideTrigger(trigger({ knownAccount: false })).respond).toBe(false)
  })
})

// ── 渲染与投递 ────────────────────────────────────────────────────────

describe('renderInbound', () => {
  it('群消息带 [群 x · 昵称(id)] 前缀（模型需要知道谁在哪说）', () => {
    expect(
      renderInbound({
        channel: { kind: 'group', groupId: '3000000003' },
        senderId: OWNER_QQ,
        senderName: '鹤',
        text: '游戏好玩',
      }),
    ).toBe('[群 3000000003 · 鹤(1000000001)] 游戏好玩')
  })

  it('私聊带 [私聊 · …] 前缀', () => {
    expect(
      renderInbound({ channel: { kind: 'private', userId: OWNER_QQ }, senderId: OWNER_QQ, senderName: 'owner', text: '在吗' }),
    ).toBe('[私聊 · owner(1000000001)] 在吗')
  })

  it('昵称缺失时只用 id（sender 是尽力而为的字段）', () => {
    expect(
      renderInbound({ channel: { kind: 'private', userId: OWNER_QQ }, senderId: OWNER_QQ, text: '在吗' }),
    ).toBe('[私聊 · 1000000001] 在吗')
  })
})

describe('buildReply', () => {
  it('群回复带 at 段指向发送者（QQ 常规礼仪）', () => {
    const r = buildReply({ kind: 'group', groupId: '3000000003' }, '嗯，我看过了', { atSender: OWNER_QQ })
    expect(r.action).toBe('send_group_msg')
    expect(r.params).toEqual({
      group_id: 3000000003,
      message: [
        { type: 'at', data: { qq: OWNER_QQ } },
        { type: 'text', data: { text: ' 嗯，我看过了' } },
      ],
    })
  })

  it('群回复不给 at 时是纯文本段', () => {
    const r = buildReply({ kind: 'group', groupId: '1' }, '裸文本')
    expect(r.params.message).toEqual([{ type: 'text', data: { text: '裸文本' } }])
  })

  it('私聊用 send_private_msg，且不带 at', () => {
    const r = buildReply({ kind: 'private', userId: OWNER_QQ }, '在的', { atSender: OWNER_QQ })
    expect(r.action).toBe('send_private_msg')
    expect(r.params).toEqual({ user_id: Number(OWNER_QQ), message: [{ type: 'text', data: { text: '在的' } }] })
  })

  it('群号 / QQ 号被转成数字（规范要求 number）', () => {
    const g = buildReply({ kind: 'group', groupId: '3000000003' }, 'x')
    expect(typeof g.params.group_id).toBe('number')
    const p = buildReply({ kind: 'private', userId: OWNER_QQ }, 'x')
    expect(typeof p.params.user_id).toBe('number')
  })
})

// ── 回复抽取 ──────────────────────────────────────────────────────────

/** 造一条会话事件的简写。 */
const ev = (seq: number, type: string, data: unknown = {}): unknown => ({ seq, type, data })

const assistantMsg = (text: string): unknown => ({
  message: { content: [{ type: 'text', text }] },
})

describe('extractAssistantTurn —— 从会话事件里取本轮回复', () => {
  it('跳过 firstSeq 之前的历史', () => {
    const events = [
      ev(1, 'turn/start'),
      ev(2, 'assistant/message', assistantMsg('旧回复')),
      ev(10, 'turn/start'),
      ev(11, 'assistant/message', assistantMsg('新回复')),
    ]
    expect(extractAssistantTurn(events, 10).text).toBe('新回复')
  })

  it('turn/start 之前的事件不算（避免把上一轮的尾巴当本轮）', () => {
    const events = [ev(5, 'assistant/message', assistantMsg('上一轮的尾巴')), ev(6, 'turn/start'), ev(7, 'assistant/message', assistantMsg('本轮'))]
    expect(extractAssistantTurn(events, 4).text).toBe('本轮')
  })

  it('取最后一个非空 assistant/message（一轮里可能有多条，拼接会重复）', () => {
    const events = [
      ev(1, 'turn/start'),
      ev(2, 'assistant/message', assistantMsg('先想一下')),
      ev(3, 'assistant/message', assistantMsg('最终答案')),
    ]
    expect(extractAssistantTurn(events, 0).text).toBe('最终答案')
  })

  it('空文本不覆盖已有的非空文本', () => {
    const events = [
      ev(1, 'turn/start'),
      ev(2, 'assistant/message', assistantMsg('有内容')),
      ev(3, 'assistant/message', assistantMsg('')),
    ]
    expect(extractAssistantTurn(events, 0).text).toBe('有内容')
  })

  it('多段文本块被拼接', () => {
    const events = [
      ev(1, 'turn/start'),
      ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: '前' }, { type: 'text', text: '后' }] } }),
    ]
    expect(extractAssistantTurn(events, 0).text).toBe('前后')
  })

  it('非文本块被忽略', () => {
    const events = [
      ev(1, 'turn/start'),
      ev(2, 'assistant/message', { message: { content: [{ type: 'tool_use', id: 'x' }, { type: 'text', text: 'ok' }] } }),
    ]
    expect(extractAssistantTurn(events, 0).text).toBe('ok')
  })

  it('取到 turn/end 的 reason.kind', () => {
    const events = [ev(1, 'turn/start'), ev(2, 'assistant/message', assistantMsg('好了')), ev(3, 'turn/end', { reason: { kind: 'completed' } })]
    expect(extractAssistantTurn(events, 0).endedWith).toBe('completed')
  })

  it('error 结束带出可读错误信息', () => {
    const events = [
      ev(1, 'turn/start'),
      ev(2, 'turn/end', { reason: { kind: 'error', error: { message: 'provider 401' } } }),
    ]
    const t = extractAssistantTurn(events, 0)
    expect(t.endedWith).toBe('error')
    expect(t.errorText).toBe('provider 401')
  })

  it('没有 turn/start 时取不到文本（半截流不算一轮）', () => {
    expect(extractAssistantTurn([ev(1, 'assistant/message', assistantMsg('孤立的'))], 0).text).toBe('')
  })

  it('非法输入不抛异常', () => {
    for (const bad of [null, undefined, 42, 'x', {}, [null, 1, 'y']]) {
      expect(() => extractAssistantTurn(bad as unknown[], 0)).not.toThrow()
    }
    expect(extractAssistantTurn([], 0)).toEqual({ text: '', endedWith: undefined })
  })
})
