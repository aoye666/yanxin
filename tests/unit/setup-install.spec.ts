/**
 * 落地动作与证据读取的单元验收（T28c + T29 的取材面）。
 *
 * 集成测试（`setup-service.spec.ts` / `setup-world-step.spec.ts`）用的是**真包**（本仓的
 * `persona/` 与 `presets/`），所以有些形态只能在单元层造：包内源是空的、preset 目录缺文件、
 * 运营者已经改过那份人格源。这里用手搭的临时"包根"把这些边界钉住。
 *
 * 最要紧的一条：**在位就不装**（present-if-absent）。向导鼓励"回退重跑"，而无条件覆盖
 * 会让一次回退抹掉运营者改过的人格 —— 那是不可接受的（人格是他的东西）。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installPersonaSource,
  installPresets,
  personaDir,
  presetRoot,
  readEvidence,
  sourcePresets,
  writeAtomic,
} from '../../src/setup/install.ts'

const dirs: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yanxin-install-'))
  dirs.push(dir)
  return dir
}

/** 手搭一个"包根"：`persona/` + `presets/`。 */
async function fakePackage(over: { base?: string; presets?: Record<string, string[]> } = {}): Promise<string> {
  const root = await scratch()
  await mkdir(join(root, 'persona'), { recursive: true })
  await writeFile(join(root, 'persona', 'base.md'), over.base ?? '人格基底（出厂文本）', 'utf8')
  await writeFile(join(root, 'persona', 'profile.md'), '背景资料（出厂文本）', 'utf8')
  await writeFile(join(root, 'persona', 'world.md'), '世界定义（出厂文本）', 'utf8')

  for (const [id, files] of Object.entries(over.presets ?? { 'xiaoyan-agent': ['agent.cordis.yml', 'preset.yml'] })) {
    await mkdir(join(root, 'presets', id), { recursive: true })
    for (const file of files) await writeFile(join(root, 'presets', id, file), `${id} 的 ${file}`, 'utf8')
  }
  return root
}

describe('T28c —— 人格源：在位就不装（人格是运营者的东西）', () => {
  it('目标不存在 → 从包内装一份，落盘内容一致', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage()

    const outcome = await installPersonaSource({ home, packageRoot }, 'persona')

    expect(outcome.detail).toContain('已就位')
    expect(outcome.written).toEqual([join('yanxin', 'persona', 'base.md')])
    expect(await readdir(personaDir(home))).toEqual(['base.md'])
  })

  it('⭐ 已经有一份（非空）→ **不覆盖**，如实说"保留你自己那份"', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage()
    await mkdir(personaDir(home), { recursive: true })
    await writeFile(join(personaDir(home), 'base.md'), '这是我自己写的人格。', 'utf8')

    const outcome = await installPersonaSource({ home, packageRoot }, 'persona')

    expect(outcome.written).toEqual([])
    expect(outcome.detail).toContain('保留')
    expect(await readFile(join(personaDir(home), 'base.md'), 'utf8')).toBe('这是我自己写的人格。')
  })

  it('只有空白不算"在位"（空不是一份人格）→ 重新装', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage()
    await mkdir(personaDir(home), { recursive: true })
    await writeFile(join(personaDir(home), 'base.md'), '   \n\n', 'utf8')

    const outcome = await installPersonaSource({ home, packageRoot }, 'persona')
    expect(outcome.written).toHaveLength(1)
  })

  it('包内源是空的 → 抛错（打包漏了 persona/ 要立刻可见，不能装空人格下去）', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage({ base: '   \n' })

    await expect(installPersonaSource({ home, packageRoot }, 'persona')).rejects.toThrow(/包内的人格源是空的/)
  })

  it('accounts 步没有源文件（它绑的是账号，源在部署配置里）', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage()
    expect((await installPersonaSource({ home, packageRoot }, 'accounts')).written).toEqual([])
  })
})

