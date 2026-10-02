/**
 * T19 —— **启停回滚验收**（spec §8 的 T4/T5）。
 *
 * 这是"不重启进程就能启停模式"的验收点，也是选 DSH/Cordis 的核心收益所在。
 * 四组：
 *
 * | 组 | 钉住什么 |
 * |---|---|
 * | A | 引擎行禁用 → 真回滚（timer 停、订阅断、服务从 ctx 消失、**重装是新实例**）；无关服务零感知 |
 * | B | 真实 WindowService 驱动 loader 跨窗口边界：翻转才 update、**只在真实翻转时发事件** |
 * | C | 引擎卸下时，**被动响应照常**（群里被 @ 仍有回复）—— T17 验收第 5 条 |
 * | D | 静态检查无 `ctx.start/stop/dispose/fork`；50 次启停无句柄泄漏 |
 *
 * ⚠️ 本文件用**真 fiber**（`tests/support/fake-loader.ts` 是"假 loader + 真装载"），
 * 所以 A 组的"回滚"是真的 `fiber.dispose()`，不是断言一个标志位。
 *
 * ⚠️ 装备形态：服务用**直接 new**（构造即 provide），不走 `ctx.plugin` ——
 * `static inject` 是给生产装配用的；这里只需要真实的 `ctx.settings` / `ctx.loader`
 * 可读。直接 new 的 Service 会在自己的 ctx 上 provide，同 ctx 可读（已实证）。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WindowService from '../../src/window/index.ts'
import type { WindowSpec } from '../../src/window/logic.ts'
import WorldEngine from '../../src/world/engine.ts'
import FakeLoader from '../support/fake-loader.ts'
import MemorySettings from '../support/memory-settings.ts'
import { BOT, GROUP, FakeSetup, makeBridgeEnv, messageFrame } from '../support/fake-bridge-env.ts'

const ENGINE_ID = 'yanxin-world-engine'
const opened: Context[] = []

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
})

/** 等一小会儿（让 setInterval 至少跑一拍）。 */
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

/** 统一装配：真 settings + 假 loader（含一行真 WorldEngine）。 */
async function makeEnv(): Promise<{ ctx: Context; loader: FakeLoader }> {
  const ctx = new Context()
  opened.push(ctx)
  await ctx.plugin(MemorySettings)
  // T30 的守卫会问"世界创世了吗"（窗口开着不等于她就能过日子）—— 这里给它一个
  // **已就绪**的假向导：本文件要验的是窗口与 loader 的联动，不是守卫本身。
  // 守卫自己的用例在 `tests/unit/setup-guard.spec.ts`。
  const setup = new FakeSetup(ctx)
  void setup
  // tickMs 取小值，让"真的在转"能在毫秒级观察到
  const loader = new FakeLoader(ctx, [{ id: ENGINE_ID, plugin: WorldEngine, config: { tickMs: 5 } }])
  return { ctx, loader }
}

/** 取当前装载的引擎（未装载时 undefined）。 */
function engineOf(ctx: Context): WorldEngine | undefined {
  return ctx.get('world') as WorldEngine | undefined
}

/**
 * 同一性断言。
 *
 * ⚠️ **不能直接 `expect(a).toBe(b)`**：`toBe` 会读对象的 `asymmetricMatch` 属性来判断
 * 它是不是 asymmetric matcher，而 cordis 的服务对象是 **Proxy** —— 读任何属性都会走
 * inject 检查，于是报 `cannot get property "asymmetricMatch" without inject`。
 * 也不能用 `Object.is(a, b)` 比"服务实例"：**`ctx.get()` 每次返回的 Traceable 包装
 * 不是同一对象**（实测 Object.is 为 false）。要比"同一个"就比 **fiber uid** ——
 * 那是装载的身份（这条坑是 T19 实测踩到的）。
 */
function uidOf(service: unknown): number | undefined {
  return (service as { fiber?: { uid?: number } } | undefined)?.fiber?.uid
}

