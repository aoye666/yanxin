/**
 * ReMe client 的协议与降级（spec §8 的 T14）。
 *
 * 用**假的 ReMe HTTP server**（`tests/support/fake-reme.ts`，端口 0）跑，因为：
 *   · 真实 ReMe 不在 CI/本机常驻，而协议契约必须可回归；
 *   · 我们要断言的是**发出去的请求形状**与**各种响应形状的解析**，这两件事
 *     只有把 server 握在自己手里才看得见。
 *
 * 覆盖面：
 *   · 四个 job（`search` / `auto_memory` / `auto_dream` / `health`）的请求形状
 *   · 响应解析：字符串 answer / 数组 answer / `success: false` / 形状不认识 / HTTP 非 2xx
 *   · **端到端降级**：provider 抛错 → `MemoryService.search` 返回 `[]`（不阻塞对话）
 *   · 超时按降级处理
 *
 * ⚠️ 全部只连 `127.0.0.1` 的临时端口 —— 与 `assertLoopbackEndpoint` 的纪律一致，
 * 也绝不碰真实 ReMe（默认 2333）。
 */
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { RemeProvider, remeSessionId } from '../../src/memory/reme.ts'
import MemoryService from '../../src/memory/service.ts'
import { okReply, startBlackHole, startFakeReme } from '../support/fake-reme.ts'
import MemorySettings from '../support/memory-settings.ts'

/** 这一轮起过的假 server，`afterEach` 统一关掉。 */
const opened: { stop(): Promise<void> }[] = []
const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length) await contexts.pop()?.fiber.dispose()
  while (opened.length) await opened.pop()?.stop()
})

describe('T14 —— 四个 job 的请求形状', () => {
  it('`search` 发 query 与 limit，并解析字符串 answer', async () => {
    const reme = await startFakeReme(okReply('## 关于主人\n- 喜欢 某部番剧\n- 熬夜'))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })

    const hits = await provider.search('主人喜欢什么', { limit: 4 })

    expect(reme.requests).toEqual([{ job: 'search', body: { query: '主人喜欢什么', limit: 4 } }])
    expect(hits).toHaveLength(1)
    expect(hits[0]?.content).toContain('某部番剧')
  })

  it('`record` 发 session_id 与 messages（ReMe 靠它自动沉淀）', async () => {
    const reme = await startFakeReme(okReply('ok'))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })

    await provider.record(
      {
        messages: [
          { role: 'user', content: '在吗' },
          { role: 'assistant', content: '在的' },
        ],
      },
      'agent:2000000002:group:3000000003',
    )

    expect(reme.requests).toEqual([
      {
        job: 'auto_memory',
        body: {
          // ⚠️ session_id **过了 `remeSessionId` 的净化**（冒号 → 短横线）。
          // 我们的 id 含 `:`，而 ReMe 把它当文件名组件校验 —— 直接发会被拒
          // （success:false，HTTP 200 的静默失败）。
          session_id: 'agent-2000000002-group-3000000003',
          // ⚠️ 形状不是 `{role, content}`：ReMe 内部用 AgentScope 的 `Msg`
          // 做 pydantic 校验，`name` **必填**（缺了报 ValidationError，但 HTTP 仍回
          // 200 —— 表现为"写回静默失败"），`content` 是块数组。
          // 2026-09-26 对真实 ReMe 实测踩出来的，取舍见 reme.ts 的注释。
          messages: [
            { name: 'user', role: 'user', content: [{ type: 'text', text: '在吗' }] },
            { name: 'assistant', role: 'assistant', content: [{ type: 'text', text: '在的' }] },
          ],
        },
      },
    ])
  })

  it('`consolidate` 打 auto_dream', async () => {
    const reme = await startFakeReme(okReply(null))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })

    await provider.consolidate()

    expect(reme.requests.map((request) => request.job)).toEqual(['auto_dream'])
  })

  it('`health` 打 health_check，成功时 ok: true', async () => {
    const reme = await startFakeReme(okReply('ok'))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })

    const health = await provider.health()

    // job 名是 `health_check` —— 2026-09-26 对真实 ReMe 0.4.1.13 实测确认
    expect(reme.requests.map((request) => request.job)).toEqual(['health_check'])
    expect(health.ok).toBe(true)
  })

  it('端点末尾有斜杠也拼得出正确路径', async () => {
    const reme = await startFakeReme(okReply('x'))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: `${reme.endpoint}/`, timeoutMs: 2000 })

    await provider.consolidate()

    expect(reme.requests.map((request) => request.job)).toEqual(['auto_dream'])
  })
})

