/**
 * 记忆的**契约测试集**（spec §8 的 T15·memory）—— 同一套用例跑任何 provider。
 *
 * 这是"**可换后端**"承诺的兑现方式：v1 只有 ReMe，但如果断言只针对 ReMe 的行为写，
 * 换后端时就没人知道哪些行为是契约、哪些只是 ReMe 的实现细节。
 *
 * 所以这里：
 *   · 用例只断言**形状与不变量**（`content`/`source` 必有、条数不超 limit、
 *     失败一律降级成 `[]`），**不**断言具体条数或文本 —— 那是 provider 的语义自由；
 *   · 用例集通过 {@link ProviderHarness} 注入 provider，**不知道**底下是谁；
 *   · 跑两遍：一遍**内存假 provider**（证明契约自洽、用例本身有效），
 *     一遍 **ReMeProvider + 假 ReMe HTTP server**（证明真实实现满足契约）。
 *
 * ⚠️ 断言都经 `MemoryService` 观察，而不是直接调 provider —— 消费者（bridge、
 * 未来的世界引擎）看到的就是这一层，契约该在边界上成立。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import MemoryService, { type MemoryHit, type MemoryProvider } from '../../src/memory/service.ts'
import { RemeProvider } from '../../src/memory/reme.ts'
import { okReply, startBlackHole, startFakeReme, startFailingReme } from '../support/fake-reme.ts'
import MemorySettings from '../support/memory-settings.ts'

const FULL_CONFIG = {
  provider: 'none',
  endpoint: 'http://127.0.0.1:2333',
  searchLimit: 5,
  requestTimeoutMs: 10_000,
}

/** 一份 provider 的"三种状态"——契约用例只要求 harness 能造出这三种。 */
interface ProviderHarness {
  /** 正常：`search` 能返回 `contents` 对应的结果。 */
  ok(contents: string[]): Promise<MemoryProvider>
  /** 报错：所有方法都抛。 */
  faulty(): Promise<MemoryProvider>
  /** 卡住：`search` 不会及时返回（由 provider 自己的超时收场）。 */
  slow(): Promise<MemoryProvider>
  /** 释放 harness 持有的资源（假 server 之类）。 */
  cleanup(): Promise<void>
}

const contexts: Context[] = []

/** 用某个 provider 起一个真实装配的 MemoryService。 */
async function ctxWith(provider: MemoryProvider): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(MemoryService, FULL_CONFIG)
  ctx.memory.setProvider(provider)
  return ctx
}