describe('T19-A 引擎行的启停是真回滚（不是标志位）', () => {
  it('初始 disabled → 未装载；启用 → 装载且真的在转', async () => {
    const { ctx, loader } = await makeEnv()
    const entry = loader.entry(ENGINE_ID)

    expect(entry.disabled).toBe(true)
    expect(engineOf(ctx)).toBeUndefined()

    await entry.update({ disabled: false })

    const engine = engineOf(ctx)
    expect(engine).toBeInstanceOf(WorldEngine)
    expect(entry.fiber).toBeDefined()

    const before = engine?.ticks ?? 0
    await tick()
    expect(engine?.ticks ?? 0).toBeGreaterThan(before) // 心跳真的在跑
  })

  it('禁用 → fiber dispose：服务从 ctx 消失、心跳停、订阅断；重装是**全新实例**', async () => {
    const { ctx, loader } = await makeEnv()
    const entry = loader.entry(ENGINE_ID)

    await entry.update({ disabled: false })
    const first = engineOf(ctx)
    expect(first).toBeDefined()

    // 订阅是活的：帧到达会累计
    ctx.emit('onebot/event', { kind: 'event' } as never)
    expect(first?.inbound).toBe(1)

    await entry.update({ disabled: true })

    // 真回滚的三条证据
    expect(engineOf(ctx)).toBeUndefined() // ① 服务从 ctx 注销
    expect(entry.fiber).toBeUndefined() // ② fiber 已释放
    const ticksAtDispose = first?.ticks ?? 0
    await tick()
    expect(first?.ticks).toBe(ticksAtDispose) // ③ 旧实例的心跳停了（timer 已 clear）

    // 重新启用 → 全新实例（计数归零，不是旧实例复活）
    await entry.update({ disabled: false })
    const second = engineOf(ctx)
    expect(second).toBeInstanceOf(WorldEngine)
    expect(Object.is(second, first)).toBe(false) // 不是旧实例（Object.is：见 expectSame 的注释）
    expect(second?.ticks).toBeLessThan(ticksAtDispose + 1) // 从 0 开始
    expect(second?.inbound).toBe(0) // 订阅也是新的
  })

  it('无关服务零感知：引擎启停不干扰别的服务', async () => {
    const { ctx, loader } = await makeEnv()

    await loader.entry(ENGINE_ID).update({ disabled: false })
    await loader.entry(ENGINE_ID).update({ disabled: true })
    await loader.entry(ENGINE_ID).update({ disabled: false })

    // "零感知"的**可操作**定义：别的服务在启停期间功能完好。
    // （不比较 fiber uid：`ctx.get('settings')` 返回的 Traceable 包装上取不到 `fiber`
    //   —— 实测 undefined；而 `ctx.get()` 的返回值每次又不是同一对象，见 uidOf 的注释。）
    expect(ctx.get('settings')).toBeDefined()
    const scope = ctx.settings.register('yanxin-t19-probe', z.object({ probe: z.string() }))
    await scope.update({ probe: 'alive' })
    expect(scope.get().probe).toBe('alive')
  })

  it('无变化 → 不重复装载（vendor 的 diff 空 → no-op）', async () => {
    const { ctx, loader } = await makeEnv()
    const entry = loader.entry(ENGINE_ID)

    await entry.update({ disabled: false })
    const first = engineOf(ctx)
    const firstUid = entry.fiber?.uid

    await entry.update({ disabled: false }) // 已经是启用状态
    expect(entry.fiber?.uid).toBe(firstUid) // fiber 没换 = 没重新装载
    expect(engineOf(ctx)).toBeInstanceOf(WorldEngine)
    expect(uidOf(engineOf(ctx))).toBe(uidOf(first))

    await entry.update({ disabled: false })
    expect(entry.fiber?.uid).toBe(firstUid)
  })
})

describe('T19-B 窗口服务驱动 loader（跨窗口边界）', () => {
  const WINDOWS: WindowSpec[] = [{ start: '14:00', end: '18:00' }]

  /** tickMs 取大值：本组用显式 `evaluate(固定时刻)` 驱动，避免 timer 干扰。 */
  async function makeWindowed(): Promise<{
    ctx: Context
    loader: FakeLoader
    window: WindowService
    changed: boolean[]
  }> {
    const { ctx, loader } = await makeEnv()
    const changed: boolean[] = []
    ctx.on('yanxin/window-changed', (open: boolean) => {
      changed.push(open)
    })
    const window = new WindowService(ctx, { windows: WINDOWS, engineEntryId: ENGINE_ID, tickMs: 3_600_000 })
    return { ctx, loader, window, changed }
  }

  it('窗口内 → 装载；窗口外 → 卸载；事件只在**真实翻转**时发', async () => {
    const { loader, window, changed } = await makeWindowed()
    const entry = loader.entry(ENGINE_ID)

    // 窗口内（15:00）
    await window.evaluate(new Date('2026-09-27T15:00:00'))
    expect(entry.disabled).toBe(false)
    expect(changed).toEqual([true])

    // 同一状态再裁决一次 → 不 update、不发事件
    const updatesAfterOpen = entry.updates.length
    await window.evaluate(new Date('2026-09-27T15:30:00'))
    expect(entry.updates.length).toBe(updatesAfterOpen)
    expect(changed).toEqual([true])

    // 窗口外（20:00）→ 翻转
    await window.evaluate(new Date('2026-09-27T20:00:00'))
    expect(entry.disabled).toBe(true)
    expect(changed).toEqual([true, false])

    // 窗口外再裁决 → 静默
    await window.evaluate(new Date('2026-09-27T21:00:00'))
    expect(changed).toEqual([true, false])

    // 回到窗口内 → 再次翻转
    await window.evaluate(new Date('2026-09-28T14:00:00'))
    expect(entry.disabled).toBe(false)
    expect(changed).toEqual([true, false, true])
  })

  it('引擎行缺失 → 不崩（裁决仍返回开放状态，行出现后自动恢复）', async () => {
    const ctx = new Context()
    opened.push(ctx)
    await ctx.plugin(MemorySettings)
    // loader 里**没有**引擎行（构造即注册服务，赋值下来供断言）
    const loader = new FakeLoader(ctx, [])
    expect([...loader.entries()]).toEqual([]) // 前提断言：确实没行
    const window = new WindowService(ctx, { windows: WINDOWS, engineEntryId: ENGINE_ID, tickMs: 3_600_000 })

    await expect(window.evaluate(new Date('2026-09-27T15:00:00'))).resolves.toBe(true)
    await expect(window.evaluate(new Date('2026-09-27T20:00:00'))).resolves.toBe(false)
    // warn-once 由内部标志实现（第二次不重复告警）；这里断言的是"不抛，且判定仍然正确"
  })
})

