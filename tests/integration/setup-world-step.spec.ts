/**
 * `world` 步的验收（T29，spec §6.11）。
 *
 * 这一步把"她的世界存在了"变成事实：**创世**（`persona/world.md` → 结构化实体 → 内核提交）
 * + **写 T=0 时钟**。所以这里盯四件事：
 *
 *   ① **真的能加载**：产出的世界用 `WorldKernel.open` / `WorldClock.open` 读得回来，
 *      且 `clock.now()` 从 0 起（T=0 就是创世那一刻）
 *   ② **失败不留半成品**：模型给不出合法清单时，世界目录里**没有事务、也没有时钟**
 *      （顺序是"先创世后时钟"—— 这条断言就是把它钉死）
 *   ③ **已存在就拒重建**（防手滑），要重建得显式说
 *   ④ **重建是归档不是删除**：旧世界连她的笔记一起改名保留，随时能改回来
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { personaDir, worldDir } from '../../src/setup/install.ts'
import { readEmbeddedPersona } from '../../src/preset/persona-embed.ts'
import { inspect, runWorldStep } from '../../src/setup/world-step.ts'
import { SetupError } from '../../src/setup/types.ts'
import type { CallWorldModel } from '../../src/world/arbiter.ts'
import { WorldClock } from '../../src/world/clock.ts'
import { WorldKernel } from '../../src/world/kernel.ts'
import { WorldNotes } from '../../src/world/notes.ts'

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..')
const SELF_ID = 'yanxin'

const homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) await rm(home, { recursive: true, force: true })
  }
})

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'yanxin-world-step-'))
  homes.push(home)
  return home
}

/** 一份合法的世界清单（与她自己的 id 一致）。 */
function entities(): unknown[] {
  return [
    { id: SELF_ID, kind: 'actor', name: '小研', location: 'house' },
    { id: 'phone', kind: 'object', name: '手机', location: 'house', owner: SELF_ID },
    { id: 'house', kind: 'place', name: '小房子', location: null },
    { id: 'street', kind: 'place', name: '很宽的街道', location: null },
  ]
}

/** 按剧本回答的世界模型（用尽后重复最后一次）。 */
function scripted(script: unknown[]): { callModel: CallWorldModel; prompts: string[] } {
  const prompts: string[] = []
  const callModel: CallWorldModel = async (request) => {
    prompts.push(request.prompt)
    return { arguments: script[Math.min(prompts.length - 1, script.length - 1)] }
  }
  return { callModel, prompts }
}

/** 固定"现实时间"（T=0 锚点可断言）。 */
const NOW_MS = 1_800_000_000_000

function options(home: string, callModel: CallWorldModel, over: { rebuild?: boolean; now?: () => number } = {}) {
  return {
    home,
    packageRoot: PACKAGE_ROOT,
    worldDir: worldDir(home),
    selfId: SELF_ID,
    callModel,
    now: over.now ?? (() => NOW_MS),
    warn: () => undefined,
    ...(over.rebuild === undefined ? {} : { rebuild: over.rebuild }),
  }
}

describe('T29 —— 创世：世界与时钟都立起来，且能被正确加载', () => {
  it('⭐ 走完 world 步：实体在、T=0 锚在创世那一刻、只读呈现已导出', async () => {
    const home = await makeHome()
    const { callModel, prompts } = scripted([{ entities: entities() }])

    const outcome = await runWorldStep(options(home, callModel))

    expect(outcome.sequence).toBe(1)
    expect(outcome.detail).toContain('4 个实体')
    // 提示词里带着世界定义（装到位的那份）与她的 id
    expect(prompts[0]).toContain(SELF_ID)
    expect(prompts[0]).toContain('世界文档')

    // 世界定义也装到了 her 的数据目录（与包内一致）
    expect(await readFile(join(personaDir(home), 'world.md'), 'utf8')).toBe(
      await readFile(join(PACKAGE_ROOT, 'persona', 'world.md'), 'utf8'),
    )

    // ⭐ 内核读得回来
    const kernel = await WorldKernel.open(worldDir(home), { warn: () => undefined })
    expect(Object.keys(kernel.snapshot.entities).sort()).toEqual(['house', 'phone', 'street', SELF_ID])
    expect(kernel.snapshot.entities[SELF_ID]?.location).toBe('house')
    expect(kernel.snapshot.effectiveAt).toBe(0)

    // ⭐ 时钟读得回来，且 T=0 = 创世那一刻（不是"上次跑过的时间"）
    const clock = await WorldClock.open(worldDir(home), {
      now: () => NOW_MS,
      warn: () => undefined,
      tingleEveryUnits: 0, // 不放心跳（这一步写完就 suspend）
    })
    expect(clock.genesisMs).toBe(NOW_MS)
    expect(clock.now()).toBe(0)
    clock.stop()

    // 只读呈现（控制台的世界页读它）
    expect(await readFile(join(worldDir(home), 'world-status.md'), 'utf8')).toContain('小房子')
  })

  it('preset 也一起重装（世界定义进了 xiaoyan-world）', async () => {
    const home = await makeHome()
    const { callModel } = scripted([{ entities: entities() }])
    const outcome = await runWorldStep(options(home, callModel))

    expect(outcome.written.some((file) => file.includes('.agent-presets'))).toBe(true)
    const yml = await readFile(join(home, '.agent-presets', 'xiaoyan-world', 'agent.cordis.yml'), 'utf8')
    expect(yml).toContain('world-tools')
  })
})

