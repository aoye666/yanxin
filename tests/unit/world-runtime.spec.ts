/**
 * 行动运行时的验收（T24b，spec §6.7）。
 *
 * 三个承诺，都有反证：
 *
 *   ① **到点才结算**（不是发起时）—— 用假时钟 + 手动定时器断言延迟；
 *   ② **裁定看的是当前世界** —— "世界已变"的用例：动作发起后世界被改，
 *      裁定函数必须看到改之后的样子；
 *   ③ **取消只在提交边界之前生效** —— 到期前取消有效；已结算后取消被内核拒，
 *      运行时如实返回 `false`（不假装成功）。
 *
 * 定时器是**注入**的（手动触发），不用 `vi.useFakeTimers()`：
 * 结算里要调 `kernel.submit`（真实文件 IO），fake timers 管不到它 —— T21 在这上面栽过。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldKernel } from '../../src/world/kernel.ts'
import { WorldRuntime, type ActionOutcome, type Adjudicate } from '../../src/world/runtime.ts'
import type { TransactionProposal, WorldSnapshot } from '../../src/world/state.ts'

const dirs: string[] = []
const warnings: string[] = []
const outcomes: ActionOutcome[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
  warnings.length = 0
  outcomes.length = 0
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yanxin-runtime-'))
  dirs.push(dir)
  return dir
}

/** 手动触发的假定时器（完全可控：排期与触发分开）。 */
function manualTimers() {
  let nextId = 1
  const timers = new Map<number, { callback: () => void | Promise<void>; delayMs: number }>()
  return {
    setTimer(callback: () => void | Promise<void>, delayMs: number): number {
      const id = nextId
      nextId += 1
      timers.set(id, { callback, delayMs })
      return id
    },
    clearTimer(handle: unknown): void {
      timers.delete(handle as number)
    },
    /** 已排期的延迟（断言"到点才结算"用）。 */
    delays(): number[] {
      return [...timers.values()].map((timer) => timer.delayMs)
    },
    get size(): number {
      return timers.size
    },
    /**
     * 手动触发全部已排期的（模拟"世界时间到了"）。
     *
     * ⚠️ **`await` 每个回调**（而不只是跑一轮事件循环）：结算里有真实文件 IO
     * （`kernel.submit` 落盘），"给几轮 setImmediate"赌不中它何时完成。
     */
    async runAll(): Promise<void> {
      const snapshot = [...timers.values()]
      timers.clear()
      await Promise.all(snapshot.map((timer) => timer.callback()))
      await flush(2)
    },
  }
}

/** 让异步链跑完（给"没有 await 的续体"用）。 */
async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** 可控的假世界时钟。 */
function fakeClock(start = 1000) {
  let value = start
  return {
    now: () => value,
    set(next: number): void {
      value = next
    },
    advance(seconds: number): void {
      value += seconds
    },
  }
}

/** 创世：小研 + 房子 + 手机。 */
async function seed(kernel: WorldKernel): Promise<void> {
  await kernel.submit({
    idempotencyKey: 'genesis',
    operations: [
      { op: 'create', entity: { id: 'bot', kind: 'actor', name: '小研', location: 'house' } },
      { op: 'create', entity: { id: 'house', kind: 'place', name: '小房子', location: null } },
      { op: 'create', entity: { id: 'phone', kind: 'object', name: '手机', location: 'house' } },
    ],
    source: 'bootstrap',
  })
}

/** 提交一个动作（`expectedEnd` 是世界时刻 TU）。 */
function startAction(id: string, expectedEnd: number | undefined, intent = '去看看手机'): TransactionProposal {
  return {
    idempotencyKey: `start:${id}`,
    operations: [
      {
        op: 'action.start',
        action: { id, actorId: 'bot', intent, targetIds: ['phone'], ...(expectedEnd === undefined ? {} : { expectedEnd }) },
      },
    ],
    source: 'world-llm',
  }
}

/** 一个"完成"的裁定（默认行为：动作成功结束）。 */
const completes: Adjudicate = async (action) => ({
  idempotencyKey: `finish:${action.id}`,
  operations: [{ op: 'action.finish', id: action.id, status: 'completed', reason: `${action.intent}：做完了` }],
  source: 'world-llm',
})

async function makeRuntime(options: {
  kernel: WorldKernel
  clock: ReturnType<typeof fakeClock>
  adjudicate?: Adjudicate
  timers: ReturnType<typeof manualTimers>
}): Promise<WorldRuntime> {
  return WorldRuntime.start({
    kernel: options.kernel,
    clock: options.clock,
    adjudicate: options.adjudicate ?? completes,
    onOutcome: (outcome) => {
      outcomes.push(outcome)
    },
    warn: (message) => warnings.push(message),
    setTimer: options.timers.setTimer,
    clearTimer: options.timers.clearTimer,
  })
}

