/**
 * 她的"生活"驱动的**真实装配**用例（T27b-3 的装配面）。
 *
 * 为什么必须单独有这个文件：`world-life.spec.ts` 用的是**假 ctx**（一个普通对象），
 * 而 2026-09-27 夜间的真实隔离实例逮到了这样一条：
 *
 *   [W] world-engine [world-bot-loop] 决策失败（本轮按"什么都不做"处理）：
 *       cannot get property "agents" without inject
 *
 * 也就是**世界循环每一拍都空转，她永远不会主动做事** —— 而单测全绿。
 * 根因：共用件 `resumeOrCreateAgent` 里直接写 `ctx.agents`，而世界引擎**故意不 inject
 * 任何东西**（它必须能独立裁决），cordis 的属性访问因此被拒。
 * 假 ctx 没有这层守卫，所以只有**真 Context** 才复现得出来。
 *
 * 这个文件因此只测那一件事：**在真 Context 上、用软查提供的服务，decide 能走到底**
 * （建/恢复会话 → followup → whenIdle → flush → 永远返回 null）。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { resumeOrCreateAgent, type AgentServices } from '../../src/onebot/agent-session.ts'
import { createLifeDecide } from '../../src/world/life.ts'
import type { TurnContext } from '../../src/world/bot-loop.ts'
import type { Observation } from '../../src/world/observe.ts'

const opened: Context[] = []

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
})

const OBSERVATION: Observation = {
  observationId: 'obs:1',
  at: 3600,
  placeHandle: 'seen:1',
  entities: [
    { handle: 'seen:0', kind: 'actor', name: '小研', self: true, attributes: {} },
    { handle: 'seen:1', kind: 'place', name: '小房子', self: false, attributes: {} },
  ],
  utterances: [],
}

function turn(): TurnContext {
  return {
    observation: OBSERVATION,
    notices: [],
    at: 3600,
    world: { schemaVersion: 1, sequence: 1, effectiveAt: 3600, entities: {}, actions: {}, utterances: [] },
  }
}

/**
 * 一次"她自己过日子"的调用所需要的一切。
 *
 * ⚠️ **关键是 ctx 的层次**：服务挂在**父** Context 上，而交给 `createLifeDecide` 的是
 * 一个**没有 inject 任何东西的子 Context**（用一次 `plugin((ctx) => …)` 拿到 ——
 * 那正是世界引擎那一行在真实装配里的形态）。少了这一层，`ctx.agents` 的属性访问
 * 不会触发 inject 守卫，测试就测不到那个 bug。
 */
async function makeCtx(options: { persisted?: boolean } = {}) {
  const parent = new Context()
  opened.push(parent)
  const provide = (parent as unknown as { provide: (name: string, value: unknown) => unknown }).provide.bind(parent)

  const calls = {
    created: 0,
    resumed: 0,
    mounted: [] as string[],
    followups: [] as unknown[],
    flushed: 0,
  }

  const agent = {
    session: { id: 'world:2000000002' },
    followup: (message: unknown) => calls.followups.push(message),
    whenIdle: async () => undefined,
  }

  // 真运行时会在 create/resume 内部调用 `setup(agentCtx)`（那正是"必须 mount preset"
  // 那条纪律的落点）—— 假服务也照做，否则这条断言测不到东西。
  const withSetup = async (input: unknown): Promise<{ agent: typeof agent; dispose: () => Promise<void> }> => {
    const setup = (input as { setup?: (agentCtx: unknown) => Promise<void> }).setup
    if (setup !== undefined) await setup({ id: 'agent-ctx' })
    return { agent, dispose: async () => undefined }
  }

  provide('agents', {
    create: async (input: unknown) => {
      calls.created += 1
      return withSetup(input)
    },
    resume: async (input: unknown) => {
      calls.resumed += 1
      return withSetup(input)
    },
  })
  provide('agentPresets', {
    mount: async (_agentCtx: unknown, id?: string) => {
      calls.mounted.push(String(id))
    },
  })
  provide('sessions', { flush: async () => void (calls.flushed += 1) })
  provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'example-llm', model: 'example-model-b' }),
  })
  provide('sessionPersistence', {
    list: async () => (options.persisted === true ? [{ id: 'world:2000000002' }] : []),
  })

  // 子 Context：与世界引擎那一行同形（不 inject 任何东西）
  let child: Context | undefined
  await parent.plugin((ctx: Context) => {
    child = ctx
  })
  if (child === undefined) throw new Error('拿不到子 Context')

  const services = {
    agents: (parent as unknown as { agents: AgentServices['agents'] }).agents,
    agentPresets: (parent as unknown as { agentPresets: AgentServices['agentPresets'] }).agentPresets,
  }

  return { ctx: child, parent, calls, agent, services }
}

