/**
 * 记忆**降级**的验收（spec §8 的 T13）。
 *
 * 要钉住的承诺只有一句：**记忆是增强，不是依赖**。ReMe 挂了、超时、返回垃圾 ——
 * 对话都必须照常进行。所以这里的断言几乎全是"**不抛**"：
 *
 *   · provider 抛错 → `search` 返回 `[]` + WARN，**不抛**
 *   · 没有 provider  → `search` 返回 `[]`（静默，这是正常形态而非故障）
 *   · `record` / `consolidate` 失败 → 记 WARN，**不阻塞对话**
 *   · `health()` 是**探测**，抛错转成 `{ ok: false, detail }`
 *
 * ⚠️ 降级**统一在服务层做一次**（而不是指望每个 provider 都记得写 try/catch）——
 * 这样换后端时这条承诺不会退化。本文件测的就是那一层。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import MemoryService, { type MemoryHealth, type MemoryHit, type MemoryProvider } from '../../src/memory/service.ts'
import MemorySettings from '../support/memory-settings.ts'

const opened: Context[] = []

/**
 * 行 config 的完整默认值。
 *
 * ⚠️ schemastery 的 `.default()` 只在**运行时**填充，`ctx.plugin()` 的参数**类型**要完整 ——
 * 所以测试里给全量（再用 `over` 覆盖单个键），而不是只传想改的那个。
 */
const FULL_CONFIG = {
  provider: 'none',
  endpoint: 'http://127.0.0.1:2333',
  searchLimit: 5,
  requestTimeoutMs: 10_000,
}

async function makeCtx(over: Partial<typeof FULL_CONFIG> = {}): Promise<Context> {
  const ctx = new Context()
  opened.push(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(MemoryService, { ...FULL_CONFIG, ...over })
  return ctx
}

/** 每个方法都抛的 provider —— 模拟"后端整个挂了"。 */
function faultyProvider(): MemoryProvider {
  const boom = (): never => {
    throw new Error('后端挂了')
  }
  return {
    id: 'faulty',
    search: async () => boom(),
    record: async () => boom(),
    consolidate: async () => boom(),
    health: async () => boom(),
  }
}

/** 正常 provider，可按需覆盖某个方法。 */
function okProvider(over: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    id: 'ok',
    search: async () => [],
    record: async () => undefined,
    consolidate: async () => undefined,
    health: async () => ({ ok: true }),
    ...over,
  }
}

const TRAJECTORY = { messages: [{ role: 'user' as const, content: '你好' }] }

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
})

describe('T13 —— 降级：provider 出问题不阻塞对话', () => {
  it('⚠️ provider 抛错时 `search` 返回 `[]` 且**不抛**（核心承诺）', async () => {
    const ctx = await makeCtx()
    ctx.memory.setProvider(faultyProvider())

    await expect(ctx.memory.search('任何查询')).resolves.toEqual([])
  })

  it('没有 provider 时 `search` 返回 `[]`（正常形态，不是故障）', async () => {
    const ctx = await makeCtx()

    expect(ctx.memory.providerId).toBeUndefined()
    await expect(ctx.memory.search('任何查询')).resolves.toEqual([])
  })

  it('provider 的 search 返回非数组时也归一成 `[]`（不让畸形返回炸调用方）', async () => {
    const ctx = await makeCtx()
    ctx.memory.setProvider(
      okProvider({ search: async () => undefined as unknown as readonly MemoryHit[] }),
    )

    await expect(ctx.memory.search('q')).resolves.toEqual([])
  })

  it('`record` 失败不抛（写回是异步沉降，丢一轮可接受）', async () => {
    const ctx = await makeCtx()
    ctx.memory.setProvider(faultyProvider())

    await expect(ctx.memory.record(TRAJECTORY, 'agent:1:group:2')).resolves.toBeUndefined()
  })

  it('`consolidate` 失败不抛', async () => {
    const ctx = await makeCtx()
    ctx.memory.setProvider(faultyProvider())

    await expect(ctx.memory.consolidate()).resolves.toBeUndefined()
  })

  it('没有 provider 时 `record` / `consolidate` 安静返回（不报错）', async () => {
    const ctx = await makeCtx()

    await expect(ctx.memory.record(TRAJECTORY, 's')).resolves.toBeUndefined()
    await expect(ctx.memory.consolidate()).resolves.toBeUndefined()
  })
})