describe('T29 —— 失败不留半成品（顺序：先创世、后时钟）', () => {
  it('⭐ 模型始终给不出合法清单 → 报错，且世界目录里既没事务也没时钟', async () => {
    const home = await makeHome()
    const { callModel } = scripted([{ entities: [{ id: SELF_ID, kind: 'actor', name: '小研', location: null }] }])

    await expect(runWorldStep(options(home, callModel))).rejects.toThrow(/合法的世界清单/)

    const state = await inspect(worldDir(home))
    expect(state.transactions).toBe(0)
    expect(state.clock).toBe(false) // ⚠️ 先创世后时钟的意义：失败时连时钟都不写
  })

  it('失败之后**还能重试成功**（没有留下需要重建的半成品）', async () => {
    const home = await makeHome()
    const bad = scripted([{ entities: null }])

    try {
      await runWorldStep(options(home, bad.callModel))
      expect.unreachable('应当失败')
    } catch (error) {
      // 内核的失败被包成**向导的失败**（控制台只需处理一种错误类型），但原因没丢
      expect(error).toBeInstanceOf(SetupError)
      expect((error as SetupError).code).toBe('STEP_FAILED')
      expect((error as SetupError).message).toContain('创世失败')
    }

    const good = scripted([{ entities: entities() }])
    const outcome = await runWorldStep(options(home, good.callModel))
    expect(outcome.sequence).toBe(1)
  })

  it('⭐ 改过人格源再重跑 → 新定义**同时**进 preset 与创世（同源由构造保证，不靠拦）', async () => {
    const home = await makeHome()
    const { callModel, prompts } = scripted([{ entities: entities() }, { entities: entities() }])
    await runWorldStep(options(home, callModel)) // 第一次：装源 + 创世

    const mine = '小研住在一个很小的阁楼里，窗台上有一盆没养活的薄荷。'
    await writeFile(join(personaDir(home), 'world.md'), mine, 'utf8')

    const outcome = await runWorldStep(options(home, callModel, { rebuild: true }))
    expect(outcome.sequence).toBe(1) // 新世界从 #1 重新起算

    // ① 装载的那份：已安装 preset 里嵌的人格段用的是**新写的**定义
    const yml = await readFile(join(home, '.agent-presets', 'xiaoyan-world', 'agent.cordis.yml'), 'utf8')
    expect(readEmbeddedPersona(yml)).toContain(mine)

    // ② 创世用的那份：喂给世界模型的 prompt 里也是同一句 —— 两处不同源就是这一步的缺陷本体
    expect(prompts.at(-1)).toContain(mine)
  })

  it('⚠️ 重跑**不覆盖**运营者改过的人格源（出厂文本只是起点，不是真相）', async () => {
    const home = await makeHome()
    const { callModel } = scripted([{ entities: entities() }])
    await runWorldStep(options(home, callModel))

    const mine = '小研住在一个很小的阁楼里。'
    await writeFile(join(personaDir(home), 'world.md'), mine, 'utf8')

    await runWorldStep(options(home, callModel, { rebuild: true }))
    expect(await readFile(join(personaDir(home), 'world.md'), 'utf8')).toBe(mine)
  })

  it('⭐ 装配失败时旧世界**还在原地**（不许先把活跃世界挪进归档）', async () => {
    const home = await makeHome()
    const { callModel } = scripted([{ entities: entities() }])
    await runWorldStep(options(home, callModel))

    // 一个没有 presets/ 的包根 → installPresets 直接抛（打包坏了），走到不了创世
    const broken = { ...options(home, callModel, { rebuild: true }), packageRoot: join(home, 'empty-package') }
    await mkdir(join(home, 'empty-package', 'persona'), { recursive: true })
    await writeFile(join(home, 'empty-package', 'persona', 'world.md'), '出厂文本', 'utf8')
    await expect(runWorldStep(broken)).rejects.toThrow(/一个 preset 都没有/)

    const world = await inspect(join(home, 'yanxin/world'))
    expect(world.transactions).toBe(1) // 第一次创世的那条事务原封未动
    const siblings = await readdir(join(home, 'yanxin'))
    expect(siblings.some((name) => name.includes('-archive-'))).toBe(false)
  })
})

