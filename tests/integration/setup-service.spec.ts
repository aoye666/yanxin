/**
 * 向导服务的**真实装配**验收（T28b/c，spec §6.11）。
 *
 * 单测（`setup-logic.spec.ts`）管判定，这里管**装配与落盘**：真服务、真文件系统
 * （临时 `$DSH_HOME`）、真的把包内的 `persona/*.md` 与 `presets/*` 装过去。
 *
 * 四条验收（对应 todo 里 T28 的验收）：
 *
 *   ① **从零走完**：三步做完 → 状态推进，且 `$DSH_HOME` 里真的有了人格源与三个 preset
 *   ② **中途关闭可续**：重开服务（新实例）→ 进度还在，不用重做
 *   ③ **`ready` 后可回退重跑**：`reset` 之后状态如实退回，再 `run` 能装回去
 *   ④ ⭐ **反证**：手写一个"四步全完成"的 `setup.json`，但现场什么都没有 →
 *      装载后状态**必须**退回 `init`（不许显示就绪 —— T30 的拦截靠它）
 *
 * 附带的边界：跳步被拒且**不产生副作用**、`accounts` 的证据来自 onebot 服务、
 * 坏 `setup.json` 不崩（warn + 当未初始化）。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SetupService from '../../src/setup/index.ts'
import { personaDir, presetRoot, setupFile, worldDir } from '../../src/setup/install.ts'
import { SetupError, type SetupStatus } from '../../src/setup/types.ts'
import type { CallWorldModel } from '../../src/world/arbiter.ts'

// 夹具包根（填好的小 persona + 三个形状正确的 preset）。
// ⚠️ 不是本仓目录：本仓 `persona/` 在公开副本里是出厂空模板，向导据此判"还没人格"，
//   于是"从零走完四步"那整组在公开包上必红 —— 测试验的是**安装机制**，不该依赖这份包
//   有没有真内容（2026-10-05 同步公开副本时 14 条红在这）。
const PACKAGE_ROOT = join(import.meta.dirname, '..', 'fixtures', 'package-root')

/** 换行符：写成常量是为了让"按行比"的断言不必在字符串里塞真的换行（否则很容易写坏）。 */
const NEWLINE = String.fromCharCode(10)

const homes: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) await rm(home, { recursive: true, force: true })
  }
})

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'yanxin-setup-'))
  homes.push(home)
  return home
}

/** 假 onebot 服务（只提供向导用到的那两个成员）。 */
function fakeOneBot(registered: string[], connected: string[] = []): Record<string, unknown> {
  return {
    accounts: registered.map((selfId) => ({ selfId })),
    connectionsOf: (selfId: string) => (connected.includes(selfId) ? ['API'] : []),
  }
}

/** 一个"按剧本回答"的世界模型（世界步用；测试不碰真实 LLM）。 */
function scriptedModel(): CallWorldModel {
  const entities = [
    { id: 'yanxin', kind: 'actor', name: '小研', location: 'house' },
    { id: 'phone', kind: 'object', name: '手机', location: 'house', owner: 'yanxin' },
    { id: 'house', kind: 'place', name: '小房子', location: null },
    { id: 'street', kind: 'place', name: '很宽的街道', location: null },
  ]
  return async () => ({ arguments: { entities } })
}

/** 起一个真服务（`onebot` 传 `null` 表示"没有它"）。 */
function startService(
  home: string,
  onebot: Record<string, unknown> | null = null,
  events?: SetupStatus[],
  worldModel?: Record<string, unknown>,
): SetupService {
  const ctx = new Context()
  contexts.push(ctx)

  const provide = (ctx as unknown as { provide: (name: string, value: unknown) => unknown }).provide.bind(ctx)
  // `provide` 的签名按 Context 的增强（onebot: OneBotService）校验，这里用假对象——
  // 只声明"我们提供的形状"（与 bridge 里 cast `ctx.get('memory')` 同一做法）
  if (onebot !== null) provide('onebot', onebot)
  if (worldModel !== undefined) provide('worldModel', worldModel)
  if (events !== undefined) ctx.on('yanxin/setup-updated', (status) => events.push(status))

  return new SetupService(ctx, { home, packageRoot: PACKAGE_ROOT })
}