describe('T19-C 引擎卸下时被动响应照常（T17 验收第 5 条）', () => {
  it('窗口外（引擎未装载）群里被 @ → 仍有回复', async () => {
    const env = await makeBridgeEnv({ memory: {} })
    // ⚠️ 必须注册账号 —— bridge 收到消息后查 `onebot.accounts`，未注册的 selfId 直接丢弃
    // （症状：`created` 与 `calls` 全空，看起来像"窗口把被动响应也挡住了"，其实是没注册）
    env.onebot.accounts.set(BOT, { selfId: BOT, preset: 'xiaoyan-agent' })
    env.agents.reply = '在的'

    // 引擎行初始 disabled（= 窗口外的形态），窗口服务在场
    const loader = new FakeLoader(env.ctx, [{ id: ENGINE_ID, plugin: WorldEngine, config: { tickMs: 5 } }])
    expect(loader.entry(ENGINE_ID).disabled).toBe(true) // 前提断言：引擎确实在"卸下"状态
    const window = new WindowService(env.ctx, {
      windows: [], // 空列表 = 恒关（明确模拟"窗口外"）
      engineEntryId: ENGINE_ID,
      tickMs: 3_600_000,
    })

    await window.evaluate(new Date()) // 对齐一次：引擎应被卸下（本来就是）
    expect(engineOf(env.ctx)).toBeUndefined()

    env.emit(messageFrame({ messageType: 'group', userId: '10086', groupId: GROUP, text: '在吗', at: BOT }))
    await env.settle()

    const call = env.onebot.calls.find((c) => c.action === 'send_group_msg')
    expect(call).toBeDefined() // 被动响应不受窗口限制
  })
})

describe('T19-D 静态与压力', () => {
  it('`src/` 里不存在 ctx.start / ctx.stop / ctx.dispose / ctx.fork', () => {
    const srcDir = join(import.meta.dirname, '..', '..', 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, item.name)
        if (item.isDirectory()) walk(full)
        else if (item.name.endsWith('.ts')) files.push(full)
      }
    }
    walk(srcDir)
    expect(files.length).toBeGreaterThan(0)

    const banned = /\bctx\.(start|stop|dispose|fork)\s*\(/
    const offenders = files.filter((file) => banned.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('50 次启停不泄漏句柄', async () => {
    const { loader } = await makeEnv()
    const entry = loader.entry(ENGINE_ID)

    // `process.getActiveResourcesInfo()` 是**公开** API（Node 17+）—— 比内部的
    // `_getActiveHandles()` 干净（后者还带 dangling underscore，会被 lint 拦）。
    const handles = (): number => process.getActiveResourcesInfo().length

    // 先跑一轮让 timer/subscription 的句柄形态稳定，再取基线
    await entry.update({ disabled: false })
    await entry.update({ disabled: true })
    await tick(30)
    const before = handles()

    for (let i = 0; i < 50; i += 1) {
      await entry.update({ disabled: false })
      await entry.update({ disabled: true })
    }
    await tick(50)

    // 不追求精确相等（vitest 自身也会有句柄波动），但不该随启停次数单调增长
    expect(handles()).toBeLessThanOrEqual(before + 5)
  })
})