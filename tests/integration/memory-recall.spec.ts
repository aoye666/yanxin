/**
 * 召回接入对话（spec §8 的 T16·memory）—— 端到端，经真实的 bridge 链路。
 *
 * 用假装配体（`tests/support/fake-bridge-env.ts`）跑，但**记忆那一层是真的**
 * `MemoryService`（只把 provider 换成可编程的假实现）—— 这样"降级不阻塞对话"
 * 这条承诺才是被真的跑到，而不是被假服务假装满足。
 *
 * 覆盖 spec 的四条验收：
 *   1. 每轮前召回，结果进 prompt
 *   2. **召回为空时 prompt 与无记忆时逐字节一致**
 *   3. 写回按 `session_id` 交给 provider，且**不阻塞**回复
 *   4. 两模式的召回互通（同一 workspace，写回各用各的 session_id）
 */
import { afterEach, describe, expect, it } from 'vitest'
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

describe('T16 —— 召回进 prompt', () => {
  it('有记忆时，模型收到的那条消息里带上了记忆内容', async () => {
    const e = await env({ memory: { hits: ['爸爸是高三学生', '喜欢 MyGO'] } })
    e.agents.reply = '在的'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    const asked = e.agents.get(`agent:${BOT}:private:${OTHER}`)?.asked[0] ?? ''
    expect(asked).toContain('爸爸是高三学生')
    expect(asked).toContain('喜欢 MyGO')
    // 原消息仍在（记忆是**前缀**，不是替换）
    expect(asked).toContain('在吗')
  })

  it('⚠️ 召回为空时，prompt 与"根本没有记忆服务"时**逐字节一致**', async () => {
    const withEmptyRecall = await env({ memory: { hits: [] } })
    withEmptyRecall.agents.reply = '在的'
    withEmptyRecall.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await withEmptyRecall.settle()

    const withoutMemoryAtAll = await env() // 不装 memory 服务
    withoutMemoryAtAll.agents.reply = '在的'
    withoutMemoryAtAll.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await withoutMemoryAtAll.settle()

    const a = withEmptyRecall.agents.get(`agent:${BOT}:private:${OTHER}`)?.asked[0]
    const b = withoutMemoryAtAll.agents.get(`agent:${BOT}:private:${OTHER}`)?.asked[0]

    expect(a).toBeDefined()
    expect(a).toBe(b)
  })

  it('⚠️ 记忆后端坏掉时对话照常（降级，不阻塞）', async () => {
    const e = await env({ memory: { fail: true } })
    e.agents.reply = '在的'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    // 回了消息 —— 而且 prompt 里没有留下任何失败痕迹
    expect(e.onebot.calls).toHaveLength(1)
    const asked = e.agents.get(`agent:${BOT}:private:${OTHER}`)?.asked[0] ?? ''
    expect(asked).not.toContain('失败')
    expect(asked).not.toContain('记忆')
  })

  it('没有 memory 服务时也照常对话（记忆是增强，不是依赖）', async () => {
    const e = await env()
    e.agents.reply = '在的'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toHaveLength(1)
  })
})

describe('T16 —— 写回', () => {
  it('回合结束后按 `session_id` 写回这一轮的 user + assistant', async () => {
    const e = await env({ memory: { hits: ['一些旧记忆'] } })
    e.agents.reply = '在的'

    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '在吗' }))
    await e.settle()

    const recorded = e.memoryProvider?.recorded ?? []
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.sessionId).toBe(`agent:${BOT}:group:${GROUP}`)
    expect(recorded[0]?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(recorded[0]?.messages[1]?.content).toBe('在的')
  })

  it('⚠️ 写回的是**原始对话**，不含注入的记忆前缀（避免记忆自我强化）', async () => {
    const e = await env({ memory: { hits: ['爸爸喜欢 MyGO'] } })
    e.agents.reply = '在的'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    const userTurn = e.memoryProvider?.recorded[0]?.messages[0]?.content ?? ''
    // 若是把"模型看到的那一版"写回，召回内容会被再次沉淀 → 下轮又召回 → 内容重复累积。
    // 记忆的来源该是**真实对话**，不是我们注入进去的检索结果。
    expect(userTurn).not.toContain('爸爸喜欢 MyGO')
    expect(userTurn).toContain('在吗')
  })

  it('写回失败不影响回复（provider 坏掉时）', async () => {
    const e = await env({ memory: { fail: true } })
    e.agents.reply = '在的'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toHaveLength(1)
    expect(e.memoryProvider?.recorded ?? []).toHaveLength(0)
  })

  it('没有产出文本时不写回（没回消息就没有这一轮）', async () => {
    const e = await env({ memory: { hits: [] } })
    e.agents.reply = undefined

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.memoryProvider?.recorded ?? []).toHaveLength(0)
  })
})

describe('T16 —— 两模式写回分离、召回共享', () => {
  it('管理员私聊与群聊写回各自的 session_id', async () => {
    const e = await env({ memory: { hits: [] } })
    e.admin.admins.add(ALOYE)
    e.agents.reply = '在的'

    e.emit(messageFrame({ messageType: 'private', userId: ALOYE, text: '私聊' }))
    await e.settle()
    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '群里' }))
    await e.settle()

    const ids = (e.memoryProvider?.recorded ?? []).map((entry) => entry.sessionId)
    expect(ids).toEqual([`admin:${ALOYE}`, `agent:${BOT}:group:${GROUP}`])
  })

  it('召回不分模式 —— 两个会话用同一个 provider（同一 workspace）', async () => {
    const e = await env({ memory: { hits: ['世界里的经历'] } })
    e.admin.admins.add(ALOYE)
    e.agents.reply = '在的'

    e.emit(messageFrame({ messageType: 'private', userId: ALOYE, text: '私聊' }))
    await e.settle()
    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '群里' }))
    await e.settle()

    // 两个会话的首轮 prompt 都带上了同一份召回内容
    const adminAsked = e.agents.get(`admin:${ALOYE}`)?.asked[0] ?? ''
    const groupAsked = e.agents.get(`agent:${BOT}:group:${GROUP}`)?.asked[0] ?? ''
    expect(adminAsked).toContain('世界里的经历')
    expect(groupAsked).toContain('世界里的经历')
  })
})
