/**
 * 人格页的**接线与写路径**验收（真 console + 真文件系统，临时 `$DSH_HOME`）。
 *
 * 为什么必须走真 HTTP 与真磁盘：这一页要证明的正是"三步并成一步"这件事 ——
 *   1. 表单是多行的（`textarea`），且值里带着**现在装着的**文本（不然运营者是盲改）
 *   2. 保存之后**两样东西都变了**：人格源文件 + 已安装 preset 里嵌的那一段
 *      （只写文件不重嵌 = 她继续按旧人格说话，那正是这一页要消灭的错法）
 *   3. 该拒的拒：空文本、白名单外的键
 *   4. 桥在不在都能存（软查），但在的话要喊它放手空闲会话
 *
 * ⚠️ 路径隔离：`install.ts` 的 `dshHome()` 每次调用都读 `process.env.DSH_HOME`，
 * 所以这里在 beforeEach 里换掉、afterEach 里还原 —— 否则测试会往真 `~/.dsh` 里装 preset。
 */
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ConsoleService from '../../src/console/index.ts'
import { TOKEN_ENV } from '../../src/console/logic.ts'
import { readEmbeddedPersona } from '../../src/preset/persona-embed.ts'
import { installPresets, personaDir, presetRoot, type InstallPaths } from '../../src/setup/install.ts'
import MemorySettings from '../support/memory-settings.ts'

const opened: Context[] = []
const dirs: string[] = []
let savedHome: string | undefined
let savedToken: string | undefined

beforeEach(async () => {
  savedHome = process.env.DSH_HOME
  savedToken = process.env[TOKEN_ENV]
  const home = await mkdtemp(join(tmpdir(), 'yanxin-persona-page-'))
  dirs.push(home)
  process.env.DSH_HOME = home
  process.env[TOKEN_ENV] = 's3cret'
})

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedToken === undefined) delete process.env[TOKEN_ENV]
  else process.env[TOKEN_ENV] = savedToken
})

/** 包根就是本仓（vitest 直接从 src 读）—— 页里的 `defaultPackageRoot()` 得到的也是它。 */
function paths(): InstallPaths {
  return { home: process.env.DSH_HOME as string, packageRoot: join(import.meta.dirname, '../..') }
}

/** 起真控制台 + 人格页；`withBridge` 用一个假的桥对象顶上 `onebot-bridge`。 */
async function makePage(bridge?: { dropIdleAgents: (reason: string) => number }) {
  const ctx = new Context()
  opened.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(MemorySettings)
  await ctx.plugin(ConsoleService, { statsPath: ':memory:' })
  await ctx.plugin(await import('../../src/console/pages/persona.ts'))
  if (bridge !== undefined) {
    // 页里是 `ctx.get('onebot-bridge')` 软查 —— 测试用 provide 把它顶上
    const provide = (ctx as unknown as { provide: (name: string, value: unknown) => unknown }).provide.bind(ctx)
    provide('onebot-bridge', bridge)
  }
  return { ctx, base: `http://127.0.0.1:${ctx.webServer.port}/yanxin` }
}

