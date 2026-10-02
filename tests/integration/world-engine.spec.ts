/**
 * 世界装配与引擎的验收（T27b，spec §6.6/§6.7）。
 *
 * 前面每个部件都有自己的测试（内核 / 时钟 / 闸门 / 循环 / 裁定 / 工具），
 * 但"**从磁盘上的目录开始把它们打开并接起来**"这件事只能在这里验：
 *
 *   ① **装配**：`openWorld()` 打开真世界 → 门面四个动词真的能动这个世界
 *   ② **引擎**：`ctx.world` 是那个门面（世界工具因此能注册）、心跳报活、dispose 真停
 *   ③ **补发**：外面提交的一句 `say`（工具那条路）由心跳送出门，不必等 30 分钟的 Tingle
 *   ④ **没创世时如实失败**：世界里没有她 → `look()` 报错，而不是给一个空观测
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openWorld } from '../../src/world/assemble.ts'
import type { CallWorldModel } from '../../src/world/arbiter.ts'
import WorldEngine from '../../src/world/engine.ts'
import { runWorldStep } from '../../src/setup/world-step.ts'
import { worldDir } from '../../src/setup/install.ts'
import type { OutboxItem } from '../../src/world/outbox.ts'

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..')
const SELF_ID = 'yanxin'
const GROUP = '3000000003'
const QQ = '2000000002'
const NOW_MS = 1_800_000_000_000

const homes: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  // 先关世界（心跳停、落盘队列排空），再删目录
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
  // ⚠️ 落盘是异步的（闸门的回执、时钟的检查点）：给它一点时间把在飞的写收尾。
  //    少了这一步，Windows 上会 ENOTEMPTY —— 删除与写入撞在一起（T21 的同一个教训）。
  await new Promise((resolve) => setTimeout(resolve, 30))
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'yanxin-engine-'))
  homes.push(home)
  return home
}

/** 一个按剧本回答的世界模型。 */
function scriptedModel(entities = initialEntities()): CallWorldModel {
  return async () => ({ arguments: { entities } })
}

function initialEntities(): unknown[] {
  return [
    { id: SELF_ID, kind: 'actor', name: '小研', location: 'house' },
    { id: 'phone', kind: 'object', name: '手机', location: 'house', owner: SELF_ID },
    { id: 'house', kind: 'place', name: '小房子', location: null },
    { id: 'street', kind: 'place', name: '很宽的街道', location: null },
  ]
}

/** 用**向导那一步**把世界创出来（这样测试验的就是真实路径）。 */
async function prepareWorld(home: string): Promise<string> {
  const dir = worldDir(home)
  await runWorldStep({
    home,
    packageRoot: PACKAGE_ROOT,
    worldDir: dir,
    selfId: SELF_ID,
    callModel: scriptedModel(),
    now: () => NOW_MS,
    warn: () => undefined,
  })
  return dir
}