describe('T13 —— health() 是探测，不是异常通道', () => {
  it('透传 provider 的成功结果', async () => {
    const ctx = await makeCtx()
    const detail: MemoryHealth = { ok: true, detail: 'ReMe 正常' }
    ctx.memory.setProvider(okProvider({ health: async () => detail }))

    expect(await ctx.memory.health()).toEqual(detail)
  })

  it('provider 抛错时转成 `{ ok: false, detail }`，**不抛**', async () => {
    const ctx = await makeCtx()
    ctx.memory.setProvider(faultyProvider())

    const health = await ctx.memory.health()
    expect(health.ok).toBe(false)
    expect(health.detail).toContain('后端挂了')
  })

  it('没有 provider 时 `ok: false` 并说明配置里的 provider id', async () => {
    // 用一个**未知** id：syncProvider 会 warn 并按"无记忆"运行
    const ctx = await makeCtx({ provider: 'not-installed' })

    const health = await ctx.memory.health()
    expect(health.ok).toBe(false)
    expect(health.detail).toContain('not-installed')
  })
})

describe('T14 —— 按配置装载 provider', () => {
  it('`provider: none`（默认）→ 不装载', async () => {
    const ctx = await makeCtx()

    expect(ctx.memory.providerId).toBeUndefined()
  })

  it('`provider: reme` + 回环端点 → 装载（不发请求）', async () => {
    const ctx = await makeCtx({ provider: 'reme', endpoint: 'http://127.0.0.1:2333' })

    expect(ctx.memory.providerId).toBe('reme')
  })

  it('未知 provider → 不装载，但**不抛**（记忆是增强，配置写错不该让 bot 起不来）', async () => {
    const ctx = await makeCtx({ provider: 'typo' })

    expect(ctx.memory.providerId).toBeUndefined()
    await expect(ctx.memory.search('q')).resolves.toEqual([])
  })

  it('⚠️ `provider: reme` + **非回环**端点 → 装载直接失败（ReMe 无鉴权）', async () => {
    await expect(makeCtx({ provider: 'reme', endpoint: 'http://10.0.0.1:2333' })).rejects.toThrow(
      /回环/,
    )
  })
})

describe('T13 —— 正常路径与 provider 生命周期', () => {
  it('provider 正常时透传召回结果', async () => {
    const ctx = await makeCtx()
    ctx.memory.setProvider(
      okProvider({
        search: async () => [{ content: '小研喜欢发饰', source: 'digest/personal/小研.md' }],
      }),
    )

    const hits = await ctx.memory.search('喜欢什么')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.content).toContain('发饰')
  })

  it('默认 limit 来自 settings 的 searchLimit', async () => {
    const ctx = await makeCtx({ searchLimit: 3 })
    const seen: number[] = []
    ctx.memory.setProvider(
      okProvider({
        search: async (_query, options) => {
          seen.push(options.limit)
          return []
        },
      }),
    )

    await ctx.memory.search('q')
    expect(seen).toEqual([3])
  })

  it('调用方可以按次覆盖 limit', async () => {
    const ctx = await makeCtx({ searchLimit: 3 })
    const seen: number[] = []
    ctx.memory.setProvider(
      okProvider({
        search: async (_query, options) => {
          seen.push(options.limit)
          return []
        },
      }),
    )

    await ctx.memory.search('q', { limit: 1 })
    expect(seen).toEqual([1])
  })

  it('`setProvider` 返回的 disposer 摘掉 provider（卸载后回到无记忆）', async () => {
    const ctx = await makeCtx()
    const dispose = ctx.memory.setProvider(okProvider())

    expect(ctx.memory.providerId).toBe('ok')
    dispose()
    expect(ctx.memory.providerId).toBeUndefined()
    await expect(ctx.memory.search('q')).resolves.toEqual([])
  })

  it('⚠️ disposer 是单次的：重复调用不会摘掉"后来者"', async () => {
    const ctx = await makeCtx()
    const disposeOld = ctx.memory.setProvider(okProvider({ id: 'old' }))
    disposeOld() // 已经摘掉
    ctx.memory.setProvider(okProvider({ id: 'new' }))

    disposeOld() // 再调一次
    expect(ctx.memory.providerId, '后来装载的 provider 不该被旧的 disposer 摘掉').toBe('new')
  })

  it('发出 `yanxin/memory-provider` 事件（控制台可观察装载变化）', async () => {
    const ctx = await makeCtx()
    const seen: (string | undefined)[] = []
    ctx.on('yanxin/memory-provider', (id) => {
      seen.push(id)
    })

    const dispose = ctx.memory.setProvider(okProvider())
    dispose()

    expect(seen).toEqual(['ok', undefined])
  })
})
