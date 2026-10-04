/**
 * 合并转发的**接线**验收（展开逻辑本身在 `tests/unit/onebot-forward.spec.ts`）。
 *
 * 这里只回答三个问题：转发的内容有没有真的进到她那一轮的正文里、
 * 拉不到的时候消息会不会被整条丢掉、没有转发的普通消息有没有白白多打一次 API。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOT,
  GROUP,
  makeBridgeEnv,
  messageFrame,
  type BridgeEnv,
} from '../support/fake-bridge-env.ts'

const OTHER = '2000000003'
const GROUP_SESSION = `agent:${BOT}:group:${GROUP}`
const PRIVATE_SESSION = `agent:${BOT}:private:${OTHER}`

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

/** 她这一轮实际被问到的正文（按 session 取 —— asked 挂在 agent 上，不在注册表上）。 */
function askedOf(e: BridgeEnv, sessionId: string): string {
  return (e.agents.get(sessionId)?.asked ?? []).join('\n')
}

const FORWARD = { type: 'forward', data: { id: '7788' } }

const officialNodes = {
  messages: [
    {
      type: 'node',
      data: {
        user_id: 10001,
        nickname: '张三',
        time: 1_759_572_180,
        content: [{ type: 'text', data: { text: '今晚八点开门' } }],
      },
    },
    {
      type: 'node',
      data: { user_id: 10002, nickname: '李四', content: [{ type: 'text', data: { text: '带猫来' } }] },
    },
  ],
}

describe('合并转发进她的正文', () => {
  it('⭐ 群里 @ 她 + 一条合并转发：她读到的是"谁在什么时候说了什么"，不是 [forward]', async () => {
    const e = await env()
    e.onebot.forwardResult = officialNodes
    e.agents.reply = '看到了'

    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '帮我看看这个', extraSegments: [FORWARD] }))
    await e.settle()

    const text = askedOf(e, GROUP_SESSION)
    expect(text).toContain('- 张三')
    expect(text).toContain('今晚八点开门')
    expect(text).toContain('- 李四：带猫来')
    expect(text).toContain('帮我看看这个')
    expect(text).not.toContain('[forward]')
    expect(e.onebot.calls[0]).toEqual({ selfId: BOT, action: 'get_forward_msg', params: { message_id: '7788' } })
  })

  it('数组形态自带内联节点时**不**再发一次 API（少一次往返）', async () => {
    const e = await env()
    e.agents.reply = '嗯'

    e.emit(
      messageFrame({
        messageType: 'private',
        userId: OTHER,
        text: '看看',
        extraSegments: [{ type: 'forward', data: { id: '7788', content: officialNodes.messages } }],
      }),
    )
    await e.settle()

    expect(e.onebot.calls.map((c) => c.action)).toEqual(['send_private_msg'])
    expect(askedOf(e, PRIVATE_SESSION)).toContain('今晚八点开门')
  })

  it('⭐ 拉不到也不吞消息：正文留占位符，这一轮照常跑', async () => {
    const e = await env()
    e.onebot.failAt = [0] // 第一次调用就是 get_forward_msg
    e.agents.reply = '没打开'

    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '帮我看看这个', extraSegments: [FORWARD] }))
    await e.settle()

    const text = askedOf(e, GROUP_SESSION)
    expect(text).toContain('[forward]') // 占位符还在：她知道"这里有一条没打开的转发"
    expect(text).toContain('帮我看看这个')
    expect(e.onebot.calls.map((c) => c.action)).toContain('send_group_msg')
  })

  it('普通消息不发 get_forward_msg（不是每条消息都多一次网络往返）', async () => {
    const e = await env()
    e.agents.reply = '在'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls.map((c) => c.action)).toEqual(['send_private_msg'])
  })

  it('转发正文里出现她的名字 → 算"被叫到"（展开在触发判定之前）', async () => {
    const e = await env({ config: { groupTrigger: 'name' } })
    e.onebot.forwardResult = {
      messages: [{ user_id: 1, nickname: '路人', content: [{ type: 'text', data: { text: '小研最近怎么不说话' } }] }],
    }
    e.agents.reply = '我在呀'

    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, text: '转发一段聊天记录', extraSegments: [FORWARD] }))
    await e.settle()

    expect(askedOf(e, GROUP_SESSION)).toContain('小研最近怎么不说话')
  })
})
