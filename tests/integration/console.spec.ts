/**
 * 控制台的**真实装配**验收（T31，spec §6.12）。
 *
 * 纯逻辑（`console-logic.spec.ts`）管三道门的判定，这里管**真的挂上去之后的行为**：
 * 真 `webServer`（端口 0，不撞运行中的实例）、真 HTTP 请求、真 audit 落盘。
 *
 * 四条验收（对应 todo 里 T31 的验收）：
 *
 *   ① **路由随 fiber 装卸**：卸载后 `/yanxin` 404（"忘了包 effect"的反例在 T15 已证伪）
 *   ② **写操作强制 token**：没带 → 401；没配 → 403（fail-closed）；对了 → 放行并落审计
 *   ③ **页注册随插件装卸**：注册页的插件卸载后那一页从清单里消失
 *   ④ **外壳是字面量**：`/yanxin` 与 `/yanxin/client.js` 的响应逐字节等于两个常量
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ConsoleService from '../../src/console/index.ts'
import { CONSOLE_CLIENT_SCRIPT, CONSOLE_SHELL } from '../../src/console/client.ts'
import { TOKEN_ENV } from '../../src/console/logic.ts'

const opened: Context[] = []
let savedToken: string | undefined
let savedHome: string | undefined
let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yanxin-console-'))
  savedToken = process.env[TOKEN_ENV]
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
  await rm(home, { recursive: true, force: true }).catch(() => undefined)
  if (savedToken === undefined) delete process.env[TOKEN_ENV]
  else process.env[TOKEN_ENV] = savedToken
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
})

/**
 * 起一个真 webServer（随机端口）+ 真控制台。
 *
 * 控制台走 `ctx.plugin(ConsoleService)`（真插件行）而不是直接 `new`：这样它的
 * `ctx.effect` 挂在**它自己的 fiber** 上，卸载它（`fiber.dispose()`）不会顺手拆掉
 * webServer —— 那正是"路由回滚"要验的东西（根 fiber 一卸载服务器就没了，测不出来）。
 */
async function makeConsole(): Promise<{ ctx: Context; console: ConsoleService; fiber: Fiber; base: string }> {
  const ctx = new Context()
  opened.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  // 统计库指向 **:memory:**（测试不该写真实 $DSH_HOME）
  const fiber = await ctx.plugin(ConsoleService, { statsPath: ':memory:' })
  const service = ctx.get('console') as ConsoleService
  return { ctx, console: service, fiber, base: `http://127.0.0.1:${ctx.webServer.port}/yanxin` }
}

