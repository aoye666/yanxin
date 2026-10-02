/**
 * window 服务的**真实装配**测试 —— 堵 2026-09-26"五之三"发现的默认时段缺陷。
 *
 * 为什么单独建文件：`window-logic.spec.ts` 测的是**纯函数**（logic.ts），而那个缺陷
 * 活在"真实 `ctx.settings` + 空配置"的装配路径上 —— schemastery 的 `z.array()`
 * **自带 `[]` 默认值**，把 `windows` getter 的三级回退卡死在第一级
 * （`scope.get().windows` 永远是 `[]` 而非 `undefined`），内置默认 14:00–18:00
 * 变成死代码、窗口恒关、World 引擎永不装载。
 *
 * 这类"单测全绿、真实装配失效"的洞，只能用**真实 settings 装配**的测试来堵 ——
 * 而测试必须打在**生产 schema** 上（自抄一份 schema 的话，它被改坏时测试不会红）。
 * 做法：经服务自己 `register` 的那个 scope 写入（`scopeOf(service)`）—— 校验它的
 * 就是生产 schema，所以这里不需要（也不该）另抄一份。
 *
 * 覆盖三级回退的三条路径 + 一个语义边界：
 *   1. 无任何配置 → 内置默认 14:00–18:00（**缺陷回归测试**，修复前这条红）
 *   2. 行 config 提供时段 → 用它（settings 缺席时不能被卡住）
 *   3. settings 配置 → 优先于行 config 与默认
 *   4. settings 显式空数组 → 尊重为"恒关"（`.default(undefined)` 只该接管
 *      "**没写**"的情形，不能吞掉"**写了空**"的表达）
 *
 * 装配方式：直接 `new WindowService(ctx)` 而不是 `ctx.plugin` —— 类的
 * `static inject = ['settings', 'loader']` 是给**生产装配**用的；这里只需要
 * 真实的 `ctx.settings`（MemorySettings provider），loader 用最小假对象
 * （reconcile 对它的契约只有 `entries()` → `options.id` / `disabled` / `update`，
 * 找不到也只是 warn-once，不炸 —— 这本身就是 T19 要验收的容错行为）。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import WindowService from '../../src/window/index.ts'
import MemorySettings from '../support/memory-settings.ts'

const opened: Context[] = []

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
})

/** 假 loader entry：记录 update 调用。形状照 `LoaderEntryLike` 的最小面。 */
function fakeEngineEntry(id = 'yanxin-world-engine', disabled = true) {
  const entry = {
    options: { id },
    disabled,
    updates: [] as { disabled: boolean }[],
    async update(patch: { disabled: boolean }) {
      entry.updates.push(patch)
      entry.disabled = patch.disabled
    },
  }
  return entry
}

function attachFakeLoader(ctx: Context): void {
  const entry = fakeEngineEntry()
  // 断言面刻意**不含 Context**：vendor 类型里 ctx.loader 已有完整 Entry 声明，
  // 交叉断言会让假对象被要求补齐 18 个无关成员。这里只声明我们要赋的那个键。
  ;(ctx as unknown as { loader?: unknown }).loader = {
    // LoaderSurface.entries() 声明为 Iterable（照 vendor/loader 的形状）—— generator 形态
    entries: () =>
      (function* () {
        yield entry
      })(),
  }
}

async function makeCtx(): Promise<Context> {
  const ctx = new Context()
  opened.push(ctx)
  await ctx.plugin(MemorySettings)
  return ctx
}

/**
 * 拿到服务自己 register 的 scope（`private`，运行时只是普通属性 —— ADR 0007 的
 * 品牌检查坑只影响 `#` 私有字段与方法调用的 receiver，直读字段安全）。
 *
 * 为什么不 `ctx.settings.register`：同一命名空间只许注册一次，服务构造时已注册，
 * 测试再注册会 `already registered`。经服务拿 scope 也保证写到的是**生产 schema**
 * 校验下的用户层 —— schema 被改坏时这些测试仍然会红。
 */
