/**
 * 名字触发 + "她刚才听见了什么"（2026-10-01 新增的群聊档位）。
 *
 * 端到端跑真实 bridge 链路，盯四件事：
 *
 *   1. `groupTrigger: name` 时，**没被 @ 但文本里有名字**也会调用一次
 *   2. 调用时带上群里最近那几句 —— 而且必须是**被略过的那些**也在里面
 *      （缓冲喂在决策之前才有意义，这是这个功能的全部价值）
 *   3. 默认档（mention）与 `contextMessages: 0` 下，prompt 一个字节都不变
 *   4. 私聊不沾群上下文
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OWNER_QQ, BOT, GROUP, makeBridgeEnv, messageFrame, type BridgeEnv } from '../support/fake-bridge-env.ts'

const OTHER = '2991064865'
const THIRD = '3052887539'
const NAME_SESSION = `agent:${BOT}:group:${GROUP}`

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

/** 群里来一条消息（默认不 @ 谁）。 */
function said(e: BridgeEnv, userId: string, text: string): void {
  e.emit(messageFrame({ messageType: 'group', userId, groupId: GROUP, text }))
}

describe('T32 —— 名字触发那一档', () => {
  it('⭐ 没被 @，但文本里出现「小研」→ 照样调用一次', async () => {
    const e = await env({ config: { groupTrigger: 'name', nameWords: ['小研'], contextMessages: 10 } })
    e.agents.reply = '嗯？'

    said(e, OTHER, '小研你看这只猫')
    await e.settle()

    expect(e.agents.get(NAME_SESSION)?.asked).toHaveLength(1)
    expect(e.agents.get(NAME_SESSION)?.asked[0]).toContain('小研你看这只猫')
  })

  it('名字不出现的普通闲聊仍然潜水，且**不产生调用**', async () => {
    const e = await env({ config: { groupTrigger: 'name', nameWords: ['小研'], contextMessages: 10 } })
    e.agents.reply = '嗯？'

    said(e, OTHER, '今晚打游戏吗')
    said(e, THIRD, '带我一个')
    await e.settle()

    expect(e.agents.get(NAME_SESSION)).toBeUndefined()
  })

  it('被 @ 优先于名字（reason 走 mentioned 那条，不重复调用）', async () => {
    const e = await env({ config: { groupTrigger: 'name', nameWords: ['小研'], contextMessages: 10 } })
    e.emit(
      messageFrame({ messageType: 'group', userId: OTHER, groupId: GROUP, text: '小研在吗', at: BOT }),
    )
    await e.settle()

    expect(e.agents.get(NAME_SESSION)?.asked).toHaveLength(1)
  })
})

describe('T32 —— 她刚才听见了什么', () => {
  it('⭐ 调用时带上**被略过的那几句**，顺序是"旧 → 新"，且不含当前这条', async () => {
    const e = await env({ config: { groupTrigger: 'name', nameWords: ['小研'], contextMessages: 10 } })
    e.agents.reply = '在的'

    said(e, OTHER, '这只猫叫卡卡')
    said(e, THIRD, '它是白色的')
    await e.settle()
    said(e, OTHER, '小研你说是不是')
    await e.settle()

    const asked = e.agents.get(NAME_SESSION)?.asked[0] ?? ''
    expect(asked).toContain('你刚才听见群里说')
    expect(asked).toContain('这只猫叫卡卡')
    expect(asked).toContain('它是白色的')
    // 听见的话排在当前这条**之前**
    expect(asked.indexOf('这只猫叫卡卡')).toBeLessThan(asked.indexOf('小研你说是不是'))
  })

  it('超过上限只留最近的（群是无限流，不裁就是无界内存）', async () => {
    // 上限 3：灌进「甲乙丙丁」后缓冲是 [乙,丙,丁]；再发当前这条 → [乙,丙,丁,本条] → 裁成
    // [丙,丁,本条]，于是"听见的"只剩 [丙,丁] —— 甲和乙被裁掉了
    const e = await env({ config: { groupTrigger: 'name', nameWords: ['小研'], contextMessages: 3 } })
    e.agents.reply = '在的'

    for (const text of ['甲', '乙', '丙', '丁']) said(e, OTHER, text)
    await e.settle()
    said(e, OTHER, '小研呢')
    await e.settle()

    const asked = e.agents.get(NAME_SESSION)?.asked[0] ?? ''
    expect(asked).toContain('丙')
    expect(asked).toContain('丁')
    expect(asked).not.toContain('甲')
    expect(asked).not.toContain('乙')
  })

  it('⚠️ 默认档（mention + contextMessages=0）下 prompt 与从前逐字节一致', async () => {
    const plain = await env()
    plain.emit(messageFrame({ messageType: 'group', userId: OTHER, groupId: GROUP, text: '@小研 在吗', at: BOT }))
    await plain.settle()

    const withNameTrigger = await env({ config: { groupTrigger: 'name', nameWords: ['小研'], contextMessages: 0 } })
    withNameTrigger.emit(
      messageFrame({ messageType: 'group', userId: OTHER, groupId: GROUP, text: '@小研 在吗', at: BOT }),
    )
    await withNameTrigger.settle()

    const first = plain.agents.get(NAME_SESSION)?.asked[0] ?? ''
    const second = withNameTrigger.agents.get(NAME_SESSION)?.asked[0] ?? ''
    expect(first).toBe(second)
    expect(first).not.toContain('你刚才听见')
  })

  it('私聊不沾群上下文（那是两个频道，也不该互相漏话）', async () => {
    const e = await env({ config: { groupTrigger: 'name', nameWords: ['小研'], contextMessages: 10 } })
    e.agents.reply = '在的'

    said(e, OTHER, '群里才说的话')
    await e.settle()
    e.emit(messageFrame({ messageType: 'private', userId: OWNER_QQ, text: '小研在吗' }))
    await e.settle()

    const privateAsked = e.agents.get(`agent:${BOT}:private:${OWNER_QQ}`)?.asked[0] ?? ''
    expect(privateAsked).toContain('小研在吗')
    expect(privateAsked).not.toContain('群里才说的话')
  })
})
