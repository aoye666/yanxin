/**
 * 世界时钟的验收（T21，spec §6.7）。
 *
 * 三个承诺，每个都要能被反证：
 *
 *   ① **`now()` 是纯函数**：`(现实 - 创世锚点)`，与内存状态无关 ——
 *      崩溃/重启/时钟跳变都不会让"现在几点"出现两套答案。
 *   ② **离线补偿只能取一次**：`consumeOfflineGap()` 一次给出整段，绝不逐 tick 重放。
 *      首次运行返回 `null`（"没有过去，只有一直是这样"，world.md 的初始状态）。
 *   ③ **崩溃时离线起点有界**：落盘的是**检查点**，所以起点最多提前一个 `checkpointMs`
 *      （30 秒），而不是"上次正常退出"那个可能早几小时的位置。
 *
 * 测试用 `vi.useFakeTimers()` 同时接管 `Date.now` 与定时器 —— 时间与心跳一起走，
 * 且不用真等 30 分钟。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOCK_DEFAULTS, CLOCK_FILE, WorldClock } from '../../src/world/clock.ts'

const dirs: string[] = []
const warnings: string[] = []

beforeEach(() => {
  // ⚠️ 只 fake 定时器与 Date，**故意不 fake `setImmediate`** ——
  // 检查点/心跳里有**真实的文件 IO**（写 clock.json），它走 libuv 线程池，
  // fake timers 管不到。`setImmediate` 留给真实事件循环，好让我们能等 IO 落定。
  // （默认全 fake 的话，`advanceTimersByTimeAsync` 会在"落盘还没完成"时就返回，
  //   于是断言读到的是上一个检查点 —— T21 实测踩到过。）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-09-27T14:00:00+08:00'))
})

afterEach(async () => {
  // 先让在飞的落盘完成，再删临时目录 —— 否则 Windows 上会 ENOTEMPTY
  // （删目录的同时还有 write/rename 在途）
  await flushIo()
  vi.useRealTimers()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir === undefined) continue
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // ⚠️ 容忍：检查点是 **fire-and-forget 落盘**，即使 `stop()` 了，已经在飞的 IO
      // 仍可能和删除竞争（Windows 上尤其）。残留的临时目录由系统清理，无害 ——
      // 而让它冒出来会把"清理环节的竞争"伪装成"测试失败"，拦下整个提交（实测发生过）。
    }
  }
  warnings.length = 0
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yanxin-clock-'))
  dirs.push(dir)
  return dir
}

/**
 * 开一个时钟。
 *
 * ⚠️ 这里**显式**给 `tingleEveryUnits`：本文件测的是心跳的**机制**（会不会按时唤醒、
 * lastTick 记不记、stop 之后还响不响），那个节拍默认值是被调的产品参数
 * （`CLOCK_DEFAULTS.tingleEveryUnits`，默认那一条单独测）。两者绑在一起的话，
 * 调一次节拍就要改这一片 `advanceReal(1800_000)`，而它们其实什么都没测到。
 */
function openClock(dir: string, options: Parameters<typeof WorldClock.open>[1] = {}): Promise<WorldClock> {
  return WorldClock.open(dir, { tingleEveryUnits: 1800, warn: (message) => warnings.push(message), ...options })
}

/**
 * 推进现实时间（毫秒）—— 定时器与 `Date.now` 一起走，然后**等真实 IO 落定**。
 *
 * 后半句是关键：检查点会写 `clock.json`（真实文件 IO），不等它完成就读文件，
 * 读到的是上一个检查点的内容（这正是 T21 调试时踩到的坑）。
 */
async function advanceReal(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushIo()
}

/** 让真实事件循环跑几轮（fake timers 不管真实 IO，它是 libuv 线程池的事）。 */
async function flushIo(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('T21 —— now() 是纯函数（时间锚定现实）', () => {
  it('创世时 now() = 0；每过 1 现实秒 +1 TU', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir)

    expect(clock.now()).toBe(0)
    await advanceReal(60_000)
    expect(clock.now()).toBe(60)
    await advanceReal(3_600_000)
    expect(clock.now()).toBe(3600 + 60)
    clock.stop()
  })

  it('⚠️ 重开不重置时间：锚点持久化，now() 连续（进程重启不会让世界回到 T=0）', async () => {
    const dir = await makeDir()
    const first = await openClock(dir)
    await advanceReal(7200_000)
    expect(first.now()).toBe(7200)
    await first.suspend()

    const second = await openClock(dir)
    expect(second.now()).toBe(7200) // 还是 7200，不是 0
    expect(second.genesisMs).toBe(first.genesisMs)
    second.stop()
  })

  it('**崩溃**（不调 suspend）也不重置时间 —— 只有锚点说了算', async () => {
    const dir = await makeDir()
    const first = await openClock(dir, { checkpointMs: 10_000 })
    await advanceReal(5000)
    first.stop() // 直接停：不是 suspend（模拟被 kill）

    await advanceReal(3600_000) // 离线一小时
    const second = await openClock(dir)
    expect(second.now()).toBe(3605) // 3600 + 5
    second.stop()
  })
})