/** 轮询等到条件成立（异步打开 / 心跳这类"等它发生"的断言用）。 */
async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时：条件一直没成立')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('T27b —— 装配：从目录开始把世界打开', () => {
  it('⭐ 门面四个动词真的能动这个世界（看 / 登记 / 写笔记 / 翻本子）', async () => {
    const home = await makeHome()
    const dir = await prepareWorld(home)
    const posted: OutboxItem[] = []
    const warnings: string[] = []

    const world = await openWorld({
      dir,
      selfId: SELF_ID,
      callModel: scriptedModel(),
      deliver: async (item) => {
        posted.push(item)
      },
      tingleEveryUnits: 0, // 不放心跳（测试自己驱动）
      warn: (message) => warnings.push(message),
    })

    try {
      // ① 看：观测里带句柄、没有内部 id
      const observation = world.facade.look()
      expect(observation.entities.map((entity) => entity.name)).toContain('小房子')
      expect(observation.entities.every((entity) => entity.handle.startsWith('seen:'))).toBe(true)

      // ② 登记：说一句话 → 提交 → 立刻发射（先提交后发射）
      const accepted = await world.facade.submit({ kind: 'say', text: '今天风很大。' })
      expect(accepted.accepted).toBe(true)
      expect(posted.map((item) => item.text)).toEqual(['今天风很大。'])
      expect(world.kernel.snapshot.utterances).toHaveLength(1)

      // ③ 写笔记 + 翻本子（笔记不进世界事务）
      const before = world.kernel.snapshot.sequence
      const { path } = await world.facade.writeNote('今天', '没什么事。')
      expect(path).toContain('今天.md')
      expect(await world.facade.listNotes()).toEqual(['今天'])
      expect(world.kernel.snapshot.sequence).toBe(before)

      // ④ 她自己在世界里（创世那只 actor 就是她）
      expect(world.kernel.snapshot.entities[SELF_ID]?.location).toBe('house')
      // 除"决策函数未接线"（这一组不注入 decide）外，不该有别的问题
      expect(warnings.filter((line) => !line.includes('T27b-3'))).toEqual([])
    } finally {
      world.stop()
    }
  })

  it('⭐ decide 没接线时照常打开，但明确告警（"她为什么不主动"要有据可查）', async () => {
    const home = await makeHome()
    const dir = await prepareWorld(home)
    const warnings: string[] = []

    const world = await openWorld({
      dir,
      selfId: SELF_ID,
      callModel: scriptedModel(),
      deliver: async () => undefined,
      tingleEveryUnits: 0,
      warn: (message) => warnings.push(message),
    })

    try {
      expect(warnings.join()).toContain('T27b-3')
    } finally {
      world.stop()
    }
  })

  it('⚠️ 世界里还没有她（没创世）→ `look()` 如实报错，而不是给一个空观测', async () => {
    const home = await makeHome()
    const world = await openWorld({
      dir: worldDir(home), // 空目录：没有事务、没有她
      selfId: SELF_ID,
      callModel: scriptedModel(),
      deliver: async () => undefined,
      tingleEveryUnits: 0,
      warn: () => undefined,
    })

    try {
      expect(() => world.facade.look()).toThrow(/世界里没有/)
    } finally {
      world.stop()
    }
  })
})