/** 走完前两步（world 还没接线，T29 才做）。 */
async function runPersonaAndBackground(setup: SetupService): Promise<void> {
  await setup.run('persona')
  await setup.run('background')
}

describe('T28 —— 从零走完：每步都真的落下东西', () => {
  it('⭐ persona 步：人格源 + 三个 preset 都装到 $DSH_HOME', async () => {
    const home = await makeHome()
    const setup = startService(home)

    const initial = await setup.progress()
    expect(initial.status).toBe('init')
    expect(initial.next).toBe('persona')

    const result = await setup.run('persona')
    expect(result.status).toBe('persona')
    expect(result.detail).toContain('preset')

    // 人格源是包内那份的副本（不是空文件、也不是别的内容）
    const installed = await readFile(join(personaDir(home), 'base.md'), 'utf8')
    const source = await readFile(join(PACKAGE_ROOT, 'persona', 'base.md'), 'utf8')
    expect(installed).toBe(source)

    // 三个 preset 目录都装齐了，内容与包内一致
    const presets = (await readdir(presetRoot(home))).sort()
    expect(presets).toEqual(['xiaoyan-admin', 'xiaoyan-agent', 'xiaoyan-world'])
    const worldYml = await readFile(join(presetRoot(home), 'xiaoyan-world', 'agent.cordis.yml'), 'utf8')
    const worldDoc = await readFile(join(PACKAGE_ROOT, 'persona', 'world.md'), 'utf8')
    // ⚠️ 世界文档被**缩进**进 YAML 块标量（`prefix: |-`），所以按"去掉首尾空格后的整行"比 ——
    // 直接 `toContain(全文)` 会因为缩进而假失败
    const ymlLines = new Set(worldYml.split(NEWLINE).map((line) => line.trim()))
    for (const line of worldDoc
      .split(NEWLINE)
      .map((text) => text.trim())
      .filter((text) => text !== '')
      .slice(0, 5)) {
      expect(ymlLines.has(line), `世界定义没进 preset：「${line}」`).toBe(true)
    }

    // 没有残留的临时文件（原子写入的收尾）
    expect((await readdir(presetRoot(home))).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('background 步装背景资料并重装 preset；状态推到 background', async () => {
    const home = await makeHome()
    const setup = startService(home)
    await runPersonaAndBackground(setup)

    expect(await setup.status()).toBe('background')
    const profile = await readFile(join(personaDir(home), 'profile.md'), 'utf8')
    expect(profile.trim().length).toBeGreaterThan(0)
  })

  it('accounts 步：选定她的 QQ 号才算完成（要在注册表里）', async () => {
    const home = await makeHome()
    const setup = startService(home, fakeOneBot(['3000000001'], ['3000000001']))
    await runPersonaAndBackground(setup)

    // 世界还没接线（T29），所以现在状态停在 background —— accounts 还不能跑
    await expect(setup.run('accounts', { accountId: '3000000001' })).rejects.toThrow(SetupError)
  })

  it('落盘：setup.json 有版本、已完成步骤与选定值（人能读）', async () => {
    const home = await makeHome()
    const setup = startService(home)
    await runPersonaAndBackground(setup)

    const raw = JSON.parse(await readFile(setupFile(home), 'utf8')) as { schemaVersion: number; completed: string[] }
    expect(raw.schemaVersion).toBe(1)
    expect(raw.completed).toEqual(['persona', 'background'])
  })
})

describe('T28 —— 中途关闭可续 / 回退重跑', () => {
  it('⭐ 重开服务（新实例）进度还在：不用重做前面两步', async () => {
    const home = await makeHome()
    const first = startService(home)
    await runPersonaAndBackground(first)

    const second = startService(home) // 模拟"关了浏览器/重启进程"
    const progress = await second.progress()

    expect(progress.status).toBe('background')
    expect(progress.next).toBe('world')
    expect(progress.steps.filter((state) => state.completed).map((state) => state.step)).toEqual(['persona', 'background'])
  })

  it('⭐ 回退到 background：状态退回 persona，再跑一次能装回去', async () => {
    const home = await makeHome()
    const setup = startService(home)
    await runPersonaAndBackground(setup)

    const afterReset = await setup.reset('background')
    expect(afterReset.status).toBe('persona')
    expect(afterReset.next).toBe('background')

    const rerun = await setup.run('background')
    expect(rerun.status).toBe('background')
  })

  it('回退会发出事件（控制台据此刷新）', async () => {
    const home = await makeHome()
    const events: SetupStatus[] = []
    const setup = startService(home, null, events)
    await setup.run('persona')
    await setup.reset('persona')

    expect(events).toEqual(['persona', 'init'])
  })
})

describe('T28 —— 反证：记录与现场不符时必须退回', () => {
  it('⭐ 手写"四步全完成"的 setup.json，但现场空无一物 → 状态退回 init', async () => {
    const home = await makeHome()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'yanxin'), { recursive: true })
    await writeFile(
      setupFile(home),
      JSON.stringify({
        schemaVersion: 1,
        completed: ['persona', 'background', 'world', 'accounts'],
        accountId: '3000000001',
        selfId: 'yanxin',
        updatedAt: Date.now(),
      }),
      'utf8',
    )

    const setup = startService(home, fakeOneBot(['3000000001'], ['3000000001']))
    const progress = await setup.progress()

    expect(progress.status).toBe('init') // 不是 ready！
    expect(progress.next).toBe('persona')
    // ⚠️ accounts **不在** reverted 里：它选定的 QQ 仍在注册表里（证据成立），
    // 只是被前面的步骤挡住了 —— "被挡住"与"失效"是两件事
    expect(progress.reverted).toEqual(['persona', 'background', 'world'])
    expect(progress.steps[0]?.missing.join()).toContain('persona/base.md')
  })

  it('坏 setup.json 不崩：warn 之后当"未初始化"', async () => {
    const home = await makeHome()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'yanxin'), { recursive: true })
    await writeFile(setupFile(home), '{ 这不是 JSON', 'utf8')

    const setup = startService(home)
    expect(await setup.status()).toBe('init')
  })

  it('跳步被拒，且**不产生任何副作用**（没装源、没装 preset）', async () => {
    const home = await makeHome()
    const setup = startService(home)

    await expect(setup.run('background')).rejects.toThrow(/先把它前面的步骤补上/)
    await expect(readdir(presetRoot(home))).rejects.toThrow() // 目录都没建
    await expect(readdir(personaDir(home))).rejects.toThrow()
  })

  it('⭐ 未知的 step 名 → 一句能看懂的 BAD_INPUT（修复前是 "this.actions[step] is not a function"）', async () => {
    const home = await makeHome()
    const setup = startService(home)

    await expect(setup.run('考古学' as never)).rejects.toThrow(/没有这一步/)
  })

  it('⭐ 并发 run 被串行化：两个一起进来不炸、都落定（修复前同拍双跑会共用一份过期快照）', async () => {
    const home = await makeHome()
    const setup = startService(home)

    const results = await Promise.allSettled([
      setup.run('persona'),
      setup.run('persona'),
    ])
    // 串行队列里两步都跑完了（persona 幂等：在位就不装），没有 undefined 崩溃
    expect(results.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
    // persona 这步完成了：状态停在这一步（下一步是 background）
    expect(await setup.status()).toBe('persona')
  })
})