describe('T14 —— 响应解析', () => {
  it('数组 answer → 多条 hits', async () => {
    const reme = await startFakeReme(
      okReply([
        { content: '记得的第一件事', source: 'daily/2026-09-25.md', score: 0.9 },
        { text: '第二件（用 text 字段）' },
        '第三件（裸字符串）',
      ]),
    )
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })

    const hits = await provider.search('q', { limit: 5 })

    expect(hits.map((hit) => hit.content)).toEqual([
      '记得的第一件事',
      '第二件（用 text 字段）',
      '第三件（裸字符串）',
    ])
    expect(hits[0]?.score).toBe(0.9)
    expect(hits[0]?.source).toBe('daily/2026-09-25.md')
  })

  it('`answer` 为 null / 空串 → 空数组（正常的"没找到"）', async () => {
    const reme = await startFakeReme(okReply(null))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })

    await expect(provider.search('q', { limit: 5 })).resolves.toEqual([])
  })

  it('⚠️ `success: false` → 抛错并带上原因（不静默当成"没找到"）', async () => {
    const reme = await startFakeReme(() => ({ success: false, metadata: 'index not built' }))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })

    await expect(provider.search('q', { limit: 5 })).rejects.toThrow(/index not built/)
  })

  it('⚠️ `success: false` 的原因在 answer 里（metadata 只是无关统计）—— 两者都要露出来', async () => {
    // 真实形状（2026-09-26 实测）：auto_memory 因 session_id 非法失败时，
    //   answer   = "Error: session_id contains invalid characters ..."  ← 真原因
    //   metadata = {"auto_tag":{"processed":0,"succeeded":0,...}}         ← 噪声
    // 只读 metadata 会把"一眼可修"的问题伪装成"标签流程异常"，查错方向被带偏。
    const reme = await startFakeReme(() => ({
      success: false,
      answer: 'Error: session_id contains invalid characters',
      metadata: { auto_tag: { processed: 0, succeeded: 0, failed: 0 } },
    }))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })

    await expect(provider.record({ messages: [{ role: 'user', content: 'x' }] }, 'bad:id')).rejects.toThrow(
      /session_id contains invalid characters/,
    )
  })

  it('`success: false` 且 answer 缺席 → 退回 metadata 里的信息', async () => {
    const reme = await startFakeReme(() => ({ success: false, metadata: { code: 'E_NO_INDEX' } }))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })

    await expect(provider.search('q', { limit: 5 })).rejects.toThrow(/E_NO_INDEX/)
  })

  it('⚠️ `success: true` 但 answer 形状不认识 → 抛错（形状变了要可见）', async () => {
    const reme = await startFakeReme(okReply(42))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })

    await expect(provider.search('q', { limit: 5 })).rejects.toThrow(/形状不认识/)
  })

  it('HTTP 非 2xx → 抛错并带上状态码', async () => {
    const server500 = createServer((_req, res) => {
      res.statusCode = 500
      res.end('boom')
    })
    await new Promise<void>((resolve) => server500.listen(0, '127.0.0.1', resolve))
    const address = server500.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    opened.push({
      stop: () =>
        new Promise<void>((resolve) => {
          server500.close(() => {
            resolve()
          })
        }),
    })

    const provider = new RemeProvider({ endpoint: `http://127.0.0.1:${port}`, timeoutMs: 2000 })
    await expect(provider.search('q', { limit: 5 })).rejects.toThrow(/HTTP 500/)
  })

  it('health 在 provider 层就把失败转成 `{ ok: false }`（不抛）', async () => {
    const blackHole = await startBlackHole()
    opened.push(blackHole)
    const provider = new RemeProvider({ endpoint: blackHole.endpoint, timeoutMs: 200 })

    const health = await provider.health()

    expect(health.ok).toBe(false)
    expect(health.detail).toBeTruthy()
  })
})

