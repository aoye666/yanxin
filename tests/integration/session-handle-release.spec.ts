/**
 * 释放会话句柄必须**等到它真的从 store 里摘掉**（2026-10-04 线上 50 次静默的根因）。
 *
 * ## 症状与真因
 *
 * ```
 * [W] one-bot-bridge [yanxin-bridge] 会话 agent:…:private:… 处理失败：
 *     session "agent:…:private:…" already exists
 * ```
 *
 * 这句抛自 `core/session` 的**内存 store**（`prepare` / `enter` 的 `store.has(id)`），
 * 不是磁盘、也不是投影缓存。`dropIdleAgents`（控制台保存人格时调）与世界的 effect
 * 收尾都是「从自己的表里删掉 + `void dispose()`」—— 不 await。于是下一条消息
 * 在旧条目还没摘掉时去解析同一个 id，撞在 store 上，**这一轮静默丢掉**。
 *
 * ⚠️ `prepare` 的冲突检查在 `seedSource === 'persistence'` 分支**之前** —— 所以
 * resume 一样会撞，不只是 create。`FakeAgents.publish` 现在建模了这一点。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BOT, GROUP, makeBridgeEnv, messageFrame, type BridgeEnv } from '../support/fake-bridge-env.ts'

const OTHER = '2000000003'
const opened: BridgeEnv[] = []

async function env(): Promise<BridgeEnv> {
  const built = await makeBridgeEnv()
  built.onebot.accounts.set(BOT, { selfId: BOT, preset: 'xiaoyan-agent' })
  opened.push(built)
  return built
}

afterEach(async () => {
  while (opened.length) await opened.pop()?.dispose()
})

/** 桥暴露的释放入口（控制台人格页走的就是它）。 */
function bridgeOf(e: BridgeEnv): { dropIdleAgents: (reason: string) => Promise<unknown> | unknown } {
  return e.ctx.get('onebot-bridge') as { dropIdleAgents: (reason: string) => Promise<unknown> | unknown }
}

describe('释放会话句柄：不能把下一条消息撞死在还没摘掉的旧条目上', () => {
  it('⭐ 保存人格释放句柄后，紧接着的那条消息仍要发得出（不出现 already exists）', async () => {
    const e = await env()
    // 让 detach 有可观察的耗时（真实层就是异步的）
    e.agents.disposeMs = 40
    e.agents.reply = '在的'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()
    expect(e.agents.created).toHaveLength(1)

    // 控制台保存人格 → 释放空闲句柄。调用方（persona 页）会 await 返回值
    await bridgeOf(e).dropIdleAgents('人格已在控制台保存')

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '小研？' }))
    await e.settle()

    const sent = e.onebot.calls.filter((c) => c.action === 'send_private_msg')
    expect(sent).toHaveLength(2)
  })

  it('释放后盘上有日志 → 再走一次是 **resume**，不是 create（历史不丢）', async () => {
    const e = await env()
    e.agents.reply = '在的'
    const sessionId = `agent:${BOT}:private:${OTHER}`

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()
    expect(e.agents.created.map((c) => c.sessionId)).toEqual([sessionId])

    // 模拟"这份会话已落盘"，然后释放句柄
    e.persistence?.ids.add(sessionId)
    await bridgeOf(e).dropIdleAgents('人格已在控制台保存')

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '再说一次' }))
    await e.settle()

    expect(e.agents.resumed).toContain(sessionId)
    // 关键：第二次没有走 create（走了就会撞 store / 造出第二份日志）
    expect(e.agents.created).toHaveLength(1)
  })

  it('群里同理：释放后下一条消息仍回得到', async () => {
    const e = await env()
    e.agents.disposeMs = 40
    e.agents.reply = '在的'

    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '@小研 在吗' }))
    await e.settle()
    await bridgeOf(e).dropIdleAgents('人格已在控制台保存')
    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '再在吗' }))
    await e.settle()

    expect(e.onebot.calls.filter((c) => c.action === 'send_group_msg')).toHaveLength(2)
  })
})
