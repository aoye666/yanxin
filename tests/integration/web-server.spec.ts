/**
 * webServer 路由的回滚语义（spec §8 的 **T15**）。
 *
 * 为什么这条重要：`/yanxin` 控制台（T29+）会注册一批路由。cordis 的纪律是
 * **任何上下文变更都要返回反注册闭包**（spec §7.2），但"忘了包 `ctx.effect`"
 * 在开发期**看不出任何异常** —— 路由照样工作，只有在插件卸载/热重载之后才表现为
 * "旧路由还在、新注册又撞上它"。所以这里把两种写法都跑一遍：
 *
 *   · **反例**：不包 effect → 子插件卸载后路由**仍在**（这就是那个坑）
 *   · **正例**：包 effect   → 卸载后路由**消失**（404）
 *
 * 反例不是凑数 —— 它证明"这条测试真的在测回滚"，而不是碰巧通过。
 *
 * 端口用 `0`（OS 分配），所以**不会撞上正在运行的真实实例**（8080 / 8090）。
 */
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'

const opened: Context[] = []

/** 起一个只监听随机端口的 webServer。 */
async function makeCtx(): Promise<Context> {
  const ctx = new Context()
  opened.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  return ctx
}

/**
 * 一个只做一件事的测试插件：注册一条路由。
 *
 * `useEffect` 决定注册是否包在 `ctx.effect` 里 —— 两个测试的唯一差别就是它。
 */
function routePlugin(options: { path: string; body: string; useEffect: boolean }) {
  return {
    name: `test-route${options.useEffect ? '-effect' : '-raw'}`,
    // ⚠️ 子插件必须**自己** inject：它的 ctx 是独立作用域，不继承父级的服务解析。
    // 不写这一行会得到 "cannot get property \"webServer\" without inject" ——
    // 正是 ADR 0004 记的那个坑（这次是写测试时踩的）。
    inject: ['webServer'],
    apply(ctx: Context) {
      const register = (): (() => void) =>
        ctx.webServer.register({
          kind: 'prefix',
          path: options.path,
          handler: (_req, res) => {
            res.end(options.body)
          },
        })

      if (options.useEffect) ctx.effect(register, 'test.route')
      else register()
    },
  }
}

/** 请求一条路径：拿到文本（2xx）或状态码。 */
async function get(ctx: Context, path: string): Promise<string | number> {
  const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${path}`)
  return response.ok ? await response.text() : response.status
}

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
})

describe('T15 —— 重复注册', () => {
  it('同 `(kind, path)` 注册两次抛错', async () => {
    const ctx = await makeCtx()
    const route = {
      kind: 'prefix' as const,
      path: '/yanxin',
      handler: (_req: unknown, res: { end: (body: string) => void }) => {
        res.end('ok')
      },
    }

    ctx.webServer.register(route as never)
    // 官方文档：Duplicate (kind, path) throws — route patterns are identity
    expect(() => ctx.webServer.register(route as never)).toThrow()
  })

  it('⚠️ 同 path 但不同 kind 不算重复（exact 与 prefix 可共存）', async () => {
    const ctx = await makeCtx()
    const handler = (_req: unknown, res: { end: (body: string) => void }): void => {
      res.end('ok')
    }

    ctx.webServer.register({ kind: 'prefix', path: '/yanxin', handler } as never)
    expect(() =>
      ctx.webServer.register({ kind: 'exact', path: '/yanxin', handler } as never),
    ).not.toThrow()
  })
})

describe('T15 —— 卸载回滚（两种写法对照）', () => {
  it('⚠️ 反例：不包 `ctx.effect` → 子插件卸载后路由**仍在**', async () => {
    const ctx = await makeCtx()
    const fiber = await ctx.plugin(routePlugin({ path: '/no-effect', body: 'still here', useEffect: false }))

    expect(await get(ctx, '/no-effect')).toBe('still here')

    await fiber.dispose()

    // 这正是"注册了却不反注册"（spec §7.3 反例）的可观测后果：
    // 插件走了，路由留着 —— 而且下一次注册同一路径会直接 throw。
    expect(await get(ctx, '/no-effect')).toBe('still here')
  })

  it('✅ 正例：包了 `ctx.effect` → 卸载后路由消失（404）', async () => {
    const ctx = await makeCtx()
    const fiber = await ctx.plugin(routePlugin({ path: '/with-effect', body: 'alive', useEffect: true }))

    expect(await get(ctx, '/with-effect')).toBe('alive')

    await fiber.dispose()

    expect(await get(ctx, '/with-effect')).toBe(404)
  })

  it('✅ 卸载后可以重新注册同一路径（disposer 真的放开了占用）', async () => {
    const ctx = await makeCtx()
    const first = await ctx.plugin(routePlugin({ path: '/reuse', body: 'first', useEffect: true }))
    await first.dispose()

    // 若 disposer 只是"停止响应"而没清掉注册表，这里会 throw
    const second = await ctx.plugin(routePlugin({ path: '/reuse', body: 'second', useEffect: true }))
    expect(await get(ctx, '/reuse')).toBe('second')

    await second.dispose()
    expect(await get(ctx, '/reuse')).toBe(404)
  })
})