describe('T28 —— accounts 的证据来自 onebot（软依赖）', () => {
  it('没有 onebot 服务时：注册表为空 → 选定了也过不了（附可操作的话）', async () => {
    const home = await makeHome()
    const setup = startService(home, null)
    setup.worldModel = scriptedModel()
    await runPersonaAndBackground(setup)
    await setup.run('world')
    await expect(setup.run('accounts', { accountId: '3000000001' })).rejects.toThrow(SetupError)

    const progress = await setup.progress()
    const accounts = progress.steps.find((state) => state.step === 'accounts')
    expect(accounts?.satisfied).toBe(false)
    expect(accounts?.missing.join()).toContain('不在账号注册表里')
  })

  it('⭐ 注册了但没连上：这一步**照样算成立**（协议端没起不该拦住初始化），只给告警', async () => {
    const home = await makeHome()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'yanxin'), { recursive: true })
    // 记录里已经选定了 QQ 号（等价于"accounts 步跑过了"）
    await writeFile(
      setupFile(home),
      JSON.stringify({ schemaVersion: 1, completed: [], accountId: '3000000001', updatedAt: Date.now() }),
      'utf8',
    )

    const setup = startService(home, fakeOneBot(['3000000001'])) // 注册了，但 connected 为空
    const progress = await setup.progress()

    const accounts = progress.steps.find((state) => state.step === 'accounts')
    expect(accounts?.satisfied).toBe(true)
    expect(progress.warnings.join()).toContain('还没有反连')
  })
})