describe('T14 —— 端到端降级（经 MemoryService）', () => {
  async function makeMemoryCtx(over: Record<string, unknown>): Promise<Context> {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(MemoryService, {
      provider: 'reme',
      endpoint: 'http://127.0.0.1:1', // 会被 over 覆盖
      searchLimit: 5,
      requestTimeoutMs: 2000,
      writeTimeoutMs: 2000,
      // 本文件的 `record` 用例关心“发出去的请求形状”，关掉攒批（阈值本身见 outbox 单测）。
      batchRounds: 1,
      ...over,
    })
    return ctx
  }

  it('⚠️ provider 超时 → `search` 返回 `[]`，对话不受影响（核心承诺）', async () => {
    const blackHole = await startBlackHole()
    opened.push(blackHole)
    const ctx = await makeMemoryCtx({ endpoint: blackHole.endpoint, requestTimeoutMs: 200 })

    expect(ctx.memory.providerId).toBe('reme')
    await expect(ctx.memory.search('任何查询')).resolves.toEqual([])
  })

  it('⚠️ `success: false` → `search` 返回 `[]`（降级，不抛）', async () => {
    const reme = await startFakeReme(() => ({ success: false, metadata: 'backend tainted' }))
    opened.push(reme)
    const ctx = await makeMemoryCtx({ endpoint: reme.endpoint })

    await expect(ctx.memory.search('q')).resolves.toEqual([])
  })

  it('⚠️ ReMe 完全不可达（端口没人听）→ `search` 返回 `[]`', async () => {
    // 127.0.0.1:1 上不会有服务
    const ctx = await makeMemoryCtx({ endpoint: 'http://127.0.0.1:1' })

    await expect(ctx.memory.search('q')).resolves.toEqual([])
  })

  it('正常路径：召回结果经服务透传（hits 带内容）', async () => {
    const reme = await startFakeReme(okReply('小研喜欢发饰'))
    opened.push(reme)
    const ctx = await makeMemoryCtx({ endpoint: reme.endpoint })

    const hits = await ctx.memory.search('喜欢什么')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.content).toContain('发饰')
  })

  it('`record` 经服务落到 auto_memory（写回不阻塞）', async () => {
    const reme = await startFakeReme(okReply('ok'))
    opened.push(reme)
    const ctx = await makeMemoryCtx({ endpoint: reme.endpoint })

    await ctx.memory.record({ messages: [{ role: 'user', content: '你好' }] }, 'admin:1')
    // ⚠️ 必须显式 flush：T42 之后 `record` resolve 只意味着“已收下并落盘”，
    // 交给 provider 是 flush 的事 —— 不 await 它才没把 20s 的沉淀接回对话路径。
    await ctx.memory.flush('admin:1')

    expect(reme.requests).toEqual([
      {
        job: 'auto_memory',
        body: {
          session_id: 'admin-1',
          messages: [{ name: 'user', role: 'user', content: [{ type: 'text', text: '你好' }] }],
        },
      },
    ])
  })

  it('未满阈值时不碰 provider（经服务看得到“攒着”这个中间态）', async () => {
    const reme = await startFakeReme(okReply('ok'))
    opened.push(reme)
    const ctx = await makeMemoryCtx({ endpoint: reme.endpoint, batchRounds: 3 })

    await ctx.memory.record({ messages: [{ role: 'user', content: '第一轮' }] }, 'admin:1')

    expect(reme.requests, '1/3 轮不该发请求').toEqual([])
    expect(ctx.memory.pendingRounds('admin:1')).toBe(1)

    await ctx.memory.record({ messages: [{ role: 'user', content: '第二轮' }] }, 'admin:1')
    await ctx.memory.record({ messages: [{ role: 'user', content: '第三轮' }] }, 'admin:1')
    await ctx.memory.flush('admin:1')

    // 三轮合成**一次** auto_memory，而不是三次往返
    expect(reme.requests).toHaveLength(1)
    const body = reme.requests[0]?.body as { messages?: unknown[] } | undefined
    expect(body?.messages).toHaveLength(3)
  })
})

/**
 * T41 的回归门：超时必须**按 job 分档**。
 *
 * 单条阈值管两种耗时差 3 个数量级的 job，就是 T41 误报的根因
 * （`search` 5-35ms / `auto_memory` 19-27s，共用 10s）。
 * 下面的用例用“同一后端、同一延迟”分别打到两条路径上 —— 只有分档生效时，
 * 才会一个被砍、一个活。
 */