/**
 * 一个**照 cordis 守卫的形状**做的 ctx：`get()` 通，**任何属性访问都抛**
 * （真运行时的原话就是 `cannot get property "agents" without inject`）。
 *
 * 用它来验助手只走软查 —— 这比"再造一个子 Context"更贴近那个 bug 的实质：
 * 真运行里 `agents` 明明在，但引擎那一行不 inject，属性访问就被守卫拒了。
 */
function guardedCtx(): Context {
  const stub = {
    get: () => undefined,
  }
  return new Proxy(stub, {
    get(target, prop) {
      if (prop === 'get') return target.get
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  }) as unknown as Context
}

describe('T27b-3 —— 真 Context 上的 decide（⚠️ 这一条堵的是 inject 那个洞）', () => {
  it('⭐ 不抛错，且真的驱动了她的会话（新会话路径）', async () => {
    const { ctx, calls } = await makeCtx()
    const { decide } = createLifeDecide({ ctx, account: '2000000002', warn: () => {} })

    const result = await decide(turn())

    expect(result).toBeNull() // 动作走工具那条路（见 life.ts 文件头）
    expect(calls.created).toBe(1)
    expect(calls.mounted).toEqual(['xiaoyan-world']) // preset 必须 mount
    expect(calls.followups).toHaveLength(1) // 提示词真的发给了她
    expect(calls.flushed).toBe(1) // 让她这一轮落盘
    // 提示词里带的是处境（地点名），不是人设
    expect(JSON.stringify(calls.followups[0])).toContain('小房子')
  })

  it('磁盘上有日志 → resume（不撞 id collision）', async () => {
    const { ctx, calls } = await makeCtx({ persisted: true })
    const { decide } = createLifeDecide({ ctx, account: '2000000002', warn: () => {} })

    await decide(turn())

    expect(calls.resumed).toBe(1)
    expect(calls.created).toBe(0)
  })

  it('第二次调用复用同一个会话（不重复 create/resume）', async () => {
    const { ctx, calls } = await makeCtx()
    const { decide } = createLifeDecide({ ctx, account: '2000000002', warn: () => {} })

    await decide(turn())
    await decide(turn())

    expect(calls.created).toBe(1)
    expect(calls.followups).toHaveLength(2)
  })

  it('服务不全时：告警**只一次** + 空转（世界照常转）', async () => {
    const parent = new Context()
    opened.push(parent)
    let child: Context | undefined
    await parent.plugin((ctx: Context) => {
      child = ctx
    })
    const warns: string[] = []
    const { decide } = createLifeDecide({ ctx: child as Context, account: '2000000002', warn: (message) => warns.push(message) })

    expect(await decide(turn())).toBeNull()
    expect(await decide(turn())).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('她过不了日子')
  })

  it('反证：助手只走 `ctx.get`，绝不在 ctx 上做属性访问（那个 bug 的实质）', async () => {
    // 用一个"照守卫形状"的 ctx：`get()` 通、属性访问抛 —— 真运行时的原话就是
    // `cannot get property "agents" without inject`。修好之后这里必须能跑到底。
    const { services, calls } = await makeCtx()
    const resolved = await resumeOrCreateAgent(guardedCtx(), services, {
      sessionId: 'world:2000000002',
      presetId: 'xiaoyan-world',
      agentOptions: { provider: 'example-llm', model: 'example-model-b' },
    })

    expect(resolved.persisted).toBe(false)
    expect(calls.created).toBe(1)
    expect(calls.mounted).toEqual(['xiaoyan-world'])
  })
})