describe('T21 —— 离线补偿（只能取一次）', () => {
  it('首次运行返回 null —— 没有"过去"，只有"一直是这样"', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir)
    expect(clock.consumeOfflineGap()).toBeNull()
    clock.stop()
  })

  it('⭐ 正常退出 → 六小时后重开：一次给出整段（不是逐 tick）', async () => {
    const dir = await makeDir()
    const first = await openClock(dir)
    await advanceReal(120_000) // 跑了 120 秒
    await first.suspend()

    await advanceReal(6 * 3600_000) // 离线 6 小时

    const second = await openClock(dir)
    const gap = second.consumeOfflineGap()

    expect(gap).not.toBeNull()
    expect(gap?.fromTU).toBe(120) // 上次已知存活时刻
    expect(gap?.gapTU).toBe(6 * 3600) // 整段一次给出
    second.stop()
  })

  it('⭐ 只能取一次：第二次调用返回 null（这是"绝不逐 tick 重放"的机制保证）', async () => {
    const dir = await makeDir()
    const first = await openClock(dir)
    await advanceReal(60_000)
    await first.suspend()
    await advanceReal(3600_000)

    const second = await openClock(dir)
    expect(second.consumeOfflineGap()).not.toBeNull()
    expect(second.consumeOfflineGap()).toBeNull() // 第二问无答案
    expect(second.consumeOfflineGap()).toBeNull()
    second.stop()
  })

  it('重新打开但没有离线（立刻重开）→ 区间为 0 → 返回 null（不制造"空了 0 秒"的噪声）', async () => {
    const dir = await makeDir()
    const first = await openClock(dir)
    await first.suspend()

    const second = await openClock(dir)
    expect(second.consumeOfflineGap()).toBeNull()
    second.stop()
  })
})

describe('T21 —— 崩溃时离线起点有界（检查点的意义）', () => {
  it('⭐ 被 kill：离线起点是**最后一个检查点**，不是上次正常退出（最多提前一个间隔）', async () => {
    const dir = await makeDir()
    const first = await openClock(dir, { checkpointMs: 30_000 })

    await advanceReal(60_000) // 活着 60 秒
    await first.checkpoint() // 落一格"最后已知存活"（等价于最后一个定时检查点）
    first.stop() // 被 kill：没有 suspend，只有检查点

    await advanceReal(3600_000) // 离线一小时

    const second = await openClock(dir)
    const gap = second.consumeOfflineGap()

    // 起点是"最后一个检查点"（≈60s），而不是 0（创世）也不是更早 ——
    // 误差被 checkpointMs 限住（这是检查点存在的全部意义）
    expect(gap?.fromTU).toBeGreaterThanOrEqual(60)
    expect(gap?.gapTU).toBeLessThanOrEqual(3600) // 不会把"活着的 60 秒"算成离线的
    second.stop()
  })

  it('定时器确实会周期落盘（spy 证明"调用发生了"；内容正确性由显式 await 的用例保证）', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir, { checkpointMs: 10_000 })
    const spy = vi.spyOn(clock, 'checkpoint')

    await advanceReal(25_000)

    // ⚠️ 只断言**调用次数**，不断言"IO 已完成"—— 检查点是 fire-and-forget 落盘，
    // 它的完成时机取决于 libuv 线程池，赌它会让测试脆弱（T21 实测踩到）。
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
    spy.mockRestore()
    clock.stop()
  })

  it('检查点落盘的内容正确（时间戳与 TU 同步）', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir, { checkpointMs: 10_000 })

    await advanceReal(25_000)
    await clock.checkpoint() // 显式落一次，确保 IO 完成

    const raw = JSON.parse(await readFile(join(dir, CLOCK_FILE), 'utf8')) as {
      accumulatedTU: number
      runningSince: number
    }

    expect(raw.accumulatedTU).toBeGreaterThanOrEqual(25)
    expect(raw.accumulatedTU).toBeLessThanOrEqual(25)
    expect(typeof raw.runningSince).toBe('number')
    clock.stop()
  })
})