describe('T41/T42 —— 超时按 job 分档', () => {
  /** 每个 job 都固定延迟后才正常回应的假 ReMe。 */
  const delayed = (ms: number) => async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return { success: true, answer: 'ok' }
  }

  it('⚠️ 同一延迟下：快路径被 `timeoutMs` 砍，慢路径按 `writeTimeoutMs` 活', async () => {
    const reme = await startFakeReme(delayed(300))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 100, writeTimeoutMs: 3000 })

    await expect(provider.search('q', { limit: 3 })).rejects.toThrow(/abort/i)
    await expect(
      provider.record({ messages: [{ role: 'user', content: 'x' }] }, 'admin:1'),
    ).resolves.toBeUndefined()
  })

  it('不传 `writeTimeoutMs` 时退回 `timeoutMs`（旧语义 —— 分档是显式选择）', async () => {
    const reme = await startFakeReme(delayed(300))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 100 })

    await expect(
      provider.record({ messages: [{ role: 'user', content: 'x' }] }, 'admin:1'),
    ).rejects.toThrow(/abort/i)
  })

  it('`consolidate`（auto_dream）也算慢路径：同样按 `writeTimeoutMs` 放行', async () => {
    const reme = await startFakeReme(delayed(300))
    opened.push(reme)
    const provider = new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 100, writeTimeoutMs: 3000 })

    await expect(provider.consolidate()).resolves.toBeUndefined()
  })
})

/**
 * `session_id` 映射 —— ReMe 把它当**文件名组件**校验，所以这是一道真实的
 * 协议约束，不是风格问题。2026-09-26 对真实 ReMe 实测：直接发
 * `agent:2000000002:group:3000000003` 会拿到 `success: false`
 * + `Error: session_id contains invalid characters`（HTTP 200 的静默失败）。
 */
describe('T14 —— session_id 映射（ReMe 的文件名纪律）', () => {
  it('bridge 的真实 id 形状：冒号净化掉，仍然可读', () => {
    expect(remeSessionId('agent:2000000002:group:3000000003')).toBe('agent-2000000002-group-3000000003')
    expect(remeSessionId('admin:1000000001')).toBe('admin-1000000001')
    expect(remeSessionId('world:1000000001')).toBe('world-1000000001')
  })

  it('确定性 —— 同一 session 永远映射到同一个 ReMe id', () => {
    // 否则 ReMe 每次都当新会话，会话日志累积不起来
    const id = 'agent:2000000002:group:3000000003'
    expect(remeSessionId(id)).toBe(remeSessionId(id))
  })

  it('净化解决不了的边界一律落到 hash 兜底（且仍然合法）', () => {
    // 这些是"净化"管不了的：空、点、尾点、Windows 保留设备名
    for (const hostile of ['', '.', '..', 'trailing.', 'CON', 'com1', 'nul', '  ']) {
      const mapped = remeSessionId(hostile)
      expect(mapped, `输入 ${JSON.stringify(hostile)} 该走 hash 兜底`).toMatch(/^yanxin-[0-9a-f]{24}$/)
    }
  })

  it('对任意输入，输出都能当文件名（ReMe 的校验规则逐条断言）', () => {
    const hostile = [
      'agent:1:group:2',
      'a/b\\c',
      'a<b>c',
      'a"b|c?d*e',
      'a\u0000b\u001fc',
      'a\u007fb\u0085c', // DEL + C1 —— ReMe 的 `\x00-\x1f` 不拦这些，我们拦
      '  padded  ',
      '.',
      '..',
      'x.',
      'CON',
      'PRN',
      'LPT9',
      'nul.txt',
      '👾 表情与中文也来一个',
      'a'.repeat(300),
    ]

    for (const input of hostile) {
      const mapped = remeSessionId(input)
      // 逐条对着 ReMe 的 `validate_filename_component` 断言
      expect(mapped, `空：${JSON.stringify(input)}`).not.toBe('')
      expect(mapped, `点是 . 或 ..：${JSON.stringify(input)}`).not.toBe('.')
      expect(mapped, `点是 . 或 ..：${JSON.stringify(input)}`).not.toBe('..')
      expect(mapped, `首尾空白：${JSON.stringify(input)}`).toBe(mapped.trim())
      // `\p{Cc}` = Unicode 的 Control 类别（比 ReMe 的 `\x00-\x1f` 多含 DEL 与 C1）。
      // 实现用的是同一个字符集 —— 断言比它更严才有意义（"比后端严"不产生风险）。
      expect(mapped, `非法字符：${JSON.stringify(input)}`).not.toMatch(/[<>:"/\\|?*\p{Cc}]/u)
      expect(mapped, `结尾点：${JSON.stringify(input)}`).not.toMatch(/\.$/)
      expect(mapped.split('.')[0]?.toUpperCase(), `保留名：${JSON.stringify(input)}`).not.toMatch(
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/,
      )
    }
  })
})