function scopeOf(service: WindowService): { update(patch: object): Promise<void> } {
  return (service as unknown as { scope: { update(patch: object): Promise<void> } }).scope
}

describe('window 服务的真实装配（三级回退不被 schemastery 的数组默认值卡死）', () => {
  it('⚠️ 缺陷回归：无任何配置 → 内置默认 14:00–18:00（修复前这里拿到 []）', async () => {
    const ctx = await makeCtx()
    // 生产 patch 就是"不传行 config"挂的（cordis.patch.yml 的 window 行没有 config）
    const service = new WindowService(ctx)
    attachFakeLoader(ctx)

    expect(service.windows).toEqual([{ start: '14:00', end: '18:00' }])
  })

  it('行 config 提供时段 → 用它（settings 缺席时不能被卡住）', async () => {
    const ctx = await makeCtx()
    const service = new WindowService(ctx, { windows: [{ start: '09:00', end: '12:00' }] })
    attachFakeLoader(ctx)

    expect(service.windows).toEqual([{ start: '09:00', end: '12:00' }])
  })

  it('settings 配置 → 优先于行 config 与默认', async () => {
    const ctx = await makeCtx()
    const service = new WindowService(ctx, { windows: [{ start: '09:00', end: '12:00' }] })
    attachFakeLoader(ctx)

    await scopeOf(service).update({ windows: [{ start: '20:00', end: '23:00' }] })

    expect(service.windows).toEqual([{ start: '20:00', end: '23:00' }])
  })

  it('settings 显式空数组 → 尊重为"恒关"（默认值只接管"没写"，不吞"写了空"）', async () => {
    const ctx = await makeCtx()
    const service = new WindowService(ctx)
    attachFakeLoader(ctx)

    await scopeOf(service).update({ windows: [] })

    expect(service.windows).toEqual([])
  })
})

describe('window 服务的手动暂停（控制台引擎开关的后端语义）', () => {
  /** 窗口配置为"现在开着"（evaluate 注入的时钟落在窗口内）。 */
  function openWindows(): { windows: { start: string; end: string }[] } {
    return { windows: [{ start: '00:00', end: '23:59' }] }
  }

  it('⭐ paused=true + 窗口开着 + 引擎行原本装载着 → 行被**卸下**（手动按停压过窗口）', async () => {
    const ctx = await makeCtx()
    const service = new WindowService(ctx, openWindows())
    const entry = fakeEngineEntry('yanxin-world-engine', false) // 最初是装载着的
    ;(ctx as unknown as { loader?: unknown }).loader = {
      entries: () =>
        (function* () {
          yield entry
        })(),
    }

    // 控制台的写路径：settings 写 paused，watch 触发重裁决（这里直接等它）
    await scopeOf(service).update({ paused: true })
    await service.evaluate(new Date('2026-10-01T22:30:00'))

    expect(service.paused).toBe(true)
    expect(entry.updates).toContainEqual({ disabled: true }) // 窗口开着也被按停
  })

  it('paused=false（默认）→ 不再把"没跑"归罪于暂停：引擎行不受 paused 影响', async () => {
    const ctx = await makeCtx()
    const service = new WindowService(ctx, openWindows())
    const entry = fakeEngineEntry('yanxin-world-engine', true)
    ;(ctx as unknown as { loader?: unknown }).loader = {
      entries: () =>
        (function* () {
          yield entry
        })(),
    }

    // 不写 paused（默认 false）；窗口开着但世界还没创世（隔离 home 里没有现场）——
    // 引擎不装载的原因是**世界守卫**，paused 必须保持 false（页面要把两者分开说）
    await service.evaluate(new Date('2026-10-01T22:30:00'))

    expect(service.paused).toBe(false)
    expect(entry.updates).toEqual([]) // 维持原状：没有因 paused 产生的启停
  })
})
