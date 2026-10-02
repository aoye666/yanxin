/**
 * 她的手机（T27b-5）的用例。
 *
 * 背景（2026-09-27 夜间隔离实例实测）：`observe()` 的 `focus:'phone'` 与 `BotLoop` 的
 * `phoneMessages()` 一直都在，只有引擎那一侧永远返回 `[]` —— 也就是说
 * **她看不到群里发生了什么**，而没人报错（空数组是合法的"手机里没消息"）。
 *
 * 所以这里盯三件事：
 *   1. **该进手机的进来**（群聊/私聊、昵称、文本）
 *   2. **不该进来的别进来**（她自己发的回声、非消息帧、空文本、重复 id）
 *   3. **换算成世界时刻**（`at`），以及限长（手机不是归档）
 */
import { describe, expect, it } from 'vitest'
import { isGroupMessage, PHONE_BUFFER, PhoneBuffer, phoneMessageOf, rawEventOf } from '../../src/world/phone.ts'

const SELF = '2000000002'

/**
 * 一条群消息帧 —— ⚠️ **必须是运行时真正给的形状**：`onebot/event` 发的是项目
 * 归一化后的 `EventFrame`（`{ kind, postType, selfId, raw }`），裸 OneBot 字段在 `raw` 里。
 * 一开始这里喂的是裸帧，于是单测全绿而线上手机永远空（2026-09-27 实测踩到）。
 */
function groupFrame(over: Record<string, unknown> = {}, rawOver: Record<string, unknown> = {}): unknown {
  return {
    kind: 'event',
    postType: 'message',
    selfId: SELF,
    raw: {
      post_type: 'message',
      message_type: 'group',
      group_id: 999000111,
      message_id: 4201,
      user_id: 1000000001,
      raw_message: '在吗',
      message: [{ type: 'text', data: { text: '在吗' } }],
      sender: { user_id: 1000000001, nickname: 'owner' },
      ...rawOver,
    },
    ...over,
  }
}

describe('A) 一帧 → 一条手机消息', () => {
  it('群消息：昵称 + 文本', () => {
    expect(phoneMessageOf(groupFrame(), SELF)).toEqual({ id: '4201', speaker: 'owner', text: '在吗' })
  })

  it('私聊消息也算（她自己账号收到的一切都在手机里）', () => {
    const frame = groupFrame({}, { message_type: 'private', group_id: undefined })
    expect(phoneMessageOf(frame, SELF)?.text).toBe('在吗')
  })

  it('没有昵称就用 QQ 号兜底（不编名字）', () => {
    const frame = groupFrame({}, { sender: { user_id: 1000000001 } })
    expect(phoneMessageOf(frame, SELF)?.speaker).toBe('QQ 1000000001')
  })

  it('@ 与图片被归一成文本（与桥同一套归一化）', () => {
    const frame = groupFrame(
      {},
      {
        message: [
          { type: 'at', data: { qq: '2000000002' } },
          { type: 'text', data: { text: ' 看看这个' } },
          { type: 'image', data: { file: 'x.jpg' } },
        ],
        raw_message: '[CQ:at,qq=2000000002] 看看这个[CQ:image,file=x.jpg]',
      },
    )
    const parsed = phoneMessageOf(frame, SELF)
    expect(parsed?.text).toContain('@2000000002')
    expect(parsed?.text).toContain('看看这个')
    expect(parsed?.text).toContain('[图片]')
  })

  it('裸帧也认（兼容：判据不依赖"一定包着 EventFrame"）', () => {
    const bare = {
      post_type: 'message',
      message_type: 'group',
      message_id: 777,
      user_id: 1000000001,
      sender: { nickname: 'owner' },
      message: [{ type: 'text', data: { text: '裸帧' } }],
    }
    expect(phoneMessageOf(bare, SELF)).toEqual({ id: '777', speaker: 'owner', text: '裸帧' })
  })

  it('⚠️ 形状错了要**看得出来**：EventFrame 里没有 raw 时按裸帧读（而不是静默当成非消息）', () => {
    // 这条守着那次踩坑：`onebot/event` 给的是 `{kind,postType,selfId,raw}`，
    // 早期按裸帧解析 ⇒ 手机永远空、打断永不触发，而且一声不响。
    expect(rawEventOf(groupFrame())).toMatchObject({ post_type: 'message' })
    expect(rawEventOf({ post_type: 'message' })).toMatchObject({ post_type: 'message' })
    expect(rawEventOf(null)).toBeUndefined()
  })

  const ignored: Array<[string, unknown]> = [
    ['她自己发的（出口回声）', groupFrame({}, { user_id: Number(SELF), sender: { user_id: Number(SELF), nickname: '小研' } })],
    ['不是消息帧（心跳/通知）', groupFrame({}, { post_type: 'meta_event', message_id: 1 })],
    ['缺 message_id', groupFrame({}, { message_id: undefined })],
    ['空文本（纯图片以外什么都没有）', groupFrame({}, { message: [], raw_message: '' })],
    ['非对象', '不是帧'],
    ['null', null],
  ]

  it.each(ignored)('不进手机：%s', (_label, frame) => {
    expect(phoneMessageOf(frame, SELF)).toBeUndefined()
  })

  it('群消息判据（打断只在群里触发）', () => {
    expect(isGroupMessage(groupFrame())).toBe(true)
    expect(isGroupMessage(groupFrame({}, { message_type: 'private' }))).toBe(false)
    expect(isGroupMessage(groupFrame({}, { post_type: 'meta_event' }))).toBe(false)
    expect(isGroupMessage(null)).toBe(false)
  })
})

