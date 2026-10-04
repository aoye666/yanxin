/**
 * 未初始化守卫的验收（T30，spec §6.11）。
 *
 * 它要防的事很具体：**空人格跑起来会污染记忆** —— 消息进来 → 建会话 → 调模型 →
 * 写回长期记忆，那条路一旦通了，一个"还不知道自己是谁"的小研就已经在往 ReMe 里
 * 沉淀东西了（检索是全 workspace 的，沉淀下去就跟着她）。
 *
 * 所以本文件盯三件事：
 *   ① **拦在建会话之前**：未就绪时零 agent 创建、零记忆写回，只回一句可操作的话
 *   ② **每个频道只说一次**：群里每条消息都回"还没初始化"是刷屏，完全沉默又像坏了
 *   ③ **两个判据分开**：人格缺 → agent 不许开口；世界缺 → 世界引擎不装载
 *      （"世界没创世"不该拦住群里的被动响应，但也不该让她在一个空世界里过日子）
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { allowAgent, allowWorld } from '../../src/setup/guard.ts'
import { personaDir, presetRoot, worldDir } from '../../src/setup/install.ts'
import { BOT, ALOYE, FakeSetup, GROUP, makeBridgeEnv, messageFrame } from '../support/fake-bridge-env.ts'

const dirs: string[] = []
const homes: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) {
      const saved = process.env.DSH_HOME
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  }
})

/** 一个"装备好"的临时 `$DSH_HOME`（人格源 + preset + 世界都在）。 */
async function readyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'yanxin-guard-'))
  dirs.push(home)

  // ⚠️ 用**夹具包根**而不是本仓目录：本仓的 `persona/` 在公开副本里是出厂空模板，
  //   拿它当"装备齐全"的现场，公开包就跑不绿自己这条守卫（2026-10-05 实测）。
  const packageRoot = join(import.meta.dirname, '..', 'fixtures', 'package-root')
  await mkdir(personaDir(home), { recursive: true })
  for (const file of ['base.md', 'profile.md', 'world.md']) {
    const text = await (await import('node:fs/promises')).readFile(join(packageRoot, 'persona', file), 'utf8')
    await writeFile(join(personaDir(home), file), text, 'utf8')
  }
  for (const id of ['xiaoyan-agent', 'xiaoyan-admin', 'xiaoyan-world']) {
    await mkdir(join(presetRoot(home), id), { recursive: true })
    await writeFile(join(presetRoot(home), id, 'agent.cordis.yml'), `# ${id}\n`, 'utf8')
  }
  await mkdir(worldDir(home), { recursive: true })
  await writeFile(join(worldDir(home), 'world-transactions.jsonl'), '{"sequence":1}\n', 'utf8')
  await writeFile(join(worldDir(home), 'clock.json'), '{"genesisMs":1,"accumulatedTU":0,"runningSince":null,"lastTick":0}\n', 'utf8')
  return home
}

describe('T30 —— 守卫的判据（没有 setup 服务时也自己读现场）', () => {
  it('⭐ 现场装备齐全 → agent 与世界都放行', async () => {
    const home = await readyHome()
    process.env.DSH_HOME = home
    homes.push(home)
    const ctx = new Context()

    expect((await allowAgent(ctx)).ok).toBe(true)
    expect((await allowWorld(ctx)).ok).toBe(true)
  })

  it('⭐ 没人格（空 $DSH_HOME）→ agent 拒，且建议**可操作**（指向向导与缺什么）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'yanxin-guard-empty-'))
    dirs.push(home)
    homes.push(home) // 只为在 afterEach 里恢复 env
    process.env.DSH_HOME = home
    const ctx = new Context()

    const verdict = await allowAgent(ctx)
    expect(verdict.ok).toBe(false)
    expect(verdict.advice).toContain('初始化向导')
    expect(verdict.advice).toContain('persona/base.md') // 缺什么也说了
    expect(verdict.status).toBe('init')
    expect(verdict.next).toBe('persona')
  })

  it('⭐ 人格在、世界没创世 → agent 放行、世界拒（两件事分开判）', async () => {
    const home = await readyHome()
    process.env.DSH_HOME = home
    homes.push(home)
    await rm(join(worldDir(home), 'clock.json'))
    await writeFile(join(worldDir(home), 'world-transactions.jsonl'), '', 'utf8')
    const ctx = new Context()

    const agent = await allowAgent(ctx)
    expect(agent.ok).toBe(true)
    expect(agent.next).toBe('world') // 状态推导停在 background

    const world = await allowWorld(ctx)
    expect(world.ok).toBe(false)
    expect(world.advice).toContain('世界还没创世')
    expect(world.advice).toContain('clock.json')
  })

  it('有 setup 服务时以它为准（现场读取只是兜底）', async () => {
    const ctx = new Context()
    const setup = new FakeSetup(ctx)
    setup.markUnsatisfied('persona', ['（假向导说）人格还没导入'])

    const verdict = await allowAgent(ctx)
    expect(verdict.ok).toBe(false)
    expect(verdict.advice).toContain('（假向导说）人格还没导入')
  })
})

