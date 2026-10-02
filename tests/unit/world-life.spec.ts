/**
 * 她的"生活"驱动的验收（T27b-3，spec §6.7）。
 *
 * 这一层把三样东西接起来：**时间到了**（Tingle）→ 她自己的 agent 会话（同一份人格与记忆）
 * → 世界工具（动作因此进了世界）。所以验收盯：
 *
 *   · **提示词只写处境，不写人设**（人设是 preset 的单一来源，两处写就会打架）
 *   · **返回值永远是 `null`**：动作走的是工具那条路（这条断言防止有人以为它漏了翻译）
 *   · **环境不全时降级而不是崩**（缺 agent 服务 → 告警一次 + 空转，世界照常转）
 *   · **会话命名与群聊同一个命名空间**（`world:<QQ>` —— 同一份记忆的地基）
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { createLifeDecide, formatElapsed, LIFE_PRESET, renderLifePrompt } from '../../src/world/life.ts'
import type { TurnContext } from '../../src/world/bot-loop.ts'
import type { Observation } from '../../src/world/observe.ts'

const OBSERVATION: Observation = {
  observationId: 'obs:3',
  at: 3600,
  placeHandle: 'seen:1',
  entities: [
    { handle: 'seen:0', kind: 'actor', name: '小研', self: true, attributes: {} },
    { handle: 'seen:1', kind: 'place', name: '小房子', self: false, attributes: {} },
    { handle: 'seen:2', kind: 'object', name: '手机', self: false, attributes: {} },
  ],
  utterances: [],
}

function context(over: Partial<TurnContext> = {}): TurnContext {
  return {
    observation: OBSERVATION,
    notices: [],
    at: 3600,
    world: { schemaVersion: 1, sequence: 1, effectiveAt: 3600, entities: {}, actions: {}, utterances: [] },
    ...over,
  }
}

describe('T27b-3 —— 提示词写处境，不写人设', () => {
  it('⭐ 带上"醒来多久"、感知与刚想起来的事', () => {
    const prompt = renderLifePrompt({
      at: 3600,
      notices: ['做完了：看了看手机'],
      observation: OBSERVATION,
      wall: '15:42',
    })

    expect(prompt).toContain('醒来已经过了 1 小时')
    expect(prompt).toContain('此刻是 15:42')
    expect(prompt).toContain('你在「小房子」')
    expect(prompt).toContain('做完了：看了看手机')
    // 处境 + 出口，而不是"你是一个……"式的人设复述
    expect(prompt).not.toContain('你是毕小研')
    expect(prompt).toContain('什么都不做也可以')
  })

  it('没有刚想起来的事时不写那一段（不塞空标题）', () => {
    const prompt = renderLifePrompt({ at: 10, notices: [], observation: OBSERVATION })
    expect(prompt).not.toContain('# 你刚想起来的事')
    expect(prompt).not.toContain('此刻是') // 拿不到墙上时间就不写
  })

  it('时间说人话（秒 / 分钟 / 小时）', () => {
    expect(formatElapsed(0)).toBe('0 秒')
    expect(formatElapsed(42)).toBe('42 秒')
    expect(formatElapsed(120)).toBe('2 分钟')
    expect(formatElapsed(3600)).toBe('1 小时')
    expect(formatElapsed(3720)).toBe('1 小时 2 分钟')
    expect(formatElapsed(-5)).toBe('0 秒') // 坏值不炸
  })
})

describe('T27b-3 —— 驱动会话：她怎么想的那一轮', () => {
  /** 一个假的 agent 环境（agents / agentPresets / sessions / agentDefaultModel）。 */
  function fakeCtx(): {
    ctx: Context
    agents: { created: { sessionId?: unknown; preset?: unknown; cwd?: unknown }[]; followups: unknown[]; disposed: number }
    presets: { mounted: unknown[] }
    flushes: unknown[]
  } {
    const ctx = new Context()
    const agents = {
      created: [] as { sessionId?: unknown; preset?: unknown; cwd?: unknown }[],
      followups: [] as unknown[],
      disposed: 0,
    }
    const presets = { mounted: [] as unknown[] }
    const flushes: unknown[] = []
    const provide = (ctx as unknown as { provide: (name: string, value: unknown) => unknown }).provide.bind(ctx)

    provide('agents', {
      create: async (input: {
        sessionId?: unknown
        meta?: { agentPreset?: unknown; cwd?: unknown }
        setup?: (c: Context) => Promise<void>
      }) => {
        agents.created.push({ sessionId: input.sessionId, preset: input.meta?.agentPreset, cwd: input.meta?.cwd })
        // ⚠️ 真实的 `agents.create` 会调 `setup(agentCtx)` 来挂 preset（ADR 0003）——
        //    假实现也必须调，否则"挂 preset"这条纪律在测试里就是空的
        await input.setup?.(ctx)
        return { agent: fakeAgent(agents), dispose: async () => { agents.disposed += 1 } }
      },
      resume: async (input: { resumeSessionId?: unknown; setup?: (c: Context) => Promise<void> }) => {
        agents.created.push({ sessionId: input.resumeSessionId, preset: '（恢复）' })
        await input.setup?.(ctx)
        return { agent: fakeAgent(agents), dispose: async () => { agents.disposed += 1 } }
      },
    })
    provide('agentPresets', {
      mount: async (agentCtx: unknown, id?: unknown) => {
        presets.mounted.push({ agentCtx, id })
      },
    })
    provide('sessions', { flush: async (session: unknown) => void flushes.push(session) })
    provide('agentDefaultModel', { currentSelection: () => ({ provider: 'example-llm', model: 'example-model-b' }) })
    // 没有持久化后端 → create 路径（没有磁盘日志）
    provide('sessionPersistence', { list: async () => [] })
    return { ctx, agents, presets, flushes }
  }

  function fakeAgent(agents: { followups: unknown[] }) {
    return {
      session: { seq: 1 },
      followup(message: unknown) {
        agents.followups.push(message)
      },
      whenIdle: async () => undefined,
    }
  }

  it('⭐ 一轮：挂 preset → 发一段"处境" → 等她忙完 → 返回 null（动作走工具那条路）', async () => {
    const { ctx, agents, presets, flushes } = fakeCtx()
    const { decide } = createLifeDecide({ ctx, account: '2000000002', warn: () => undefined })

    const intent = await decide(context({ notices: ['做完了：看了看手机'] }))

    expect(intent).toBeNull()
    // 会话 id 与群聊同一个命名空间；preset 是世界姿态那一个
    expect(String(agents.created[0]?.sessionId)).toBe('world:2000000002')
    expect(agents.created[0]?.preset).toBe(LIFE_PRESET)
    expect(presets.mounted.map((entry) => (entry as { id?: unknown }).id)).toEqual([LIFE_PRESET])
    // 她收到的那段话：带着"刚想起来的事"
    expect(JSON.stringify(agents.followups[0])).toContain('做完了：看了看手机')
    // 一轮结束后把会话刷盘（与桥同一条纪律：别让状态留在内存里）
    expect(flushes).toHaveLength(1)
  })

  it('⭐ 会话是**复用**的：第二拍不重复建（同一个她才有一份连续的生活）', async () => {
    const { ctx, agents } = fakeCtx()
    const { decide } = createLifeDecide({ ctx, account: '2000000002', warn: () => undefined })

    await decide(context())
    await decide(context({ at: 3601 }))

    expect(agents.created).toHaveLength(1)
    expect(agents.followups).toHaveLength(2)
  })

  it('⭐ dispose 收掉会话句柄且幂等：窗口关闭时收一次，没建过会话时是无害的空操作', async () => {
    const { ctx, agents } = fakeCtx()
    const life = createLifeDecide({ ctx, account: '2000000002', warn: () => undefined })

    // 还没跑过一轮（没建过会话）→ dispose 是空操作，不抛
    await life.dispose()
    expect(agents.disposed).toBe(0)

    await life.decide(context())
    expect(agents.disposed).toBe(0) // 跑着的时候当然还没收

    await life.dispose()
    expect(agents.disposed).toBe(1) // 收掉了
    await life.dispose() // 幂等：再收不重复
    expect(agents.disposed).toBe(1)
  })

  it('环境不全（没有 agent 服务）→ 告警一次 + 空转，不抛', async () => {
    const ctx = new Context()
    const warnings: string[] = []
    const { decide } = createLifeDecide({ ctx, account: '2000000002', warn: (message) => warnings.push(message) })

    expect(await decide(context())).toBeNull()
    expect(await decide(context())).toBeNull()
    expect(warnings).toHaveLength(1) // 只说一次（每 30 分钟刷一条没有意义）
    expect(warnings[0]).toContain('过不了日子')
  })

  it('模型路由由 agentDefaultModel 给（与群聊同一处口径）', async () => {
    const { ctx, agents } = fakeCtx()
    const { decide } = createLifeDecide({ ctx, account: '1', model: 'agra-3.0', warn: () => undefined })
    await decide(context())
    // 覆盖的 model 会进 agentOptions（这里只断言那一轮真的跑了）
    expect(agents.followups).toHaveLength(1)
  })

  // ⚠️ 这一组是 2026-10-01 从会话落盘里抓到的：世界会话没带 cwd → 落到 `process.cwd()`
  //    （内核检出目录），于是内核自己的 `AGENTS.md` 被注入她的 prompt。
  //    聊天线没这个毛病（它的 root 是 `~/.dsh/yanxin/workspace`），所以症状只在世界侧。
  it('⭐ cwd 会带进会话（她是"在同一条工作区里过日子"，不是在内核仓库里）', async () => {
    const { ctx, agents } = fakeCtx()
    const { decide } = createLifeDecide({
      ctx,
      account: '2000000002',
      cwd: '~/.dsh/yanxin/workspace',
      warn: () => undefined,
    })

    await decide(context())

    expect(agents.created[0]?.cwd).toBe('~/.dsh/yanxin/workspace')
  })

  it('没配 cwd 时告警一次 —— 静默继承内核目录比报错更难查', async () => {
    const seen: string[] = []
    const { ctx } = fakeCtx()
    const { decide } = createLifeDecide({ ctx, account: '1', warn: (message) => seen.push(message) })

    await decide(context())
    await decide(context())

    const cwdWarnings = seen.filter((message) => message.includes('cwd'))
    expect(cwdWarnings).toHaveLength(1)
    expect(cwdWarnings[0]).toContain('AGENTS.md')
  })
})