describe('T29 —— 已存在就拒重建 / 重建是归档不是删除', () => {
  it('⭐ 世界已存在且没说要重建 → 拒，且旧世界一格没动', async () => {
    const home = await makeHome()
    const first = scripted([{ entities: entities() }])
    await runWorldStep(options(home, first.callModel))

    const clockBefore = await readFile(join(worldDir(home), 'clock.json'), 'utf8')
    const logBefore = await readFile(join(worldDir(home), 'world-transactions.jsonl'), 'utf8')

    try {
      await runWorldStep(options(home, first.callModel))
      expect.unreachable('应当拒绝重建')
    } catch (error) {
      expect(error).toBeInstanceOf(SetupError)
      expect((error as SetupError).code).toBe('STEP_BLOCKED')
      expect((error as SetupError).summary).toContain('rebuild')
    }

    expect(await readFile(join(worldDir(home), 'clock.json'), 'utf8')).toBe(clockBefore)
    expect(await readFile(join(worldDir(home), 'world-transactions.jsonl'), 'utf8')).toBe(logBefore)
  })

  it('⭐ rebuild: true → 旧世界**归档**（连她的笔记一起保留），新世界重头开始', async () => {
    const home = await makeHome()
    const first = scripted([{ entities: entities() }])
    await runWorldStep(options(home, first.callModel))

    // 她写过一篇日记 —— 重建之后它该躺在归档里，而不是消失
    const notes = await WorldNotes.open(worldDir(home))
    await notes.write('重建之前', '这些东西不该丢')

    // 新世界用一份不同的清单（好断言"真的是新的"）
    const second = scripted([
      { entities: [...entities(), { id: 'cat', kind: 'object', name: '猫', location: 'house', owner: SELF_ID }] },
    ])
    const outcome = await runWorldStep(options(home, second.callModel, { rebuild: true, now: () => NOW_MS + 60_000 }))

    expect(outcome.archived).toBeDefined()
    expect(outcome.detail).toBeDefined()

    // 归档里躺着旧世界与她的笔记（改名保留，没有删除）
    const archive = outcome.archived ?? ''
    expect((await stat(archive)).isDirectory()).toBe(true)
    expect(await readFile(join(archive, 'notes', '重建之前.md'), 'utf8')).toBe('这些东西不该丢')

    // 新世界：多了一只猫，T=0 也换成了新的那一刻
    const kernel = await WorldKernel.open(worldDir(home), { warn: () => undefined })
    expect(kernel.snapshot.entities['cat']).toBeDefined()
    const clock = await WorldClock.open(worldDir(home), { now: () => NOW_MS + 60_000, warn: () => undefined, tingleEveryUnits: 0 })
    expect(clock.genesisMs).toBe(NOW_MS + 60_000)
    expect(clock.now()).toBe(0)
    clock.stop()
  })
})

describe('T29 —— 现场读取（判定用的证据）', () => {
  it('没有世界时：0 条事务、没有时钟', async () => {
    const home = await makeHome()
    expect(await inspect(worldDir(home))).toEqual({ transactions: 0, clock: false })
  })

  it('半行（append 被打断的痕迹）不算一条事务 —— 与内核重放的判断一致', async () => {
    const home = await makeHome()
    await mkdir(worldDir(home), { recursive: true })
    await writeFile(
      join(worldDir(home), 'world-transactions.jsonl'),
      '{"sequence":1,"proposal":{}}\n{"sequence":2,"prop',
      'utf8',
    )

    expect((await inspect(worldDir(home))).transactions).toBe(1)
  })

  it('归档目录不进现场判定（重建之后现场是干净的）', async () => {
    const home = await makeHome()
    const { callModel } = scripted([{ entities: entities() }])
    await runWorldStep(options(home, callModel))
    await runWorldStep(options(home, scripted([{ entities: entities() }]).callModel, { rebuild: true }))

    const entries = await readdir(join(home, 'yanxin'))
    expect(entries.filter((entry) => entry.startsWith('world-archive-'))).toHaveLength(1)
    expect(entries).toContain('world')
  })
})