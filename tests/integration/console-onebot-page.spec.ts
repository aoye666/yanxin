/**
 * OneBot 连接页的**接线与安全门**验收（真 console + 真 onebot 服务）。
 *
 * 这一组断言的存在理由，是三类"单测全绿但东西仍然坏掉"的形态：
 *
 *   1. **门在服务端**。非回环 + 空 token 必须被**接口**拒掉 —— 只在浏览器表单上做
 *      校验等于没有校验（curl 一条就绕过）。
 *   2. **token 的值哪儿都不出现**：页面是免凭据可读的（§6.12），审计日志落在磁盘上，
 *      接口回执打在响应里 —— 三处都必须只有"已设置 / 未设置"，不能有值。
 *   3. **一张表单只管自己的字段**：改鉴权那张表不许顺手把监听地址换掉，
 *      因为换地址是要勾确认的那一类。
 *
 * 换绑的真行为（旧连接不断、端口被占时退回原样）在 `onebot-transport.spec.ts`，
 * 这里只管控制台这一层。
 */
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditFile } from '../../src/audit/log.ts'
import ConsoleService from '../../src/console/index.ts'
import { TOKEN_ENV } from '../../src/console/logic.ts'
import OneBotService from '../../src/onebot/service.ts'
import MemorySettings from '../support/memory-settings.ts'

const BOT = '3000000001'
const BASELINE_TOKEN = 'baseline-token-value'
const NEW_TOKEN = 'rotated-token-value'

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

/** 装一套真的控制台 + 真的 OneBot 服务（行 config 给 token 与路径，settings 空）。 */
async function makeStack(rowToken = BASELINE_TOKEN) {
  const ctx = new Context()
  opened.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(MemorySettings)
  await ctx.plugin(OneBotService, {
    host: '127.0.0.1',
    port: 0,
    path: '/onebot/v11',
    token: rowToken,
    accounts: [{ selfId: BOT, preset: 'xiaoyan-agent' }],
    pingIntervalMs: 60_000,
    callTimeoutMs: 2_000,
  })
  await ctx.onebot.ready
  await ctx.plugin(ConsoleService, { statsPath: ':memory:' })
  await ctx.plugin(await import('../../src/console/pages/onebot.ts'))
  return { ctx, base: `http://127.0.0.1:${ctx.webServer.port}/yanxin` }
}

/**
 * POST 一个写接口。
 *
 * ⚠️ 信封形状：控制台的"请求成功"与"那一步失败"是两件事 ——
 * 业务拒绝返回的是 `{ ok: true, data: { error } }`（HTTP 200，因为请求本身没问题）。
 * 所以这里把两种"错"合并成一个 `error` 字符串返回：空串 = 成功。
 */