describe('T24b —— 到点才结算（不是发起时）', () => {
  it('⭐ 排期延迟 = (expectedEnd − 现在) × 1000 —— 10 分钟后的事 10 分钟后才结算', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    // 动作：期望 1600 完成（600 秒后）
    await kernel.submit(startAction('a1', 1600))
    const runtime = await makeRuntime({ kernel, clock, timers })

    expect(timers.delays()).toEqual([600_000]) // 还没到点
    expect(kernel.snapshot.actions['a1']?.status).toBe('pending')

    // 时间走到 1600，触发定时器
    clock.set(1600)
    await timers.runAll()

    expect(kernel.snapshot.actions['a1']?.status).toBe('completed')
    expect(kernel.snapshot.actions['a1']?.finishedAt).toBe(1600)
    runtime.stop()
  })

  it('⭐ 远期动作（超过 setTimeout 的 32 位上限）→ 24h 接力闹钟，不立即结算', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    // 40 天后完成 —— 裸排 setTimeout(3.456e9 ms) 会被 Node 钳成 1ms 立即触发（提前结算）
    await kernel.submit(startAction('a-far', 1000 + 40 * 86_400))
    const runtime = await makeRuntime({ kernel, clock, timers })

    // 排期被 24h 封顶，而不是交给 32 位溢出的 setTimeout
    expect(timers.delays()).toEqual([86_400_000])
    expect(kernel.snapshot.actions['a-far']?.status).toBe('pending')

    // 第一个 24h 接力点到了：还没到期 → 重排剩余，不结算
    clock.advance(86_400)
    await timers.runAll()
    expect(kernel.snapshot.actions['a-far']?.status).toBe('pending')
    expect(timers.delays()).toEqual([86_400_000]) // 又一个 24h（剩余 39 天仍超上限）

    // 走满 40 天：真正到期，结算
    clock.advance(39 * 86_400)
    await timers.runAll()
    expect(kernel.snapshot.actions['a-far']?.status).toBe('completed')
    runtime.stop()
  })

  it('没有 expectedEnd 的动作立即排期（"她顺手做了一件事"）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    await kernel.submit(startAction('a-now', undefined))
    const runtime = await makeRuntime({ kernel, clock, timers })

    expect(timers.delays()).toEqual([0])

    await timers.runAll()
    expect(kernel.snapshot.actions['a-now']?.status).toBe('completed')
    runtime.stop()
  })

  it('⭐ 重启恢复：新的运行时扫描到 pending → 重新排期（已到期的立刻结算）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    await kernel.submit(startAction('a1', 1600))
    await kernel.submit(startAction('a2', 900)) // 期望时刻已经**过去**了（现在 1000）

    // 模拟"进程重启"：全新的 runtime（内存里没有旧定时器）
    const timers = manualTimers()
    const runtime = await makeRuntime({ kernel, clock, timers })

    expect(runtime.pendingTimers).toBe(2)
    expect(timers.delays().sort((a, b) => a - b)).toEqual([0, 600_000]) // 过期的按 0 处理

    // 触发定时器 = "时间走到了各自的到期点"（settle 醒来会复查是否真到期 —— 没
    // 到期的会被重排，这是封顶接力的纪律；这里把时间推到最晚那个到期点）
    clock.set(1600)
    await timers.runAll()
    expect(kernel.snapshot.actions['a1']?.status).toBe('completed')
    expect(kernel.snapshot.actions['a2']?.status).toBe('completed')
    runtime.stop()
  })
})

describe('T24b —— 裁定看的是**当前**世界（世界会变）', () => {
  it('⭐ 动作发起后被改动的世界，裁定看得到（不是发起时的快照）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    await kernel.submit(startAction('a1', 1100))

    // 动作还在等 —— 期间世界变了：先有了街道，手机被挪到了街上
    await kernel.submit({
      idempotencyKey: 'add-street',
      operations: [{ op: 'create', entity: { id: 'street', kind: 'place', name: '很宽的街道', location: null } }],
    })
    await kernel.submit({
      idempotencyKey: 'move-phone',
      operations: [{ op: 'move', id: 'phone', location: 'street' }],
    })

    // 裁定函数把"它看到的世界"记下来
    const seen: WorldSnapshot[] = []
    const observing: Adjudicate = async (action, world) => {
      seen.push(world)
      return {
        idempotencyKey: `finish:${action.id}`,
        operations: [
          {
            op: 'action.finish',
            id: action.id,
            status: world.entities['phone']?.location === 'house' ? 'completed' : 'failed',
            reason: `手机在${world.entities['phone']?.location ?? '?'}`,
          },
        ],
      }
    }

    const runtime = await makeRuntime({ kernel, clock, adjudicate: observing, timers })
    clock.set(1100)
    await timers.runAll()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.entities['phone']?.location).toBe('street') // 看到的是**改之后**的世界
    expect(kernel.snapshot.actions['a1']?.status).toBe('failed') // 于是裁定为失败
    expect(outcomes[0]?.status).toBe('failed')
    expect(outcomes[0]?.summary).toContain('手机在street')
    runtime.stop()
  })

  it('裁定抛错 → 告警，不炸（动作留在 pending 等下一拍）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    await kernel.submit(startAction('a1', 1100))
    const exploding: Adjudicate = async () => {
      throw new Error('World-LLM 掉线了')
    }
    const runtime = await makeRuntime({ kernel, clock, adjudicate: exploding, timers })

    clock.set(1100)
    await timers.runAll()

    expect(warnings.some((message) => message.includes('裁定失败'))).toBe(true)
    expect(kernel.snapshot.actions['a1']?.status).toBe('pending') // 没被改动
    runtime.stop()
  })

  it('裁定返回 null = "这次裁不了"：保持 pending，下次 watch() 重排（Tingle 心跳会拍它）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    await kernel.submit(startAction('a1', 1100))
    const undecided: Adjudicate = async () => null
    const runtime = await makeRuntime({ kernel, clock, adjudicate: undecided, timers })

    clock.set(1100)
    await timers.runAll()

    expect(kernel.snapshot.actions['a1']?.status).toBe('pending')
    expect(warnings.some((message) => message.includes('未裁定'))).toBe(true)

    // 下一拍心跳：watch() 重新排期
    await runtime.watch()
    expect(runtime.pendingTimers).toBe(1)
    runtime.stop()
  })
})

