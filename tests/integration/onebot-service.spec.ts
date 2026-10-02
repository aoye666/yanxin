/**
 * OneBot 反向 WS 服务的集成验收（T8 + T9）。
 *
 * 用 `tests/support/fake-onebot.ts` 扮演 NapCat，在没有 QQ、没有 NapCat 的情况下
 * 覆盖整条传输链路：握手 / 鉴权 / 账号路由 / 事件分类 / **串号检测** / API 调用与 echo 关联 /
 * 重连替换 / 卸载清理。
 *
 * 端口用 0（系统分配）+ `await ctx.onebot.ready` 读回真实端口，避免测试间抢占固定端口。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import OneBotService from '../../src/onebot/service.ts'
import type { ClientRole } from '../../src/onebot/protocol.ts'
import MemorySettings from '../support/memory-settings.ts'
import { FakeOneBot, groupMessageEvent } from '../support/fake-onebot.ts'

const BOT = '2000000002'
const OTHER_BOT = '3999999999'
const TOKEN = 'example-onebot-token-1234'
const PATH = '/onebot/v11'

const opened: Context[] = []
const peers: FakeOneBot[] = []

async function makeCtx(
  options: { token?: string; path?: string; accounts?: Array<{ selfId: string; preset: string }> } = {},
) {
  const ctx = new Context()
  opened.push(ctx)
  // 服务现在 inject settings（传输参数可被 `yanxin-onebot` 运行期覆盖，见 src/onebot/transport.ts）
  // —— 没有 provider 的话 fiber 会永远等一个不存在的依赖，`ctx.onebot` 直接是 undefined。
  await ctx.plugin(MemorySettings)
  await ctx.plugin(OneBotService, {
    host: '127.0.0.1',
    port: 0,
    path: options.path,
    token: options.token,
    accounts: options.accounts ?? [{ selfId: BOT, preset: 'xiaoyan-agent' }],
    pingIntervalMs: 60_000, // 测试里不要被 ping 干扰；ping 行为另有专测
    callTimeoutMs: 2_000,
  })
  await ctx.onebot.ready
  return ctx
}

function urlOf(ctx: Context): string {
  return `ws://127.0.0.1:${ctx.onebot.port}/`
}

async function connect(
  ctx: Context,
  options: {
    selfId?: string
    role?: ClientRole
    token?: string
    path?: string
    tokenInQuery?: boolean
    overrides?: Record<string, string | undefined>
  } = {},
): Promise<{ ok: true; peer: FakeOneBot } | { ok: false; status: number; body: string }> {
  const result = await FakeOneBot.connect({
    url: urlOf(ctx),
    path: options.path,
    selfId: options.selfId ?? BOT,
    role: options.role ?? 'Universal',
    token: options.token,
    tokenInQuery: options.tokenInQuery,
    overrides: options.overrides,
  })
  if (result.ok) peers.push(result.peer)
  return result
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

afterEach(async () => {
  while (peers.length) peers.pop()?.terminate()
  while (opened.length) await opened.pop()?.fiber.dispose()
})

// ── 握手与鉴权 ────────────────────────────────────────────────────────

describe('T8 —— 握手与鉴权', () => {
  it('合法 Universal 连接成功，并发出 onebot/connected', async () => {
    const ctx = await makeCtx()
    const seen: Array<[string, ClientRole]> = []
    ctx.on('onebot/connected', (selfId, role) => seen.push([selfId, role]))

    const r = await connect(ctx)
    expect(r.ok).toBe(true)
    await sleep(50)

    expect(seen).toEqual([[BOT, 'Universal']])
    expect(ctx.onebot.connectionsOf(BOT)).toEqual(['Universal'])
  })

  it('未注册的 selfId 被拒绝（403）', async () => {
    const ctx = await makeCtx()
    const r = await connect(ctx, { selfId: OTHER_BOT })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(403)
      expect(r.body).toContain('未注册')
    }
    expect(ctx.onebot.connectionsOf(OTHER_BOT)).toEqual([])
  })

  it('token 不匹配被拒绝（401）', async () => {
    const ctx = await makeCtx({ token: TOKEN })
    const r = await connect(ctx, { token: 'wrong-token' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('配了 token 时，正确的 token 可以通过', async () => {
    const ctx = await makeCtx({ token: TOKEN })
    const r = await connect(ctx, { token: TOKEN })
    expect(r.ok).toBe(true)
  })

  it('缺 X-Self-ID 被拒绝（400）', async () => {
    const ctx = await makeCtx()
    const r = await connect(ctx, { overrides: { 'X-Self-ID': undefined } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(400)
      expect(r.body).toContain('X-Self-ID')
    }
  })

  it('X-Client-Role 非法被拒绝（400）', async () => {
    const ctx = await makeCtx()
    const r = await connect(ctx, { overrides: { 'X-Client-Role': 'Bot' } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(400)
      expect(r.body).toContain('X-Client-Role')
    }
  })
})

// ── 账号路由与多连接 ──────────────────────────────────────────────────

describe('T8 —— 路径校验与 token 承载方式', () => {
  it('配了 path 时，路径不符被拒绝（404）', async () => {
    const ctx = await makeCtx({ path: PATH })
    const ok = await connect(ctx, { path: PATH })
    expect(ok.ok).toBe(true)

    const bad = await connect(ctx, { path: '/wrong/path' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.status).toBe(404)
      expect(bad.body).toContain('路径不符')
    }
  })

  it('配了 path 时，带 query 的正确路径仍然通过（pathname 比较不含 query）', async () => {
    const ctx = await makeCtx({ path: PATH, token: TOKEN })
    const r = await connect(ctx, { path: PATH, token: TOKEN, tokenInQuery: true })
    expect(r.ok).toBe(true)
  })

  it('未配 path 时接受任意路径（默认宽松）', async () => {
    const ctx = await makeCtx()
    const r = await connect(ctx, { path: '/anything/at/all' })
    expect(r.ok).toBe(true)
  })

  it('token 放 query 里也能通过鉴权（SnowLuma 界面提供 Header / URL Query 两条路）', async () => {
    const ctx = await makeCtx({ token: TOKEN })
    const r = await connect(ctx, { token: TOKEN, tokenInQuery: true })
    expect(r.ok).toBe(true)
  })
})

describe('T8 —— 一个账号可以有多条连接（规范：API 与 Event 可以是两条）', () => {
  it('API + Event 两条连接共存', async () => {
    const ctx = await makeCtx()
    const api = await connect(ctx, { role: 'API' })
    const ev = await connect(ctx, { role: 'Event' })
    expect(api.ok && ev.ok).toBe(true)
    expect(ctx.onebot.connectionsOf(BOT)).toEqual(['API', 'Event'])
  })

  it('只有 Event 连接时不具备调用能力', async () => {
    const ctx = await makeCtx()
    await connect(ctx, { role: 'Event' })
    expect(ctx.onebot.canCall(BOT)).toBe(false)
  })

  it('Universal 连接同时具备调用能力', async () => {
    const ctx = await makeCtx()
    await connect(ctx, { role: 'Universal' })
    expect(ctx.onebot.canCall(BOT)).toBe(true)
  })

  it('account() 能按字符串或数字 selfId 查到账号配置', async () => {
    const ctx = await makeCtx()
    expect(ctx.onebot.account(BOT)?.preset).toBe('xiaoyan-agent')
    expect(ctx.onebot.account(Number(BOT))?.preset).toBe('xiaoyan-agent')
    expect(ctx.onebot.account('nobody')).toBeUndefined()
  })
})

// ── 事件与串号检测 ────────────────────────────────────────────────────

describe('T8/T9 —— 事件分发', () => {
  it('合法群消息事件被分发', async () => {
    const ctx = await makeCtx()
    const peer = await connect(ctx)
    if (!peer.ok) throw new Error('连接失败')

    const seen: unknown[] = []
    ctx.on('onebot/event', (frame) => seen.push(frame))

    peer.peer.push(groupMessageEvent(BOT, { message: '小研在吗' }))
    await sleep(60)

    expect(seen).toHaveLength(1)
    expect((seen[0] as { postType: string }).postType).toBe('message')
    expect((seen[0] as { selfId: string }).selfId).toBe(BOT)
  })

  it('⚠️ 串号事件被丢弃：事件自带 self_id 与握手头不一致（T9 核心断言）', async () => {
    const ctx = await makeCtx()
    const peer = await connect(ctx)
    if (!peer.ok) throw new Error('连接失败')

    const seen: unknown[] = []
    ctx.on('onebot/event', (frame) => seen.push(frame))

    // 连接声明是 BOT，但事件自称是另一个号 —— 冒充或实现有 bug，绝不能放行
    peer.peer.push(groupMessageEvent(OTHER_BOT, { message: '我是别人' }))
    await sleep(60)

    expect(seen).toEqual([])
  })

  it('非 JSON 帧不会导致崩溃，后续事件照常', async () => {
    const ctx = await makeCtx()
    const peer = await connect(ctx)
    if (!peer.ok) throw new Error('连接失败')

    const seen: unknown[] = []
    ctx.on('onebot/event', (frame) => seen.push(frame))

    peer.peer.pushRaw('这不是 JSON{')
    peer.peer.push(groupMessageEvent(BOT, { message: '还在' }))
    await sleep(60)

    expect(seen).toHaveLength(1)
  })

  it('无法分类的 JSON 帧被忽略', async () => {
    const ctx = await makeCtx()
    const peer = await connect(ctx)
    if (!peer.ok) throw new Error('连接失败')

    const seen: unknown[] = []
    ctx.on('onebot/event', (frame) => seen.push(frame))

    peer.peer.push({ hello: 'world' })
    await sleep(40)

    expect(seen).toEqual([])
  })
})

// ── API 调用 ──────────────────────────────────────────────────────────

describe('T8 —— API 调用与 echo 关联', () => {
  it('call() 发出 action/params/echo 并拿到 data', async () => {
    const ctx = await makeCtx()
    const peer = await connect(ctx)
    if (!peer.ok) throw new Error('连接失败')

    peer.peer.responder = (_call) => ({ status: 'ok', retcode: 0, data: { message_id: 777 } })

    const data = await ctx.onebot.call<{ message_id: number }>(BOT, 'send_group_msg', {
      group_id: 123456,
      message: '收到',
    })

    expect(data).toEqual({ message_id: 777 })
    const call = await peer.peer.waitForCall('send_group_msg')
    expect(call.params).toEqual({ group_id: 123456, message: '收到' })
    expect(call.echo).toMatch(/^yx-\d+$/)
  })

  it('并发调用按 echo 分别关联，不串台', async () => {
    const ctx = await makeCtx()
    const peer = await connect(ctx)
    if (!peer.ok) throw new Error('连接失败')

    peer.peer.responder = (call) => ({
      status: 'ok',
      retcode: 0,
      data: { message_id: Number(String(call.params.message).replace(/\D/g, '')) },
    })

    const [a, b] = await Promise.all([
      ctx.onebot.call<{ message_id: number }>(BOT, 'send_group_msg', { group_id: 1, message: 'm1' }),
      ctx.onebot.call<{ message_id: number }>(BOT, 'send_group_msg', { group_id: 2, message: 'm2' }),
    ])

    expect(a.message_id).toBe(1)
    expect(b.message_id).toBe(2)
  })

  it('没有 API 连接时抛 no-connection', async () => {
    const ctx = await makeCtx()
    await connect(ctx, { role: 'Event' })
    await expect(ctx.onebot.call(BOT, 'send_group_msg', {})).rejects.toMatchObject({
      name: 'OneBotCallError',
      kind: 'no-connection',
    })
  })

  it('对端不响应时抛 timeout', async () => {
    const ctx = await makeCtx()
    const peer = await connect(ctx)
    if (!peer.ok) throw new Error('连接失败')

    peer.peer.responder = () => undefined // 故意不回

    await expect(ctx.onebot.call(BOT, 'send_group_msg', {}, { timeoutMs: 300 })).rejects.toMatchObject({
      kind: 'timeout',
    })
  })

  it('响应 status=failed 时抛 api-failed 并带 retcode', async () => {
    const ctx = await makeCtx()
    const peer = await connect(ctx)
    if (!peer.ok) throw new Error('连接失败')

    peer.peer.responder = () => ({ status: 'failed', retcode: 1404, data: null })

    await expect(ctx.onebot.call(BOT, 'send_group_msg', {})).rejects.toMatchObject({
      kind: 'api-failed',
      retcode: 1404,
    })
  })
})

// ── 重连与生命周期 ────────────────────────────────────────────────────

describe('T9 —— 重连替换', () => {
  it('同 (selfId, role) 再连时替换旧连接，不叠加', async () => {
    const ctx = await makeCtx()
    const first = await connect(ctx)
    if (!first.ok) throw new Error('连接失败')
    expect(ctx.onebot.connectionsOf(BOT)).toEqual(['Universal'])

    const second = await connect(ctx)
    if (!second.ok) throw new Error('第二次连接失败')

    await sleep(80)
    expect(ctx.onebot.connectionsOf(BOT)).toEqual(['Universal'])
    await first.peer.waitClosed() // 旧连接被服务端关闭
  })

  it('旧连接断开后，调用走新连接', async () => {
    const ctx = await makeCtx()
    const first = await connect(ctx)
    if (!first.ok) throw new Error('连接失败')
    const second = await connect(ctx)
    if (!second.ok) throw new Error('第二次连接失败')

    await sleep(80)
    second.peer.responder = () => ({ status: 'ok', retcode: 0, data: { message_id: 555 } })

    const data = await ctx.onebot.call<{ message_id: number }>(BOT, 'send_group_msg', { group_id: 1, message: 'x' })
    expect(data.message_id).toBe(555)
    expect(second.peer.calls).toHaveLength(1)
  })
})

describe('T8 —— 卸载时正确回滚', () => {
  it('插件卸载后端口释放（能重新绑定同一端口）', async () => {
    const ctx = await makeCtx()
    const port = ctx.onebot.port

    // dispose 整个 root —— 监听由 ctx.effect 注册，卸载时应当被回滚
    await ctx.fiber.dispose()
    await sleep(150)

    // 能重新绑同一端口即证明监听确实释放了（若没释放会 EADDRINUSE）
    const { createServer } = await import('node:http')
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', () => resolve())
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  })

  it('卸载时有未决调用，会被 reject 而不是悬挂', async () => {
    const ctx = await makeCtx()
    const peer = await connect(ctx)
    if (!peer.ok) throw new Error('连接失败')

    peer.peer.responder = () => undefined
    const task = ctx.onebot.call(BOT, 'send_group_msg', {}, { timeoutMs: 10_000 })

    await sleep(60)
    await ctx.fiber.dispose()

    await expect(task).rejects.toMatchObject({ name: 'OneBotCallError', kind: 'closed' })
  })
})