describe('T29 —— 世界步接上之后：四步走完到 ready', () => {
  it('⭐ 从零走完：persona → background → world → accounts → ready', async () => {
    const home = await makeHome()
    const setup = startService(home, fakeOneBot(['3000000001'], ['3000000001']))
    setup.worldModel = scriptedModel()

    await setup.run('persona')
    await setup.run('background')
    const world = await setup.run('world')
    expect(world.status).toBe('world')
    expect(world.detail).toContain('创世')

    const done = await setup.run('accounts', { accountId: '3000000001' })
    expect(done.status).toBe('ready')

    const progress = await setup.progress()
    expect(progress.next).toBeNull()
    expect(progress.reverted).toEqual([])
    expect(progress.warnings).toEqual([])

    // 现场真的立起来了：世界目录、时钟、只读呈现、账号选定落盘
    const files = await readdir(worldDir(home))
    expect(files).toContain('world-transactions.jsonl')
    expect(files).toContain('clock.json')
    expect(files).toContain('world-status.md')
    const record = JSON.parse(await readFile(setupFile(home), 'utf8')) as { completed: string[]; accountId?: string }
    expect(record.completed).toEqual(['persona', 'background', 'world', 'accounts'])
    expect(record.accountId).toBe('3000000001')
  })

  it('⭐ 世界步真跑过之后，回退 world 再重跑要 `rebuild`（否则拒 —— 防手滑推倒她的世界）', async () => {
    const home = await makeHome()
    const setup = startService(home, fakeOneBot(['3000000001'], ['3000000001']))
    setup.worldModel = scriptedModel()
    await setup.run('persona')
    await setup.run('background')
    await setup.run('world')

    await setup.reset('world')
    expect((await setup.progress()).next).toBe('world')

    await expect(setup.run('world')).rejects.toThrow(/重建要显式说明/)
    const again = await setup.run('world', { rebuild: true })
    expect(again.status).toBe('world')
  })

  it('⚠️ 没有模型接线时：world 步明确报 NOT_WIRED，且**什么都没写**（不装空世界冒充成功）', async () => {
    const home = await makeHome()
    const setup = startService(home) // 不设 worldModel，装配里也没有 ctx.worldModel
    await runPersonaAndBackground(setup)

    try {
      await setup.run('world')
      expect.unreachable('没有模型接线，应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(SetupError)
      expect((error as SetupError).code).toBe('NOT_WIRED')
      // 建议里点名那行（控制台显示的是 summary：一句话 + 细节）
      expect((error as SetupError).summary).toContain('world-model')
    }
    expect(await readdir(personaDir(home))).not.toContain('world.md') // 世界定义也没装（空手而归）
    await expect(readdir(worldDir(home))).rejects.toThrow() // 世界目录都没建
    expect((await setup.progress()).next).toBe('world')
  })

  it('⭐ 装配里有 `ctx.worldModel` 服务时，世界步自己找到它（真实接线的形态）', async () => {
    const home = await makeHome()
    // 不设 `setup.worldModel` 字段 —— 只放一个服务，模拟 T27b 的 `world-model` 行
    const setup = startService(home, fakeOneBot(['3000000001'], ['3000000001']), undefined, {
      call: scriptedModel(),
    })

    await setup.run('persona')
    await setup.run('background')
    const world = await setup.run('world')
    expect(world.detail).toContain('创世')
  })

  it('显式设过的字段优先于服务（测试注入 / 装配覆盖的语义）', async () => {
    const home = await makeHome()
    let serviceCalled = false
    const setup = startService(home, fakeOneBot(['3000000001'], ['3000000001']), undefined, {
      call: async () => {
        serviceCalled = true
        throw new Error('服务不该被调用 —— 显式字段优先')
      },
    })
    setup.worldModel = scriptedModel()

    await setup.run('persona')
    await setup.run('background')
    await expect(setup.run('world')).resolves.toBeDefined()
    expect(serviceCalled).toBe(false)
  })
})