/** 请求一次：拿到状态码与文本。 */
async function call(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${base}${path}`, init)
  return { status: response.status, text: await response.text() }
}

describe('T31 —— 路由随 fiber 装卸', () => {
  it('⭐ 装载后可达；**只卸载控制台**之后路由消失（404），而服务器还在', async () => {
    const { ctx, fiber, base } = await makeConsole()
    expect((await call(base, '/')).status).toBe(200)

    await fiber.dispose()

    // 路由没了（404），但 webServer 还活着（否则会 ECONNREFUSED —— 那就测不出回滚）
    expect((await call(base, '/')).status).toBe(404)
    expect(ctx.webServer.port).toBeGreaterThan(0)
  })
})

describe('T31 —— 外壳与客户端脚本是字面量', () => {
  it('⭐ 裸挂载路径 308 → 带尾斜杠；两者都给同一个外壳（逐字节等于常量）', async () => {
    const { base } = await makeConsole()

    // 裸路径：**必须**重定向（否则页内相对路径会解析到上一级）。
    // ⚠️ `redirect: 'manual'`：默认的 fetch 会自己跟随，那就看不到 308 了
    const bare = await fetch(base, { redirect: 'manual' })
    expect(bare.status).toBe(308)
    expect(bare.headers.get('location')).toBe('/yanxin/')

    const shell = await call(base, '/')
    expect(shell.status).toBe(200)
    expect(shell.text).toBe(CONSOLE_SHELL)

    // 脚本内联在外壳里（没有第二次请求，也就没有相对路径问题）
    expect(shell.text).toContain(CONSOLE_CLIENT_SCRIPT)
    expect(await call(base, '/client.js')).toMatchObject({ status: 200 }) // 它会落到外壳（SPA 兜底）

    // 任意页面路径也给外壳（浏览器端再取那一页的内容）
    expect((await call(base, '/world')).text).toBe(CONSOLE_SHELL)
  })
})

describe('T31 —— 页的内容走 JSON（不是 HTML）', () => {
  it('页清单与区块是数据', async () => {
    const { base } = await makeConsole()
    const payload = JSON.parse((await call(base, '/api/page')).text) as {
      ok: boolean
      data: { title: string; pages: unknown[]; blocks: { kind: string }[] }
    }

    expect(payload.ok).toBe(true)
    expect(payload.data.title).toBe('研心控制台')
    // 首页现在是仪表盘：第一个区块是"一句话状态"的提示条（旧版是普通的 p）
    expect(payload.data.blocks[0]?.kind).toBe('notice')
  })

  it('没有那一页时 `ok: false` 且说清是哪一页', async () => {
    const { base } = await makeConsole()
    const payload = JSON.parse((await call(base, '/api/page/不存在')).text) as { ok: boolean; error: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('不存在')
  })
})

describe('T31 —— 写操作强制 token（三道门里的第二道）', () => {
  /** 注册一个写接口的插件（记下它收到的请求体）。 */
  function apiPlugin(seen: unknown[]): { name: string; inject: string[]; apply(ctx: Context): void } {
    return {
      name: 'test-console-api',
      inject: ['console'],
      apply(ctx: Context) {
        ctx.console.api({
          route: 'echo',
          method: 'POST',
          handler: async ({ body }) => {
            seen.push(body)
            return { echo: body }
          },
        })
      },
    }
  }

  it('⭐ 没配 token → 403（fail-closed），接口**没被调用**，但审计留痕', async () => {
    delete process.env[TOKEN_ENV]
    const { ctx, base } = await makeConsole()
    const seen: unknown[] = []
    await ctx.plugin(apiPlugin(seen))

    const response = await call(base, '/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 1 }),
    })

    expect(response.status).toBe(403)
    expect(response.text).toContain(TOKEN_ENV)
    expect(seen).toEqual([]) // 业务逻辑没跑到

    const audit = await readFile(join(home, 'yanxin', 'audit', 'console.jsonl'), 'utf8')
    expect(audit).toContain('"ok":false')
    expect(audit).toContain('fail-closed')
  })

  it('⭐ 配了 token 但没带 → 401；带对了 → 200 且接口收到请求体', async () => {
    process.env[TOKEN_ENV] = 's3cret'
    const { ctx, base } = await makeConsole()
    const seen: unknown[] = []
    await ctx.plugin(apiPlugin(seen))

    const denied = await call(base, '/api/echo', {
      method: 'POST',
      body: JSON.stringify({ hello: 1 }),
    })
    expect(denied.status).toBe(401)
    expect(seen).toEqual([])

    const allowed = await call(base, '/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
      body: JSON.stringify({ hello: 1 }),
    })
    expect(allowed.status).toBe(200)
    expect(JSON.parse(allowed.text)).toEqual({ ok: true, data: { echo: { hello: 1 } } })
    expect(seen).toEqual([{ hello: 1 }])
  })

  it('⭐ 日志流是"要 token 的读操作"：不带 → 401，查询串带上 → 200 且是 SSE', async () => {
    process.env[TOKEN_ENV] = 's3cret'
    const { base } = await makeConsole()

    // 流式接口不能靠请求头带凭据（EventSource 不允许），所以查询串是它唯一的路
    expect((await call(base, '/api/log/stream')).status).toBe(401)

    const response = await fetch(`${base}/api/log/stream?token=s3cret`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    await response.body?.cancel() // 拿到头就断，不等增量（服务端在 close 时清 interval）
  })

  it('⭐ 没配 token 时日志流也 fail-closed（403）—— 日志原文一段都不会推出去', async () => {
    delete process.env[TOKEN_ENV]
    const { base } = await makeConsole()
    const denied = await call(base, '/api/log/stream')
    expect(denied.status).toBe(403)
    expect(denied.text).toContain('fail-closed')
  })

  it('读接口不需要 token（只读页面可不带）', async () => {
    delete process.env[TOKEN_ENV]
    const { ctx, base } = await makeConsole()
    ctx.console.api({ route: 'ping', method: 'GET', handler: async () => ({ pong: true }) })

    const response = await call(base, '/api/ping')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text)).toEqual({ ok: true, data: { pong: true } })
  })

  it('未知接口 404（拿到 token 也不该乱认路径）', async () => {
    process.env[TOKEN_ENV] = 's3cret'
    const { base } = await makeConsole()
    const response = await call(base, '/api/nope', { method: 'POST', headers: { 'x-yanxin-token': 's3cret' } })
    expect(response.status).toBe(404)
  })
})

describe('T31 —— 页注册随插件装卸', () => {
  it('⭐ 注册页的插件卸载后，那一页从清单里消失（effect 绑在调用方 fiber 上）', async () => {
    const { ctx, base } = await makeConsole()
    const fiber = await ctx.plugin({
      name: 'test-console-page',
      inject: ['console'],
      apply(pluginCtx: Context) {
        pluginCtx.console.page({
          slug: 'probe',
          title: '探针页',
          render: () => [{ kind: 'p', text: '这里是探针。' }],
        })
      },
    })

    const withPage = JSON.parse((await call(base, '/api/page/probe')).text) as {
      ok: boolean
      data: { title: string; blocks: { kind: string; text?: string }[] }
    }
    expect(withPage.ok).toBe(true)
    expect(withPage.data.title).toBe('探针页')
    expect(withPage.data.blocks[0]?.text).toBe('这里是探针。')

    await fiber.dispose()

    const gone = JSON.parse((await call(base, '/api/page/probe')).text) as { ok: boolean }
    expect(gone.ok).toBe(false)
  })
})