describe('T28c —— preset 安装', () => {
  it('只认有 agent.cordis.yml 的目录（杂物不算 preset）', async () => {
    const packageRoot = await fakePackage({
      presets: { 'xiaoyan-agent': ['agent.cordis.yml'], '不是 preset': ['readme.md'] },
    })
    expect(await sourcePresets(packageRoot)).toEqual(['xiaoyan-agent'])
  })

  it('装到 $DSH_HOME/.agent-presets/，内容与包内一致，无 .tmp 残留', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage({
      presets: { 'xiaoyan-agent': ['agent.cordis.yml', 'preset.yml'], 'xiaoyan-world': ['agent.cordis.yml'] },
    })

    const outcome = await installPresets({ home, packageRoot })

    expect(outcome.detail).toContain('2 个 preset')
    expect((await readdir(presetRoot(home))).sort()).toEqual(['xiaoyan-agent', 'xiaoyan-world'])
    expect((await readdir(join(presetRoot(home), 'xiaoyan-agent'))).sort()).toEqual(['agent.cordis.yml', 'preset.yml'])
    expect((await readdir(presetRoot(home))).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('包内一个 preset 都没有 → 抛错（不能"装好了 0 个"）', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage({ presets: {} })
    await expect(installPresets({ home, packageRoot })).rejects.toThrow(/一个 preset 都没有/)
  })

  it('包根的 presets/ 目录整个不在 → 同样是那条明确的错误（而不是 ENOENT）', async () => {
    const home = await scratch()
    const packageRoot = await scratch() // 空目录：连 presets/ 都没有
    expect(await sourcePresets(packageRoot)).toEqual([])
    await expect(installPresets({ home, packageRoot })).rejects.toThrow(/一个 preset 都没有/)
  })

  it('preset 总是重装（它是生成产物，不是运营者的文本）', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage()
    await installPresets({ home, packageRoot })
    await writeFile(join(presetRoot(home), 'xiaoyan-agent', 'agent.cordis.yml'), '被人手改了', 'utf8')

    await installPresets({ home, packageRoot })
    expect(await readFile(join(presetRoot(home), 'xiaoyan-agent', 'agent.cordis.yml'), 'utf8')).toBe(
      'xiaoyan-agent 的 agent.cordis.yml',
    )
  })
})

describe('T28c —— 证据读取只回答事实', () => {
  it('人格源：有内容才算有（空白不算）；preset 装了几个算几个', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage({
      presets: { 'xiaoyan-agent': ['agent.cordis.yml'], 'xiaoyan-world': ['agent.cordis.yml'] },
    })
    await mkdir(personaDir(home), { recursive: true })
    await writeFile(join(personaDir(home), 'base.md'), '有内容', 'utf8')
    await writeFile(join(personaDir(home), 'profile.md'), '  \n', 'utf8')
    await installPresets({ home, packageRoot })
    // 第二个 preset 只装了一半（手工造"装漏了"的形态）
    await rm(join(presetRoot(home), 'xiaoyan-world', 'agent.cordis.yml'), { force: true })

    const evidence = await readEvidence({ home, packageRoot }, { registered: [], connected: [] })

    expect(evidence.persona.base).toBe(true)
    expect(evidence.persona.profile).toBe(false)
    expect(evidence.presets).toEqual({ installed: 1, total: 2 })
  })

  it('世界证据：能解析的行才算事务、clock.json 要带纪元锚点', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage()
    const world = join(home, 'yanxin', 'world')
    await mkdir(world, { recursive: true })
    await writeFile(join(world, 'world-transactions.jsonl'), '{"sequence":1}\n{"sequence":2}\n半行', 'utf8')
    await writeFile(join(world, 'clock.json'), '{"genesisMs":1}', 'utf8')

    const evidence = await readEvidence({ home, packageRoot }, { registered: [], connected: [] })
    expect(evidence.world).toEqual({ transactions: 2, clock: true })
  })

  it('clock.json 缺锚点（或坏掉）→ 不算有时钟', async () => {
    const home = await scratch()
    const packageRoot = await fakePackage()
    const world = join(home, 'yanxin', 'world')
    await mkdir(world, { recursive: true })
    await writeFile(join(world, 'clock.json'), '{"accumulatedTU":3}', 'utf8')

    const evidence = await readEvidence({ home, packageRoot }, { registered: ['1'], connected: [] })
    expect(evidence.world.clock).toBe(false)
    expect(evidence.accounts.registered).toEqual(['1'])
  })
})

describe('T28c —— 原子写', () => {
  it('目录不存在时会建；写完没有 .tmp 残留', async () => {
    const home = await scratch()
    const target = join(home, 'a', 'b', 'c.txt')
    await writeAtomic(target, '内容')

    expect(await readFile(target, 'utf8')).toBe('内容')
    expect(await readdir(join(home, 'a', 'b'))).toEqual(['c.txt'])
  })
})