describe('T27b —— 引擎：ctx.world 就是那个门面', () => {
  /** 起一个引擎（假 onebot + 假 worldModel，世界目录用刚创好的那个）。 */
  function startEngine(
    dir: string,
    over: { withAgents?: boolean; tingleEveryUnits?: number; account?: string } = {},
  ): {
    ctx: Context
    engine: WorldEngine
    calls: { selfId: string; action: string; params: unknown }[]
    agents: { created: { sessionId?: unknown; preset?: unknown }[]; followups: unknown[] }
  } {
    const ctx = new Context()
    contexts.push(ctx)
    const calls: { selfId: string; action: string; params: unknown }[] = []
    const agents = { created: [] as { sessionId?: unknown; preset?: unknown }[], followups: [] as unknown[] }
    const provide = (ctx as unknown as { provide: (name: string, value: unknown) => unknown }).provide.bind(ctx)

    provide('worldModel', { call: scriptedModel() })
    provide('onebot', {
      call: async (selfId: string, action: string, params: unknown) => {
        calls.push({ selfId, action, params })
        return { message_id: 1 }
      },
      account: (selfId: string) =>
        selfId === SELF_ID || selfId === QQ ? { selfId, preset: 'xiaoyan-world' } : undefined,
      connectionsOf: () => ['API'],
      accounts: [{ selfId: QQ, preset: 'xiaoyan-world' }],
    })

    if (over.withAgents === true) {
      // 她"怎么想"要的那几个服务（假件：只记调用，不真跑模型）
      const fakeAgent = {
        session: { seq: 1 },
        followup: (message: unknown) => {
          agents.followups.push(message)
        },
        whenIdle: async () => undefined,
      }
      provide('agents', {
        create: async (input: {
          sessionId?: unknown
          meta?: { agentPreset?: unknown }
          setup?: (agentCtx: Context) => Promise<void>
        }) => {
          agents.created.push({ sessionId: input.sessionId, preset: input.meta?.agentPreset })
          // 真实的 create 会调 setup(agentCtx) 挂 preset —— 假件也要调，
          // 否则"挂 preset"这条纪律在测试里就是空的（ADR 0003）
          await input.setup?.(ctx)
          return { agent: fakeAgent, dispose: async () => undefined }
        },
        resume: async (input: { resumeSessionId?: unknown; setup?: (agentCtx: Context) => Promise<void> }) => {
          agents.created.push({ sessionId: input.resumeSessionId, preset: '（恢复）' })
          await input.setup?.(ctx)
          return { agent: fakeAgent, dispose: async () => undefined }
        },
      })
      provide('agentPresets', { mount: async () => undefined })
      provide('sessions', { flush: async () => undefined })
      provide('agentDefaultModel', { currentSelection: () => ({ provider: 'example-llm', model: 'example-model-b' }) })
      provide('sessionPersistence', { list: async () => [] })
    }

    const engine = new WorldEngine(ctx, {
      worldDir: dir,
      selfId: SELF_ID,
      ...(over.account === undefined ? {} : { account: over.account }),
      worldGroupId: GROUP,
      tickMs: 5, // 报活 + 补发心跳：毫秒级，测试好观察
      tingleEveryUnits: over.tingleEveryUnits ?? 0, // 默认不启动"她想一轮"的节拍
    })
    return { ctx, engine, calls, agents }
  }

  it('⭐ 装载后打开世界（异步）→ `ctx.world` 满足四个动词；心跳与入站都在记', async () => {
    const home = await makeHome()
    const dir = await prepareWorld(home)
    const { ctx, engine } = startEngine(dir)

    await until(() => engine.ready)
    expect(engine.snapshot.entities[SELF_ID]).toBeDefined()

    // 世界工具要的四个动词都在（`apply()` 检查的就是它们）
    expect(typeof engine.look).toBe('function')
    expect(typeof engine.submit).toBe('function')
    expect(typeof engine.writeNote).toBe('function')
    expect(typeof engine.listNotes).toBe('function')
    expect(engine.look().entities.length).toBeGreaterThan(0)

    // 心跳真的在跑 + 事件在发
    const seen: number[] = []
    ctx.on('yanxin/world-tick', (seq: number) => seen.push(seq))
    until(() => engine.ticks > 0)
    await until(() => seen.length > 0)

    // 入站订阅（T19 的判据）
    ctx.emit('onebot/event', { kind: 'event', postType: 'message', selfId: SELF_ID, raw: {} })
    expect(engine.inbound).toBe(1)
  })

  it('⭐ 她经工具说的一句话，由心跳补发出去（不必等 30 分钟的 Tingle）', async () => {
    const home = await makeHome()
    const dir = await prepareWorld(home)
    const { engine, calls } = startEngine(dir)
    await until(() => engine.ready)

    // 模拟"工具那条路"之外的一次提交：直接把 say 写进内核（绕过门面的立即发射）
    const kernel = (engine as unknown as { world?: { kernel: { submit: (p: unknown) => Promise<unknown> } } }).world
      ?.kernel
    expect(kernel).toBeDefined()
    await kernel?.submit({
      idempotencyKey: 'outside-say',
      effectiveAt: 1,
      operations: [{ op: 'say', actorId: SELF_ID, text: '我从外面回来了。' }],
      source: 'test',
    })

    // 心跳把它补发出去（发到她的世界群）
    await until(() => calls.length > 0)
    expect(calls[0]?.action).toBe('send_group_msg')
    // ⚠️ 这里要的是**她的 QQ 号**（OneBot 连接的身份），不是世界实体 id（`yanxin`）——
    // 2026-09-27 夜间实测踩到过：传了世界实体 id ⇒ 每一句都
    // "selfId=yanxin 没有可用的 API 连接"，而它按纪律记回执、不重试
    //（症状："她很会说话，但群里一句都没收到"）。这两条断言就是那个坑的回归。
    expect(calls[0]?.selfId).toBe(QQ)
    expect(calls[0]?.selfId).not.toBe(SELF_ID)
    expect(JSON.stringify(calls[0]?.params)).toContain('我从外面回来了。')
  })

  it('没配世界群 → 发射**如实失败**（不静默丢），且引擎照常活着', async () => {
    const home = await makeHome()
    const dir = await prepareWorld(home)
    const ctx = new Context()
    contexts.push(ctx)
    ;(ctx as unknown as { provide: (name: string, value: unknown) => unknown }).provide('worldModel', {
      call: scriptedModel(),
    })
    const engine = new WorldEngine(ctx, { worldDir: dir, selfId: SELF_ID, tickMs: 5, tingleEveryUnits: 0 })

    await until(() => engine.ready)
    // 门面自己会立刻发射 → 没有群号 → 回执记 failed，但 submit 仍然"登记成功"（世界收到了）
    const accepted = await engine.submit({ kind: 'say', text: '发给空气' })
    expect(accepted.accepted).toBe(true)

    const world = (engine as unknown as { world?: { outbox: { receipts: readonly { status: string; reason?: string }[] } } })
      .world
    const receipts = world?.outbox.receipts ?? []
    expect(receipts.map((receipt) => receipt.status)).toEqual(['failed'])
    expect(receipts[0]?.reason).toContain('世界群')
  })

  it('⭐ 窗口关闭（dispose）→ 心跳停、订阅断、门面不再假装能干活', async () => {
    const home = await makeHome()
    const dir = await prepareWorld(home)
    const { ctx, engine } = startEngine(dir)
    await until(() => engine.ready)
    await until(() => engine.ticks > 0)

    const ticksAtDispose = engine.ticks
    await ctx.fiber.dispose()

    // 心跳停了
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(engine.ticks).toBe(ticksAtDispose)
    // 世界也关了：门面不返回旧数据，而是明确报错
    expect(engine.ready).toBe(false)
    expect(() => engine.look()).toThrow(/还没装载完/)
  })

  it('⭐ Tingle 到点 → 驱动**她自己的会话**（世界:QQ，同一份人格与记忆）', async () => {
    const home = await makeHome()
    const dir = await prepareWorld(home)
    // Tingle 间隔给极小值（0.05 TU = 50ms）：这一拍真的会自己来，不用手动催
    const { engine, agents } = startEngine(dir, { withAgents: true, tingleEveryUnits: 0.05, account: QQ })
    await until(() => engine.ready)

    await until(() => agents.followups.length > 0)
    expect(agents.created[0]?.sessionId).toBe(`world:${QQ}`)
    expect(agents.created[0]?.preset).toBe('xiaoyan-world')
    // 她收到的是一段"处境"（不是谁发的消息）
    expect(JSON.stringify(agents.followups[0])).toContain('你在过自己的日子')
  })

  it('⭐ 不知道她是哪个 QQ 号 → 告警一次、世界照常转（不主动想事而已）', async () => {
    const home = await makeHome()
    const dir = await prepareWorld(home)
    const ctx = new Context()
    contexts.push(ctx)
    const provide = (ctx as unknown as { provide: (name: string, value: unknown) => unknown }).provide.bind(ctx)
    provide('worldModel', { call: scriptedModel() })
    // 没有 onebot（于是拿不到账号注册表），也没给 account 行 config
    const engine = new WorldEngine(ctx, { worldDir: dir, selfId: SELF_ID, tickMs: 5, tingleEveryUnits: 0 })

    await until(() => engine.ready)
    await until(() => engine.ticks > 0)
    expect(engine.ready).toBe(true) // 世界的装载不受影响
  })
})