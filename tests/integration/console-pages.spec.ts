/**
 * 控制台九页的**真实装配**验收（T32/T33 + 日志页）—— Checkpoint 7 的那条"控制台页面可用"。
 *
 * 与 `console-pages.spec.ts` 的分工：那边测"区块排版对不对"（纯函数），
 * 这边测**接线**：真 `webServer` + 真 `console` + 真页面插件行 + 真的
 * `admin` / `window` 服务（settings 用内存 provider）。
 *
 * 三件必须真测的事（都是"单测全绿但装配坏掉"的形态）：
 *
 *   1. **九个页面都在导航里**，且每页能取到自己的区块（页面插件靠 `ctx.effect` 登记，
 *      漏了 effect 就会"卸了还在"或"挂了不响应"）
 *   2. **改时段之后窗口真的重新裁决**（T32 的验收：改窗口后调度器下次 tick 采用）——
 *      断到假 loader 的 `update({disabled})` 上：窗口覆盖"现在"→ 引擎行被启用
 *   3. **写操作进审计**（`$DSH_HOME/yanxin/audit/console.jsonl`）+ **检索要 token**
 *      （记忆页的取舍：内容是她的对话痕迹）
 */
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AdminService from '../../src/admin/index.ts'
import ConsoleService from '../../src/console/index.ts'
import { TOKEN_ENV } from '../../src/console/logic.ts'
import { auditFile } from '../../src/audit/log.ts'
import WindowService from '../../src/window/index.ts'
import MemorySettings from '../support/memory-settings.ts'

const opened: Context[] = []
let savedToken: string | undefined

beforeEach(() => {
  savedToken = process.env[TOKEN_ENV]
  process.env[TOKEN_ENV] = 's3cret'
})

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
  if (savedToken === undefined) delete process.env[TOKEN_ENV]
  else process.env[TOKEN_ENV] = savedToken
})

/** 九个页面插件（顺序即导航顺序）。 */
const PAGE_MODULES = [
  '../../src/console/pages/setup.ts',
  '../../src/console/pages/admins.ts',
  '../../src/console/pages/window.ts',
  '../../src/console/pages/settings.ts',
  '../../src/console/pages/world.ts',
  '../../src/console/pages/memory.ts',
  '../../src/console/pages/talk.ts',
  '../../src/console/pages/log.ts',
  '../../src/console/pages/onebot.ts',
] as const

const SLUGS = ['setup', 'admins', 'window', 'settings', 'world', 'memory', 'talk', 'log', 'onebot']

/** 假 loader entry（窗口服务用它装卸引擎行）。形状照 `LoaderEntryLike` 的最小面。 */
function fakeEngineEntry(id = 'yanxin-world-engine') {
  return {
    options: { id },
    disabled: true,
    updates: [] as { disabled: boolean }[],
    async update(patch: { disabled: boolean }) {
      this.updates.push(patch)
      this.disabled = patch.disabled
    },
  }
}

/** 软查的服务（页面对它们是 `ctx.get`）。 */
interface Fakes {
  memory?: unknown
  world?: unknown
  sessions?: unknown
  setup?: unknown
}

/**
 * 一份"就绪"的向导进度。
 *
 * 为什么集成用例也要给：窗口服务在启用引擎行之前会**问一次守卫**"世界创世了吗"
 * （T30：世界里还没有她，就别让她过日子）。不给这份进度，窗口裁决会停在
 * "时间在窗口内但世界不存在"——那时不启用引擎行是**正确行为**，
 * 而本文件要测的是"改时段 → 引擎被启用"那一段，所以要把世界那一半补齐。
 */
function readyProgress() {
  return {
    status: 'ready' as const,
    next: null,
    steps: [
      { step: 'persona', completed: true, satisfied: true, runnable: true, missing: [] },
      { step: 'background', completed: true, satisfied: true, runnable: true, missing: [] },
      { step: 'world', completed: true, satisfied: true, runnable: true, missing: [] },
      { step: 'accounts', completed: true, satisfied: true, runnable: true, missing: [] },
    ],
    reverted: [],
    warnings: [],
  }
}