async function post(base: string, route: string, body: Record<string, unknown>): Promise<{ error: string; detail: string }> {
  const response = await fetch(`${base}/api/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as {
    ok: boolean
    error?: string
    data?: { error?: string; detail?: string }
  }
  return { error: payload.data?.error ?? payload.error ?? '', detail: payload.data?.detail ?? '' }
}

/** 把一页的区块拍成一个大字符串 —— 断言"某个值不出现"最省事的做法。 */
async function pageText(base: string, slug: string): Promise<string> {
  const payload = (await (await fetch(`${base}/api/page/${slug}`)).json()) as { data: { blocks: unknown[] } }
  return JSON.stringify(payload.data.blocks)
}

describe('OneBot 连接页', () => {
  it('九个页面之一，标题与区块都在（导航能点进去）', async () => {
    const { base } = await makeStack()
    const payload = (await (await fetch(`${base}/api/page`)).json()) as {
      data: { pages: { slug: string; title: string }[] }
    }
    expect(payload.data.pages.map((p) => p.slug)).toContain('onebot')

    const text = await pageText(base, 'onebot')
    expect(text).toContain('现在生效的监听')
    expect(text).toContain('/onebot/v11')
  })

  it('⭐ token 的值不回显，只显示"已设置"（这一页免凭据可读）', async () => {
    const { base } = await makeStack()
    const text = await pageText(base, 'onebot')
    expect(text).not.toContain(BASELINE_TOKEN)
    expect(text).toContain('已设置（值不回显）')
  })

  it('监听在回环时不给警告；一旦是非回环就明确警告', async () => {
    const { base, ctx } = await makeStack()
    expect(await pageText(base, 'onebot')).not.toContain('所有网卡')

    // 直接改 settings（绕过页面的门）—— 页面必须如实把风险显示出来
    await ctx.settings.update('yanxin-onebot', { host: '0.0.0.0', token: BASELINE_TOKEN })
    expect(await pageText(base, 'onebot')).toContain('所有网卡')
  })

  it('⭐ 非回环 + 没勾确认 → 接口拒（门不在浏览器里）', async () => {
    const { base, ctx } = await makeStack()
    const result = await post(base, 'onebot/listen', { host: '0.0.0.0', port: '0' })
    expect(result.error).toContain('确认')
    expect(ctx.onebot.transport.host).toBe('127.0.0.1') // 真的没写进去
  })

  it('⭐ 非回环 + 勾了确认但没 token → 照样拒', async () => {
    const { base } = await makeStack('') // 行 config 没给 token
    const result = await post(base, 'onebot/listen', { host: '0.0.0.0', confirm_public: 'true' })
    expect(result.error).toMatch(/token|冒充/)
  })

  it('非回环 + 确认 + 有 token → 放行（门不是死路）', async () => {
    const { base, ctx } = await makeStack()
    const result = await post(base, 'onebot/listen', { host: '0.0.0.0', confirm_public: 'true' })
    expect(result.error).toBe('')
    expect(ctx.onebot.transport.host).toBe('0.0.0.0')
    expect(ctx.onebot.listenPoint.host).toBe('0.0.0.0')
  })

  it('回环不需要确认，改端口直接生效', async () => {
    const { base, ctx } = await makeStack()
    const before = ctx.onebot.port
    const result = await post(base, 'onebot/listen', { host: '127.0.0.1', port: '0' })
    expect(result.error).toBe('')
    expect(ctx.onebot.port).toBe(before) // 请求值还是 0 → 不该白白换绑
  })

  it('⭐ 改鉴权那张表不许顺手换监听（换地址是要确认的那一类）', async () => {
    const { base, ctx } = await makeStack()
    const result = await post(base, 'onebot/credentials', { token: NEW_TOKEN, host: '0.0.0.0' })
    expect(result.error).toContain('不接受')
    expect(ctx.onebot.transport.host).toBe('127.0.0.1')
    expect(ctx.onebot.transport.token).toBe(BASELINE_TOKEN) // 整笔提交都被拒，不是"改了一半"
  })

  it('换 token 立刻生效，且**值不出现在回执、页面与审计日志里**', async () => {
    const { base, ctx } = await makeStack()

    const result = await post(base, 'onebot/credentials', { token: NEW_TOKEN })
    expect(result.error).toBe('')
    expect(ctx.onebot.transport.token).toBe(NEW_TOKEN)

    const echoed = result.detail + (await pageText(base, 'onebot'))
    expect(echoed).not.toContain(NEW_TOKEN)

    const audit = readFileSync(auditFile('console'), 'utf8')
    expect(audit).toContain('/api/onebot/credentials') // 写操作留了痕
    expect(audit).not.toContain(NEW_TOKEN) // 但痕里没有值
  })

  it('空表单 = 什么都没改（不写一次 settings 也不报意外）', async () => {
    const { base } = await makeStack()
    const result = await post(base, 'onebot/credentials', {})
    expect(result.error).toContain('什么都没改')
  })

  it('OneBot 服务不在时页面仍能渲染，且不给写入口（改了没人读）', async () => {
    const ctx = new Context()
    opened.push(ctx)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(MemorySettings)
    await ctx.plugin(ConsoleService, { statsPath: ':memory:' })
    await ctx.plugin(await import('../../src/console/pages/onebot.ts'))
    const base = `http://127.0.0.1:${ctx.webServer.port}/yanxin`

    expect(await pageText(base, 'onebot')).toContain('OneBot')
    const result = await post(base, 'onebot/listen', { host: '127.0.0.1', port: '8080' })
    expect(result.error).toContain('服务不在')
  })
})