describe('T21 —— clock.json 的健壮性', () => {
  it('文件损坏 → 走创世（不崩）；并**不掩盖**——坏文件被覆盖前会留一行 warn', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, CLOCK_FILE), '{这不是 JSON', 'utf8')

    const clock = await openClock(dir)
    expect(clock.now()).toBe(0) // 当作创世
    clock.stop()
    // 落盘后文件是合法 JSON（自愈）
    const raw = JSON.parse(await readFile(join(dir, CLOCK_FILE), 'utf8')) as { genesisMs: number }
    expect(typeof raw.genesisMs).toBe('number')
    // 修复前：这个 catch 是静默的（注释声称"见下面的 warn"，但下面根本没有）——
    // 损坏被无声当首次运行，世界时刻归零、离线补偿丢失而无人知晓
    expect(warnings.some((message) => message.includes('clock.json 读不出'))).toBe(true)
  })

  it('字段不合法（不是 JSON 坏，是形状坏）→ 同样 warn 后走创世', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, CLOCK_FILE), '{"hello":"world"}', 'utf8')

    const clock = await openClock(dir)
    expect(clock.now()).toBe(0)
    clock.stop()
    expect(warnings.some((message) => message.includes('字段不合法'))).toBe(true)
  })

  it('文件不存在（真·首次运行）→ 安静创世，没有吓人的 warn', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir)
    expect(clock.now()).toBe(0)
    clock.stop()
    expect(warnings).toEqual([]) // ENOENT 是正常形态，不是事故
  })

  it('原子落盘：不残留临时文件', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir)
    await advanceReal(60_000)
    await clock.suspend()

    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir)
    expect(files.filter((name) => name.includes('.tmp'))).toEqual([])
  })
})

describe('T21 —— Tingle 心跳', () => {
  it('⭐ 每 1800 TU（30 分钟）唤醒一次；lastTick 被记下', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir)
    const fired: number[] = []
    clock.startTingle((now) => {
      fired.push(now)
    })

    await advanceReal(1800_000)
    expect(fired).toEqual([1800])
    expect(clock.lastTick).toBe(1800)

    await advanceReal(1800_000)
    expect(fired).toEqual([1800, 3600])

    clock.stop()
  })

  it('stop 之后不再触发（timer 随生命周期回滚的机制保证）', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir)
    const fired: number[] = []
    clock.startTingle((now) => {
      fired.push(now)
    })

    await advanceReal(1800_000)
    expect(fired).toHaveLength(1)

    clock.stop()
    await advanceReal(10 * 1800_000)
    expect(fired).toHaveLength(1) // 停了就是停了
  })

  it('间隔可配；`<= 0` 表示显式关闭心跳（不是被兜底成默认值）', async () => {
    const dir = await makeDir()
    // checkpointMs 给大值：这条只关心心跳，别让检查点白白落盘几千次（真实 IO 很慢）
    const clock = await openClock(dir, { tingleEveryUnits: 0, checkpointMs: 3600_000 })
    const fired: number[] = []
    clock.startTingle((now) => {
      fired.push(now)
    })

    await advanceReal(3600_000 * 3) // 三个默认间隔过去
    expect(fired).toEqual([]) // 关掉了：一次都不该有
    clock.stop()
  })

  it('心跳处理慢：不叠加下一拍（递归 setTimeout 而非 setInterval）', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir)
    let running = 0
    let maxConcurrent = 0
    clock.startTingle(async () => {
      running += 1
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((resolve) => setTimeout(resolve, 2000_000)) // 处理要 2000 秒
      running -= 1
    })

    await advanceReal(1800_000 * 3) // 三个间隔过去了
    expect(maxConcurrent).toBe(1) // 从没并发过
    clock.stop()
  })

  it('心跳回调抛错：告警但不中断心跳（下一拍照常）', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir)
    let calls = 0
    clock.startTingle(() => {
      calls += 1
      throw new Error('World-LLM 掉线了')
    })

    await advanceReal(1800_000)
    expect(calls).toBe(1)
    await advanceReal(1800_000)
    expect(calls).toBe(2) // 没被打断
    expect(warnings.some((message) => message.includes('Tingle 处理失败'))).toBe(true)
    clock.stop()
  })

  it('默认节拍就是 30 TU（= 30 秒）—— 稀疏化靠她自己发 wait，不靠调这个数', async () => {
    const dir = await makeDir()
    // ⚠️ 刻意**不**走 `openClock`：那个助手为了机制测试显式传了 1800，
    //    而这一条测的就是"不传时是多少"。
    const clock = await WorldClock.open(dir, { warn: (message) => warnings.push(message) })
    expect(clock.tingleEveryUnits).toBe(CLOCK_DEFAULTS.tingleEveryUnits)
    expect(CLOCK_DEFAULTS.tingleEveryUnits).toBe(30)
    clock.stop()
  })

  it('⭐ 停止时在飞的一拍跑完后**不再重排**：窗口关闭后心跳不得复活（不得再改 lastTick/落盘）', async () => {
    const dir = await makeDir()
    const clock = await openClock(dir)
    const fired: number[] = []
    clock.startTingle(async (now) => {
      fired.push(now)
      // 一拍要跑很久（watch + turn + LLM）：窗口关闭与在飞心跳重叠是常态
      await new Promise((resolve) => setTimeout(resolve, 2000_000))
    })

    await advanceReal(1800_000) // 第一拍触发，回调挂起中
    expect(fired).toEqual([1800])

    clock.stop() // 窗口关闭（18:00 与在飞心跳重叠）
    // 让在飞回调跑完，再空过一个完整间隔
    await advanceReal(2000_000 + 1800_000)
    // 修复前：finally 无条件重排 → 第二拍照常触发，"已停"的时钟每 30 分钟醒来写盘
    expect(fired).toEqual([1800])
  })
})