async function makeConsole(fakes: Fakes = {}, options: { bare?: boolean } = {}) {
  const ctx = new Context()
  opened.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(MemorySettings)

  const provide = (ctx as unknown as { provide: (name: string, value: unknown) => unknown }).provide.bind(ctx)
  const entry = fakeEngineEntry()
  let window: WindowService | undefined
  let admin: AdminService | undefined

  if (options.bare !== true) {
    // 真服务：admin / window（它们要的 settings 已就位）
    admin = new AdminService(ctx)
    ;(ctx as unknown as { loader?: unknown }).loader = {
      entries: () =>
        (function* () {
          yield entry
        })(),
    }
    window = new WindowService(ctx)
    // 默认给"世界已就绪"的向导进度（窗口裁决要用；见 readyProgress 的说明）
    provide('setup', { progress: async () => readyProgress() })
  }
  for (const [key, value] of Object.entries(fakes)) provide(key, value)

  // 统计库指向 **:memory:**（每个 console 实例独立；测试不该写真实 $DSH_HOME）
  await ctx.plugin(ConsoleService, { statsPath: ':memory:' })
  for (const path of PAGE_MODULES) await ctx.plugin(await import(path))
  return { ctx, base: `http://127.0.0.1:${ctx.webServer.port}/yanxin`, entry, admin, window }
}

/** 取一页的 payload。 */
async function page(base: string, slug: string, query = '') {
  const response = await fetch(`${base}/api/page/${slug}${query}`)
  return (await response.json()) as {
    ok: boolean
    data: { title: string; pages: { slug: string; title: string }[]; blocks: unknown[] }
  }
}

/** 一个覆盖"现在"的时段（跨天也没问题 —— 窗口服务支持跨天）。 */
function windowAroundNow(): { start: string; end: string; text: string } {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const format = (ms: number): string => {
    const date = new Date(ms)
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  const now = Date.now()
  const start = format(now - 2 * 3600_000)
  const end = format(now + 2 * 3600_000)
  return { start, end, text: `${start}-${end}` }
}

describe('T32/T33 —— 九页真的挂上了（Checkpoint 7 + 日志页）', () => {
  it('⭐ `/api/page` 的导航里有九个页面，每页都能取到标题与区块', async () => {
    const { base } = await makeConsole()
    const home = await page(base, 'setup')
    expect(home.data.pages.map((entry) => entry.slug)).toEqual(SLUGS)

    const titles: string[] = []
    for (const slug of SLUGS) {
      const payload = await page(base, slug)
      expect(payload.ok, slug).toBe(true)
      expect(payload.data.blocks.length, slug).toBeGreaterThan(0)
      titles.push(payload.data.title)
    }
    expect(titles).toEqual(['初始化', '管理员', '时段', '设置', '世界', '记忆', '对话', '日志', 'OneBot 连接'])
  })

  it('首页列出九页（运维一眼看到有什么可点）', async () => {
    const { base } = await makeConsole()
    const payload = await page(base, 'setup')
    const home = (await (await fetch(`${base}/api/page`)).json()) as { data: { blocks: { text?: string }[] } }
    expect(JSON.stringify(home.data.blocks)).toContain('管理员')
    void payload
  })

  it('卸载一页 → 它从导航里消失（登记绑在自己的 fiber 上）', async () => {
    const { ctx, base } = await makeConsole()
    const fiber = await ctx.plugin(await import('../../src/console/pages/talk.ts'))
    expect((await page(base, 'setup')).data.pages.map((entry) => entry.slug)).toContain('talk')

    await fiber.dispose()
    const after = (await page(base, 'setup')).data.pages.map((entry) => entry.slug)
    expect(after.filter((slug) => slug === 'talk')).toHaveLength(1) // 原本那一行还在
  })
})

describe('T32 —— 管理员页：改名单、进审计', () => {
  it('⭐ 加入 → 立刻生效（名单变了）；移出 → 回到空', async () => {
    const { base, admin } = await makeConsole()
    const post = (route: string, body: unknown): Promise<Response> =>
      fetch(`${base}/api/admins/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
        body: JSON.stringify(body),
      })

    await post('add', { senderId: '1000000001' })
    expect(admin?.admins).toEqual(['1000000001'])

    const removed = (await (await post('remove', { senderId: '1000000001' })).json()) as { data: { detail: string } }
    expect(admin?.admins).toEqual([])
    expect(removed.data.detail).toContain('已移出')

    // 页面跟着变（列表是每次渲染现读的，不缓存）
    const after = JSON.stringify((await page(base, 'admins')).data.blocks)
    expect(after).toContain('没有任何人是管理员')
  })

  it('号码形态不对：明确拒绝（不是静默无操作）', async () => {
    const { base, admin } = await makeConsole()
    const response = await fetch(`${base}/api/admins/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
      body: JSON.stringify({ senderId: 'abc' }),
    })
    const payload = (await response.json()) as { data: { error: string } }
    expect(payload.data.error).toContain('没给有效的 QQ 号')
    expect(admin?.admins).toEqual([])
  })

  it('⭐ 写操作进审计：`console.jsonl` 里有那一行（含路径与结果）', async () => {
    const { base } = await makeConsole()
    await fetch(`${base}/api/admins/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
      body: JSON.stringify({ senderId: '1000000001' }),
    })

    const lines = readFileSync(auditFile('console'), 'utf8').split('\n').filter((line) => line !== '')
    const record = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>
    expect(record.path).toBe('/yanxin/api/admins/add')
    expect(record.method).toBe('POST')
    expect(record.ok).toBe(true)
    expect(typeof record.at).toBe('string')
  })

  it('没带 token 的写操作被拒（401），且名单没变', async () => {
    const { base, admin } = await makeConsole()
    const response = await fetch(`${base}/api/admins/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ senderId: '1000000001' }),
    })
    expect(response.status).toBe(401)
    expect(admin?.admins).toEqual([])
  })
})