async function post(base: string, body: Record<string, unknown>): Promise<{ ok: boolean; error: string; detail: string }> {
  const response = await fetch(`${base}/api/persona/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as { ok: boolean; data?: { error?: string; detail?: string } }
  return {
    ok: payload.ok,
    error: payload.data?.error ?? '',
    detail: payload.data?.detail ?? '',
  }
}

describe('人格页 —— 读：页上给的是**现在装着的**文本', () => {
  it('⭐ 三个 textarea，值来自人格源（装机后没写过就是包内出厂文本）', async () => {
    const { base } = await makePage()
    const response = await fetch(`${base}/api/page/persona`)
    const payload = (await response.json()) as { data: { blocks: unknown[]; title: string } }
    const text = JSON.stringify(payload.data.blocks)

    expect(payload.data.title).toBe('人格')
    expect(text).toContain('"type":"textarea"')
    for (const name of ['base', 'profile', 'world']) expect(text, name).toContain(`"name":"${name}"`)
    // 值是实际内容而不是空串：运营者不该在盲改
    expect(text).toContain('小研')
  })

  it('这一页进导航（不在页表里就等于没有这页）', async () => {
    const { base } = await makePage()
    const payload = (await (await fetch(`${base}/api/page/persona`)).json()) as { data: { pages: { slug: string }[] } }
    expect(payload.data.pages.map((page) => page.slug)).toContain('persona')
  })
})

describe('人格页 —— 写：文件与已安装 preset 必须一起变', () => {
  it('⭐ 保存后：源文件是新文本，且 preset 里嵌的那一段也是新文本', async () => {
    const home = process.env.DSH_HOME as string
    await mkdir(personaDir(home), { recursive: true })
    await writeFile(join(personaDir(home), 'base.md'), '旧的基底。', 'utf8')
    await writeFile(join(personaDir(home), 'profile.md'), '旧的背景。', 'utf8')
    await writeFile(join(personaDir(home), 'world.md'), '旧的世界。', 'utf8')
    await installPresets(paths()) // 先装一遍，做出"已安装 preset"的现场

    const { base } = await makePage()
    const result = await post(base, { base: '她自己挑的昵称是小研。', profile: '旧的背景。', world: '旧的世界。' })
    expect(result.error, `保存失败：${result.error}`).toBe('')

    expect(await readFile(join(personaDir(home), 'base.md'), 'utf8')).toContain('她自己挑的昵称是小研。')

    const yml = await readFile(join(presetRoot(home), 'xiaoyan-agent', 'agent.cordis.yml'), 'utf8')
    const embedded = readEmbeddedPersona(yml)
    expect(embedded).toContain('她自己挑的昵称是小研。')
    expect(embedded).not.toContain('旧的基底')
    // 结构行没被带走：世界 preset 的世界工具、各 preset 的 web 行都还在
    const worldYml = await readFile(join(presetRoot(home), 'xiaoyan-world', 'agent.cordis.yml'), 'utf8')
    expect(worldYml).toContain('world-tools')
  })

  it('只写来的那一栏：没提交的文件不许被动', async () => {
    const home = process.env.DSH_HOME as string
    await mkdir(personaDir(home), { recursive: true })
    await writeFile(join(personaDir(home), 'base.md'), '别碰我。', 'utf8')
    await writeFile(join(personaDir(home), 'profile.md'), '也别碰我。', 'utf8')
    await writeFile(join(personaDir(home), 'world.md'), '还是别碰我。', 'utf8')
    await installPresets(paths())

    const { base } = await makePage()
    await post(base, { base: '新的一句基底。' }) // 只提交 base

    expect(await readFile(join(personaDir(home), 'profile.md'), 'utf8')).toBe('也别碰我。')
    expect(await readFile(join(personaDir(home), 'world.md'), 'utf8')).toBe('还是别碰我。')
    expect(readEmbeddedPersona(await readFile(join(presetRoot(home), 'xiaoyan-agent', 'agent.cordis.yml'), 'utf8'))).toContain(
      '新的一句基底。',
    )
  })

  it('⭐ 空文本一律拒（清空她的 system prompt 不该由一次误提交完成）', async () => {
    const { base } = await makePage()
    const result = await post(base, { base: '   \n  ' })
    expect(result.ok).toBe(true) // 请求本身没问题
    expect(result.error).toContain('不接受空人格')
  })

  it('白名单外的键不看（这一页只认 base / profile / world）', async () => {
    const { base } = await makePage()
    const result = await post(base, { base: '一句真话。', preset: 'xiaoyan-admin', cwd: '/' })
    expect(result.error).toContain('这一页不接受')
  })

  it('一个字段都没给 → 明确说没收到，而不是"保存了个寂寞"', async () => {
    const { base } = await makePage()
    expect((await post(base, {})).error).toContain('没收到任何人格文本')
  })

  it('桥在 → 喊它放手空闲会话；桥不在 → 照样存得下', async () => {
    const reasons: string[] = []
    const { base } = await makePage({
      dropIdleAgents: (reason) => {
        reasons.push(reason)
        return 2
      },
    })
    const result = await post(base, { base: '她换了个说法。', profile: '背景。', world: '世界。' })
    expect(result.error).toBe('')
    expect(reasons).toHaveLength(1)
    expect(result.detail).toContain('2 个空闲会话')
  })
})