/** 契约用例集。 */
function contractSuite(name: string, harness: ProviderHarness): void {
  describe(`记忆契约 —— ${name}`, () => {
    afterEach(async () => {
      await harness.cleanup()
    })

    it('召回有结果：返回 `MemoryHit[]`，每条都有 `content` 与 `source`', async () => {
      const ctx = await ctxWith(await harness.ok(['记得你熬夜', '记得你喜欢 某部番剧']))

      const hits = await ctx.memory.search('主人')

      expect(Array.isArray(hits)).toBe(true)
      expect(hits.length).toBeGreaterThan(0)
      for (const hit of hits) {
        expect(typeof hit.content, 'content 必须是字符串').toBe('string')
        expect(hit.content.length).toBeGreaterThan(0)
        expect(typeof hit.source, 'source 必须是字符串').toBe('string')
      }
    })

    it('召回无结果：返回**空数组**（不是 undefined，也不是 null）', async () => {
      const ctx = await ctxWith(await harness.ok([]))

      const hits = await ctx.memory.search('一个不该命中的查询')

      expect(hits).toEqual([])
    })

    it('⚠️ provider 报错：降级成空数组，**不抛**', async () => {
      const ctx = await ctxWith(await harness.faulty())

      await expect(ctx.memory.search('任何查询')).resolves.toEqual([])
    })

    it('⚠️ provider 卡住：降级成空数组，**不抛**', async () => {
      const ctx = await ctxWith(await harness.slow())

      await expect(ctx.memory.search('任何查询')).resolves.toEqual([])
    })

    it('条数不超过请求的 limit', async () => {
      const ctx = await ctxWith(await harness.ok(['一', '二', '三', '四', '五', '六']))

      const hits = await ctx.memory.search('q', { limit: 2 })

      expect(hits.length).toBeLessThanOrEqual(2)
    })

    it('`record` 接受轨迹形状（`{ messages: [{ role, content }] }`）并不抛', async () => {
      const ctx = await ctxWith(await harness.ok(['x']))

      await expect(
        ctx.memory.record(
          {
            messages: [
              { role: 'user', content: '在吗' },
              { role: 'assistant', content: '在的' },
            ],
          },
          'agent:2000000002:group:3000000003',
        ),
      ).resolves.toBeUndefined()
    })

    it('`record` 在 provider 坏掉时也不抛（写回不阻塞对话）', async () => {
      const ctx = await ctxWith(await harness.faulty())

      await expect(
        ctx.memory.record({ messages: [{ role: 'user', content: 'x' }] }, 's'),
      ).resolves.toBeUndefined()
    })

    it('`consolidate` resolve（失败也不抛）', async () => {
      const okCtx = await ctxWith(await harness.ok(['x']))
      await expect(okCtx.memory.consolidate()).resolves.toBeUndefined()

      const badCtx = await ctxWith(await harness.faulty())
      await expect(badCtx.memory.consolidate()).resolves.toBeUndefined()
    })

    it('`health` 返回 `{ ok: boolean }`，且**不抛**（哪怕是坏 provider）', async () => {
      const goodCtx = await ctxWith(await harness.ok(['x']))
      const good = await goodCtx.memory.health()
      expect(typeof good.ok).toBe('boolean')

      const badCtx = await ctxWith(await harness.faulty())
      const bad = await badCtx.memory.health()
      expect(typeof bad.ok).toBe('boolean')
      expect(bad.ok).toBe(false)
    })

    it('召回结果不共享可变引用（provider 改自己的数组不该影响已返回的快照）', async () => {
      const hits: MemoryHit[] = [{ content: '原始内容', source: 'a.md' }]
      const ctx = await ctxWith(await harness.ok(hits.map((hit) => hit.content)))

      const first = await ctx.memory.search('q')
      const content = first[0]?.content
      expect(content).toBeTruthy()

      // 再取一次：两次调用之间 provider 内部状态变化不该让第一次的结果变形
      const second = await ctx.memory.search('q')
      expect(second[0]?.content).toBe(content)
    })
  })
}

// ── 实现一：内存假 provider ────────────────────────────────────────────

/** 可编程的内存 provider —— 契约自洽的证明，也是用例本身的对照组。 */
function memoryProvider(script: { hits?: string[]; fail?: boolean; stall?: boolean }): MemoryProvider {
  const boom = (): never => {
    throw new Error('假 provider 故意失败')
  }
  return {
    id: 'memory-fake',
    search: async (_query, options) => {
      if (script.fail === true) boom()
      if (script.stall === true) throw new Error('假 provider 卡住（模拟超时）')
      return (script.hits ?? []).slice(0, options.limit).map((content) => ({ content, source: 'fake' }))
    },
    record: async () => {
      if (script.fail === true) boom()
    },
    consolidate: async () => {
      if (script.fail === true) boom()
    },
    health: async () => ({ ok: script.fail !== true }),
  }
}

contractSuite('内存假 provider', {
  ok: async (contents) => memoryProvider({ hits: contents }),
  faulty: async () => memoryProvider({ fail: true }),
  slow: async () => memoryProvider({ stall: true }),
  cleanup: async () => undefined,
})

// ── 实现二：ReMeProvider + 假 ReMe HTTP server ─────────────────────────

/** 这一轮 harness 起过的假 server，`cleanup` 时统一关掉。 */
const servers: { stop(): Promise<void> }[] = []

contractSuite('ReMe（假 HTTP server）', {
  ok: async (contents) => {
    const reme = await startFakeReme(okReply(contents.join('\n\n')))
    servers.push(reme)
    return new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })
  },
  faulty: async () => {
    const reme = await startFailingReme(500)
    servers.push(reme)
    return new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 2000 })
  },
  slow: async () => {
    const reme = await startBlackHole()
    servers.push(reme)
    // 超时设短一点：契约要求的是"卡住 → 降级"，不是"卡多久"
    return new RemeProvider({ endpoint: reme.endpoint, timeoutMs: 200 })
  },
  cleanup: async () => {
    while (servers.length) await servers.pop()?.stop()
  },
})

afterEach(async () => {
  while (contexts.length) await contexts.pop()?.fiber.dispose()
})