describe('B) 缓冲：去重、限长、换算', () => {
  it('同一 id 只记一次', () => {
    const buffer = new PhoneBuffer()
    expect(buffer.remember(groupFrame(), SELF, 1_000)).toBe(true)
    expect(buffer.remember(groupFrame(), SELF, 2_000)).toBe(false)
    expect(buffer.list()).toHaveLength(1)
  })

  it('只留最近 PHONE_BUFFER 条（手机不是归档）', () => {
    const buffer = new PhoneBuffer()
    for (let index = 0; index < PHONE_BUFFER + 5; index += 1) {
      buffer.remember(groupFrame({}, { message_id: 5000 + index }), SELF, 1_000 + index)
    }
    const kept = buffer.list()
    expect(kept).toHaveLength(PHONE_BUFFER)
    // 留下的是**最近的**那批
    expect(kept[kept.length - 1]?.id).toBe(String(5000 + PHONE_BUFFER + 4))
  })

  it('看一眼手机不排空（历史还在）', () => {
    const buffer = new PhoneBuffer()
    buffer.remember(groupFrame(), SELF, 1_000)
    const clock = { genesisMs: 900_000 }
    expect(buffer.toPhoneMessages(clock)).toHaveLength(1)
    expect(buffer.toPhoneMessages(clock)).toHaveLength(1)
  })

  it('世界时刻 = (到达时刻 − 创世锚点)/1000，且不为负', () => {
    const buffer = new PhoneBuffer()
    buffer.remember(groupFrame(), SELF, 1_000_000)
    buffer.remember(groupFrame({}, { message_id: 4202 }), SELF, 800_000) // 早于锚点（异常输入）

    const [first, second] = buffer.toPhoneMessages({ genesisMs: 900_000 })
    expect(first?.at).toBe(100)
    expect(second?.at).toBe(0) // 不出现负数
  })

  it('拿不到锚点（世界还没打开）时返回空 —— 而不是假的 at', () => {
    const buffer = new PhoneBuffer()
    buffer.remember(groupFrame(), SELF, Date.now())
    expect(buffer.toPhoneMessages(undefined)).toEqual([])
  })
})