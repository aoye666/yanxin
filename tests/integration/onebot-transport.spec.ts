/**
 * OneBot 传输参数的**运行期可改**验收 —— 控制台那一页背后的真行为。
 *
 * 这一组测试要证的是三件"纸面 review 看不出来"的事：
 *
 *   1. **改了立刻生效**：换 token 之后，旧 token 的连接被 401、新 token 能连 ——
 *      做不到的话"token 泄漏了去控制台改"就是假的（要重启 = 泄漏窗口一直开着）。
 *   2. **换绑不断旧连接**：改端口时已经连上的 NapCat 不该被她踢下线 ——
 *      运维改端口的那一刻，正是最不能失联的时刻。
 *   3. ⚠️ **换绑失败必须退回原样**：端口被占 / 地址写错时，我们要**先在新地址听成功**
 *      再关旧的；反过来做会落得"旧的关了、新的起不来" —— 她把连接丢了却再也连不回来，
 *      而唯一能救她的控制台页面此刻也看不见发生了什么。
 *
 * 校验门（非回环要 token + 确认）在 `tests/unit/onebot-transport.spec.ts`，
 * 这里只测服务侧：因为服务**也**能被绕过页面直接改（手改 `settings.yaml`），
 * 那條路必须同样不炸。
 */
import { createServer } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import OneBotService from '../../src/onebot/service.ts'
import MemorySettings from '../support/memory-settings.ts'
import { FakeOneBot } from '../support/fake-onebot.ts'

const BOT = '3000000001'
/** 第二个号：换端口后要验"新端口接得住新连接"，但同一 (selfId, role) 再连会把旧连接顶掉，
 *  所以那条新连接必须换一个 selfId。 */
const OTHER_BOT = '3999999999'
const TOKEN = 'example-onebot-token-1234'
const PATH = '/onebot/v11'

const opened: Context[] = []
const peers: FakeOneBot[] = []
const Occupied: { close(): void }[] = []