describe('T30 —— bridge：未就绪时不建会话、不写记忆', () => {
  /** 装一个**注册过账号**的 bridge 环境（没注册的 selfId 会被直接丢掉，这正是我们要避开的假失败）。 */
  async function bridgeEnv(options: Parameters<typeof makeBridgeEnv>[0] = {}) {
    const built = await makeBridgeEnv(options)
    built.onebot.accounts.set(BOT, { selfId: BOT, preset: 'xiaoyan-agent' })
    return built
  }

  it('⭐ 未初始化 → 回一句可操作的话，且**零 agent 创建**、零记忆写回', async () => {
    const env = await bridgeEnv({ memory: { hits: [] } })
    env.setup.markUnsatisfied('persona', ['人格基底还没导入（缺 yanxin/persona/base.md）'])

    env.emit(messageFrame({ messageType: 'group', userId: ALOYE, groupId: GROUP, text: '在吗', at: BOT }))
    await env.settle()

    // 没有会话、没有 agent、没有写回 —— 记忆没被污染
    expect(env.agents.created).toEqual([])
    expect(env.memoryProvider?.recorded ?? []).toEqual([])
    // 一句话回出去了（可操作），而不是沉默
    const sent = env.onebot.calls.filter((call) => call.action === 'send_group_msg')
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent[0]?.params)).toContain('初始化向导')
    expect(JSON.stringify(sent[0]?.params)).toContain('persona/base.md')

    await env.dispose()
  })

  it('⭐ 未就绪时同一个频道只说一次（不刷屏），日志仍在记', async () => {
    const env = await bridgeEnv()
    env.setup.markUnsatisfied('persona', ['人格还没导入'])

    for (const text of ['一', '二', '三']) {
      env.emit(messageFrame({ messageType: 'group', userId: ALOYE, groupId: GROUP, text, at: BOT }))
    }
    await env.settle()

    expect(env.onebot.calls.filter((call) => call.action === 'send_group_msg')).toHaveLength(1)
    expect(env.agents.created).toEqual([])

    await env.dispose()
  })

  it('⭐ 只差"世界"时**不拦**群里的被动响应（树上两件事分开判）', async () => {
    const env = await bridgeEnv()
    env.setup.markUnsatisfied('world', ['世界还没创世'])

    env.emit(messageFrame({ messageType: 'group', userId: ALOYE, groupId: GROUP, text: '在吗', at: BOT }))
    await env.settle()

    // 她有人格 → 可以说这句话；世界没创世只影响"主动过日子"（引擎不装载）
    expect(env.agents.created).toHaveLength(1)
    await env.dispose()
  })

  it('就绪之后照常放行（守卫不该拦住正常对话）', async () => {
    const env = await bridgeEnv()
    env.emit(messageFrame({ messageType: 'group', userId: ALOYE, groupId: GROUP, text: '在吗', at: BOT }))
    await env.settle()

    expect(env.agents.created).toHaveLength(1)
    await env.dispose()
  })
})