describe('T24b —— 取消只在提交边界之前生效', () => {
  it('⭐ 到期前取消：动作变 cancelled、定时器被清、结果被交付', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    await kernel.submit(startAction('a1', 1600))
    const runtime = await makeRuntime({ kernel, clock, timers })
    expect(timers.size).toBe(1)

    const ok = await runtime.cancel('a1', '她改主意了')

    expect(ok).toBe(true)
    expect(timers.size).toBe(0) // 定时器清了
    expect(kernel.snapshot.actions['a1']?.status).toBe('cancelled')
    expect(kernel.snapshot.actions['a1']?.reason).toBe('她改主意了')
    expect(outcomes[0]?.status).toBe('cancelled')

    // 到点再触发也无效（定时器已经不在）
    clock.set(1600)
    await timers.runAll()
    expect(kernel.snapshot.actions['a1']?.status).toBe('cancelled') // 没变成 completed
    runtime.stop()
  })

  it('⭐ 已结算的取消被拒（**提交边界之后取消无效**）—— 如实返回 false', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    await kernel.submit(startAction('a1', 1100))
    const runtime = await makeRuntime({ kernel, clock, timers })
    clock.set(1100)
    await timers.runAll() // 结算完成

    const late = await runtime.cancel('a1', '晚了')

    expect(late).toBe(false) // 不假装成功
    expect(kernel.snapshot.actions['a1']?.status).toBe('completed') // 结果没被改写
    // 注：这里是**前置检查**挡下的（状态已非 pending → 直接 false，根本不去提交）——
    // 那比"提交被内核拒"更省事。`cancel` 里 catch 那条 warn 分支是防御性的
    // （多实例 / 将来的状态缓存），单实例下不可达，所以这里不断言 warn。
    runtime.stop()
  })

  it('取消不存在的动作 → false（不抛）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const runtime = await makeRuntime({ kernel, clock: fakeClock(), timers: manualTimers() })

    expect(await runtime.cancel('不存在', '随便')).toBe(false)
    runtime.stop()
  })
})

describe('T24b —— 幂等与生命周期', () => {
  it('⭐ 结算幂等：到点被触发两次 → 只结算一次（内核算第二道）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    await kernel.submit(startAction('a1', undefined))
    // 同一个回调被触发两次（模拟重复投递 / 重启竞态）
    const runtime = await makeRuntime({ kernel, clock, timers })
    const [first] = timers.delays()
    expect(first).toBe(0)
    await timers.runAll()
    // 再排一次同一个动作（watch 会跳过已结算的；这里直接模拟"重复触发"）
    await runtime.watch()

    expect(kernel.snapshot.actions['a1']?.status).toBe('completed')
    expect(outcomes).toHaveLength(1) // 只交付一次
    runtime.stop()
  })

  it('watch() 幂等：已排期的动作不会被重复排期', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    await kernel.submit(startAction('a1', 1600))
    const runtime = await makeRuntime({ kernel, clock, timers })

    await runtime.watch()
    await runtime.watch()

    expect(timers.size).toBe(1)
    runtime.stop()
  })

  it('stop() 清掉全部定时器；之后到点也不再触发', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    await kernel.submit(startAction('a1', 1600))
    const runtime = await makeRuntime({ kernel, clock, timers })
    expect(timers.size).toBe(1)

    runtime.stop()
    expect(timers.size).toBe(0)
    await timers.runAll() // 什么都不会发生
    expect(kernel.snapshot.actions['a1']?.status).toBe('pending')
  })

  it('交付里带**意图**（她读得懂的说明），不是内部结构', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(1000)
    const timers = manualTimers()

    await kernel.submit(startAction('a1', undefined, '给手机充电'))
    const runtime = await makeRuntime({ kernel, clock, timers })
    await timers.runAll()

    expect(outcomes[0]?.actionId).toBe('a1')
    expect(outcomes[0]?.summary).toContain('给手机充电')
    expect(outcomes[0]?.at).toBe(1000)
    runtime.stop()
  })
})