async function makeCtx(token = TOKEN) {
  const ctx = new Context()
  opened.push(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(OneBotService, {
    host: '127.0.0.1',
    port: 0, // 系统分配：换绑测试要拿真实端口比
    path: PATH,
    token,
    accounts: [
      { selfId: BOT, preset: 'xiaoyan-agent' },
      { selfId: OTHER_BOT, preset: 'xiaoyan-agent' },
    ],
    pingIntervalMs: 60_000,
    callTimeoutMs: 2_000,
  })
  await ctx.onebot.ready
  return ctx
}

/** 基础 URL（路径由 `connect` 单独传 —— FakeOneBot 自己拼，与 onebot-service.spec 同一口径）。 */
function urlOf(ctx: Context, port = ctx.onebot.port): string {
  return `ws://127.0.0.1:${port}/`
}

async function connect(ctx: Context, token: string | undefined, options: { path?: string; port?: number } = {}) {
  const result = await FakeOneBot.connect({
    url: urlOf(ctx, options.port),
    path: options.path ?? PATH,
    selfId: BOT,
    role: 'Universal',
    token,
  })
  if (result.ok) peers.push(result.peer)
  return result
}

/** 找一个当前没人用的端口号（立刻放回去 —— 只用来当"换过去"的目标）。 */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** 占住一个端口，让"换绑到那里"必然失败。 */
async function occupy(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  Occupied.push(server)
  return typeof addr === 'object' && addr !== null ? addr.port : 0
}

afterEach(async () => {
  while (peers.length) peers.pop()?.terminate()
  for (const server of Occupied.splice(0)) server.close()
  while (opened.length) await opened.pop()?.fiber.dispose()
})

describe('OneBot 传输参数可以运行期改', () => {
  it('⭐ 改 token：旧的立刻被 401 拒，新的立刻能连（不用重启）', async () => {
    const ctx = await makeCtx()
    expect((await connect(ctx, TOKEN)).ok).toBe(true)

    await ctx.onebot.updateTransport({ token: 'rotated-token-value' })

    const stale = await connect(ctx, TOKEN)
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.status).toBe(401)

    expect((await connect(ctx, 'rotated-token-value')).ok).toBe(true)
  })

  it('改 path：旧路径的升级请求被 404，新路径通', async () => {
    const ctx = await makeCtx()
    await ctx.onebot.updateTransport({ path: '/onebot/new' })

    const wrong = await FakeOneBot.connect({ url: urlOf(ctx), path: '/onebot/v11', selfId: BOT, role: 'Universal', token: TOKEN })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.status).toBe(404)

    const right = await FakeOneBot.connect({ url: urlOf(ctx), path: '/onebot/new', selfId: BOT, role: 'Universal', token: TOKEN })
    expect(right.ok).toBe(true)
    if (right.ok) peers.push(right.peer)
  })

  it('⭐ 换端口：新端口能连，**已经连上的那条不断且仍可调用**', async () => {
    const ctx = await makeCtx()
    const live = await connect(ctx, TOKEN)
    expect(live.ok).toBe(true)
    if (!live.ok) return

    const target = await freePort()
    await ctx.onebot.updateTransport({ port: target })
    expect(ctx.onebot.port).toBe(target)

    // 先验**旧连接还活着**（从它身上走一次 API 调用）—— 必须在新连接建立之前做：
    // 同一 (selfId, role) 再连会把旧的替换掉（那是 designed 行为，见 onConnection），
    // 顺序反了就等于在测"新连接能不能用"，而那条根本不是这里的关注点。
    expect(ctx.onebot.canCall(BOT)).toBe(true)
    const asked = live.peer.waitForCall('get_login_info')
    void ctx.onebot.call(BOT, 'get_login_info')
    expect((await asked).action).toBe('get_login_info')

    // 新端口也接得住新连接（换个 selfId 免得把上面那条旧连接顶掉）
    const fresh = await FakeOneBot.connect({
      url: urlOf(ctx, target),
      path: PATH,
      selfId: OTHER_BOT,
      role: 'Universal',
      token: TOKEN,
    })
    expect(fresh.ok).toBe(true)
    if (fresh.ok) peers.push(fresh.peer)
  })

  it('⭐ 换绑失败（端口被占）→ **保持原监听在听**，不是两手空空', async () => {
    const ctx = await makeCtx()
    const before = ctx.onebot.port
    const taken = await occupy()

    await ctx.onebot.updateTransport({ port: taken })

    expect(ctx.onebot.port).toBe(before)
    // 原来的监听还接得住连接 —— 这条断言才是"不停摆"的证据
    expect((await connect(ctx, TOKEN)).ok).toBe(true)
  })

  it('地址写错（不是合法 IP）→ 同样保持原监听，服务不炸', async () => {
    const ctx = await makeCtx()
    const before = ctx.onebot.port

    // 绕过控制台的校验直接改 settings：这条路径必须也只是"改不动"，而不是把进程搞崩
    await ctx.settings.update('yanxin-onebot', { host: 'not.an.ip.address' })
    await new Promise((r) => setTimeout(r, 50))

    expect(ctx.onebot.port).toBe(before)
    expect((await connect(ctx, TOKEN)).ok).toBe(true)
  })

  it('⭐ 请求值没变就不换绑（端口不会"我明明没改却在变"）', async () => {
    const ctx = await makeCtx()
    const allocated = ctx.onebot.port // 行 config 写 port: 0 → 系统分配了一个真实端口

    // 把"请求值"原样再写一遍：0 还是 0 —— 不该因此重新绑定一次。
    // 这条是回归防护：如果拿**实际端口**去比，每次保存都会换绑，
    // 而每次换绑系统又分配一个新端口，页面上就成了端口一直在变。
    await ctx.onebot.updateTransport({ host: '127.0.0.1', port: 0 })
    expect(ctx.onebot.port).toBe(allocated)

    // 反证：写一个**具体**端口号才是真的换绑（说明上面那条不是"永远不换"）
    const target = await freePort()
    await ctx.onebot.updateTransport({ port: target })
    expect(ctx.onebot.port).toBe(target)
    expect(target).not.toBe(allocated)
  })

  it('settings 没写任何东西时，行 config 就是生效值（三级回退不倒过来）', async () => {
    const ctx = await makeCtx('baseline-from-patch')
    expect(ctx.onebot.transport.token).toBe('baseline-from-patch')
    expect(ctx.onebot.transport.host).toBe('127.0.0.1')

    await ctx.onebot.updateTransport({ token: 'now-from-settings' })
    expect(ctx.onebot.transport.token).toBe('now-from-settings')
  })
})