describe('T32 —— 时段页：写进去之后窗口真的重新裁决', () => {
  it('⭐ 保存一个覆盖现在的时段 → 引擎行被启用（不是等下一个 tick）', async () => {
    const { base, ctx, entry } = await makeConsole()
    const round = windowAroundNow()

    const payload = (await (
      await fetch(`${base}/api/window/set`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
        body: JSON.stringify({ windows: round.text }),
      })
    ).json()) as { data: { detail: string } }
    expect(payload.data.detail).toContain(round.start)

    // settings 里真的写进去了
    const value = ctx.settings.get('yanxin-window') as { windows?: { start: string; end: string }[] }
    expect(value.windows).toEqual([{ start: round.start, end: round.end }])

    // 窗口服务 watch 着它 → 裁决已跑；等一小会儿让 effect/loader 落地
    const deadline = Date.now() + 1_000
    while (entry.updates.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(entry.updates.length).toBeGreaterThan(0)
    expect(entry.updates[entry.updates.length - 1]).toEqual({ disabled: false })
  })

  it('时段写得不成样子：拒绝，且 settings 不变', async () => {
    const { base, ctx } = await makeConsole()
    const response = await fetch(`${base}/api/window/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
      body: JSON.stringify({ windows: '下午两点到六点' }),
    })
    const payload = (await response.json()) as { data: { error: string } }
    expect(payload.data.error).toContain('看不懂这个时段')
    expect((ctx.settings.get('yanxin-window') as { windows?: unknown }).windows).toBeUndefined()
  })
})

describe('T33 —— 世界 / 记忆 / 对话三页', () => {
  it('世界页：把 TU、纪元、事务数与笔记显示出来', async () => {
    const { base } = await makeConsole({
      world: {
        status: () => ({
          ready: true,
          tu: 4321,
          era: 1_790_458_038_648,
          sequence: 5,
          entities: 10,
          actions: 2,
          ticks: 7,
          inbound: 11,
        }),
        listNotes: async () => ['今天', '关于光'],
        look: () => ({
          placeHandle: 'seen:2',
          entities: [
            { handle: 'seen:1', name: '小研', kind: 'actor', self: true },
            { handle: 'seen:2', name: '小房子', kind: 'place', self: false },
          ],
        }),
      },
    })

    const text = JSON.stringify((await page(base, 'world')).data.blocks)
    expect(text).toContain('4321')
    expect(text).toContain('小房子')
    expect(text).toContain('关于光')
    expect(text).toContain('已提交事务')
  })

  it('记忆页：健康状态在页面上；检索要 token（内容是她全部的对话痕迹）', async () => {
    const searched: string[] = []
    const { base } = await makeConsole({
      memory: {
        providerId: 'reme',
        health: async () => ({ ok: true }),
        search: async (query: string) => {
          searched.push(query)
          return [{ content: '下午的光斜进来', source: 'daily/2026-09-27.md', lines: [3, 5], sessionId: 'world:2000000002' }]
        },
      },
    })

    expect(JSON.stringify((await page(base, 'memory')).data.blocks)).toContain('reme，可用')

    // 不带 token：401（带了但不对是 401；服务器**没配** token 时才是 403 fail-closed），
    // 且**没有**真的去查
    const denied = await fetch(`${base}/api/memory/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '光' }),
    })
    expect(denied.status).toBe(401)
    expect(searched).toEqual([])

    // 带 token：查到，且结果作为区块回给浏览器端渲染
    const ok = (await (
      await fetch(`${base}/api/memory/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
        body: JSON.stringify({ query: '光' }),
      })
    ).json()) as { data: { detail: string; blocks: unknown[] } }
    expect(searched).toEqual(['光'])
    expect(ok.data.detail).toContain('命中 1 条')
    expect(JSON.stringify(ok.data.blocks)).toContain('daily/2026-09-27.md')
  })

  it('对话页：活着的会话可点，时间轴按会话显示（含入站消息的溯源）', async () => {
    const events = [
      { type: 'turn/start', seq: 1, time: 1_790_458_000_000, data: {} },
      {
        type: 'user/message',
        seq: 2,
        time: 1_790_458_001_000,
        data: {
          message: {
            content: [{ type: 'text', text: '早上好' }],
            source: { kind: 'qq', mode: 'admin', userId: '1000000001' },
          },
        },
      },
      { type: 'tool/call', seq: 3, time: 1_790_458_002_000, data: { name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', seq: 4, time: 1_790_458_003_000, data: {} },
    ]
    const session = { id: 'admin:1000000001', events }
    const { base } = await makeConsole({
      sessions: {
        list: () => [session],
        get: (id: string) => (id === session.id ? session : undefined),
      },
    })

    const list = (await page(base, 'talk')).data.blocks
    expect(JSON.stringify(list)).toContain('admin:1000000001')

    const detail = JSON.stringify((await page(base, 'talk', '?session=admin%3A1000000001')).data.blocks)
    expect(detail).toContain('【admin】')
    expect(detail).toContain('早上好')
    expect(detail).toContain('bash(') // 工具调用
    expect(detail).toContain('ls') // 参数原样带出来
    expect(detail).toContain('user/message')
    expect(detail).toContain('tool/result')
  })

  it('服务不在时三页都降级成一句可操作的话（不崩）', async () => {
    // `bare`：连 admin / window 都不起（模拟"这些行没装载"）—— 三个页面都该只显示一句
    // 可操作的话。窗口关着那种"引擎被卸下"的说法在单元用例里（`worldMissingBlocks(false)`），
    // 实机也在清晨时段验证过。
    const { base } = await makeConsole({}, { bare: true })
    for (const slug of ['world', 'memory', 'talk']) {
      expect(JSON.stringify((await page(base, slug)).data.blocks), slug).toContain('服务不在')
    }
    expect(JSON.stringify((await page(base, 'admins')).data.blocks)).toContain('管理员服务不在')
  })
})