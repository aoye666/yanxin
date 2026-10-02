/**
 * 世界时钟 —— TU 推进 + Tingle 心跳 + **离线补偿**（T21，spec §6.7）。
 *
 * ## 时钟模型：同步模式（`syncRealTime`）
 *
 * **`1 TU = 1 现实秒`，世界时间就是现实时间**，`now()` 是一个纯函数：
 *
 *     now() = (现实毫秒 - 创世锚点) / 1000
 *
 * 所以时间**不需要"推进"** —— 它自己走。这也是为什么本文件不做 `advance()`
 * （想跳跃时间就是换模式，不是加一个数字）；她没有"睡一觉跳到明天"，只有 `wait`。
 *
 * ## 那 `accumulatedTU` / `runningSince` 是干什么的
 *
 * 它们**不是**时间的来源，是**"上次已知还活着"的检查点**：
 * 每 `checkpointMs`（默认 30s）落盘一次"当时的世界时间 + 现实时刻"。作用只有一个 ——
 * **崩溃时给离线补偿一个（有界的）起点**。
 *
 * 没有它的话：进程被 kill 时落盘的还是上次正常退出的时刻，离线区间会从**更早**算起。
 * 有了它：离线起点最多**提前一个检查点间隔**（30 秒）。代价 30 秒、收益是"补偿区间不会
 * 因为一次断电而多出几个小时"。参照框架的做法一致（它的 `CHECKPOINT_MS` 也是 30s）。
 *
 * ## 离线补偿（本文件最重要的语义）
 *
 * `consumeOfflineGap()` —— **只能取一次**。返回 `{ fromTU, gapTU }`：上次已知存活时刻
 * 到现在隔了多久（世界时间）。拿到之后必须**一次性处理**（叙述一次"这段时间过去了"），
 * 绝不逐 tick 重放 —— 否则一次调用要经历二十小时的世界演化（spec §6.7 的原话）：
 * 额度爆炸、叙事崩坏。
 *
 * ⚠️ 首次运行（还没有 `clock.json`）时它返回 `null`：**没有"过去"，只有"一直是这样"**
 * （world.md 的初始状态就是这么写的）。
 *
 * ## 刻意不做
 *
 *   · **世界历法**（参照框架有：TU ↔ 世界年月日的确定性换算）—— 她的世界与现实同步，
 *     现实日期就是世界日期，没有第二套日历要维护
 *   · **暂停/冻结**（`pause`）—— 同步模式下时间无法冻结；窗口关闭时世界时间照常流逝，
 *     这正是"离线补偿"要处理的事
 *   · **Tingle auto 模式**（世界自己决定下次心跳间隔）—— 固定间隔够用（spec §6.7）
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { describeError as describe } from '../describe.ts'
import { dirname, join } from 'node:path'

/** 时钟文件名（在世界目录里）。 */
export const CLOCK_FILE = 'clock.json'

/** 同步模式固定换算：1 TU = 1 现实秒（spec §6.7）。 */
export const SECONDS_PER_UNIT = 1

export const CLOCK_DEFAULTS = {
  /**
   * Tingle 心跳间隔：**30 TU = 30 秒**。
   *
   * 这是"她没事时被唤起一次"的默认频率，不是"她每分钟想做多少事"。真正的稀疏化靠
   * 她自己发 `wait` / `rest`（下限 600 TU = 10 分钟，见 `tools.ts` 的 `MIN_IDLE_UNITS`），
   * 而群里来消息会把她从等待里叫醒（`engine.ts` 的 inbound）。
   *
   * ⚠️ 也就是说：**这个默认值只在"她不发 wait"时才真的被花满**。她要是每一拍都发
   * wait/rest，有效频率会自己降到 10 分钟一次；她要是一拍都不发（工具空转，见缺陷表
   * D6），4 小时窗口就是 480 拍。调这个数之前要先知道这条依赖。
   *
   * ⚠️ 一拍可能跑 19~27 秒（World-LLM），所以重叠保护是真的会用到的：
   * `fireTingle` 里"上一拍没跑完就跳过这一拍"（宁可少一次，不叠）。
   */
  tingleEveryUnits: 30,
  /** 检查点间隔（现实 ms）—— 决定"崩溃时离线起点最多提前多少"。 */
  checkpointMs: 30_000,
} as const

/** 落盘的状态（`clock.json` 的全部字段）。 */
export interface ClockCheckpoint {
  /** 上次落盘时的世界时间（TU）。 */
  accumulatedTU: number
  /** 上次落盘时的现实时刻（ms）；`null` = 从未落过（不该出现，留作兼容）。 */
  runningSince: number | null
  /** T=0 对应的现实时刻（ms）——**时间的真正来源**。 */
  genesisMs: number
  /** 上次 Tingle 的世界时刻（TU）。 */
  lastTick: number
}

export interface ClockOptions {
  /** Tingle 间隔（TU）；`<= 0` 表示不启动心跳。 */
  tingleEveryUnits?: number
  /** 检查点间隔（现实 ms）。 */
  checkpointMs?: number
  /** 现实时钟（测试注入假时钟用）。 */
  now?: () => number
  /** 落盘失败的告警去处（默认 `console.warn`）。 */
  warn?: (message: string) => void
}

/** 一次离线区间 —— `consumeOfflineGap()` 的返回值。 */
export interface OfflineGap {
  /** 上次已知存活时刻的世界时间（TU）。 */
  fromTU: number
  /** 到现在隔了多久（TU）。 */
  gapTU: number
}

/**
 * 世界时钟。
 *
 * 用 `WorldClock.open(dir)` 建立；`stop()` 清理全部计时器（装配层应把它绑在
 * `ctx.effect` 里，见 T19 的纪律：timer 必须随 fiber 回滚）。
 */
export class WorldClock {
  private state: ClockCheckpoint
  /** 离线起点（load 时若上次退出时世界在运行则记下）——**只能取一次**。 */
  private offlineFromTU: number | null = null
  /**
   * 落盘的**串行队列**。
   *
   * 为什么需要：检查点是 fire-and-forget（定时器里 `void checkpoint()`），而
   * `suspend()` 要在退出前写一个"精确到最后"的值。两者会交错 —— 一个**迟到的检查点**
   * 可能后 rename，把 suspend 写的值覆盖掉（T21 实测：正常退出后离线起点退回上一个检查点）。
   * 串行化后，"最后入队的"一定最后完成，而 suspend 保证自己是最后一个 ✅
   */
  private saveQueue: Promise<void> = Promise.resolve()
  private checkpointTimer: ReturnType<typeof setInterval> | null = null
  private tingleTimer: ReturnType<typeof setTimeout> | null = null
  private tingleFiring = false
  /** 心跳是否处于"启动"状态 —— `stopTingle()` 置否，`fireTingle` 的 finally 据此决定要不要重排。 */
  private tingleOn = false
  private readonly options: Required<Pick<ClockOptions, 'tingleEveryUnits' | 'checkpointMs' | 'now' | 'warn'>>
  private readonly file: string

  private constructor(
    dir: string,
    options: ClockOptions,
    state: ClockCheckpoint,
  ) {
    this.file = join(dir, CLOCK_FILE)
    this.state = state
    this.options = {
      // ⚠️ `tingleEveryUnits` **允许 <= 0**（那是"不要心跳"的显式写法）—— 不能被归一成默认，
      // 否则关不掉心跳。只有"没给"和"给了个坏值"才回退默认。
      tingleEveryUnits:
        typeof options.tingleEveryUnits === 'number' && Number.isFinite(options.tingleEveryUnits)
          ? options.tingleEveryUnits
          : CLOCK_DEFAULTS.tingleEveryUnits,
      checkpointMs: normalizePositive(options.checkpointMs, CLOCK_DEFAULTS.checkpointMs),
      now: options.now ?? (() => Date.now()),
      warn: options.warn ?? ((message) => console.warn(message)),
    }
  }

  /**
   * 打开时钟：读 `clock.json`；不存在则**创世**（T=0 锚定此刻）。
   *
   * 打开后会启动检查点计时器（时间在走，就该定期落盘）。
   */
  static async open(dir: string, options: ClockOptions = {}): Promise<WorldClock> {
    await mkdir(dirname(join(dir, CLOCK_FILE)), { recursive: true })

    const warn = options.warn ?? ((message: string) => console.warn(message))
    let persisted: ClockCheckpoint | undefined
    try {
      const text = await readFile(join(dir, CLOCK_FILE), 'utf8')
      const raw = JSON.parse(text) as Partial<ClockCheckpoint>
      if (typeof raw.genesisMs === 'number' && typeof raw.accumulatedTU === 'number') {
        persisted = {
          accumulatedTU: raw.accumulatedTU,
          runningSince: raw.runningSince ?? null,
          genesisMs: raw.genesisMs,
          lastTick: typeof raw.lastTick === 'number' ? raw.lastTick : 0,
        }
      } else {
        warn(
          `[world-clock] clock.json 在但字段不合法，按首次创世处理（世界时刻归零、离线补偿丢失；` +
            `该文件将被重写覆盖，要留证据先备份）：${JSON.stringify(raw).slice(0, 200)}`,
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // 首次运行：走创世。
      } else {
        // 文件在但读不了（EACCES 等）或 JSON 坏：如实 warn，仍走创世（自愈覆盖）。
        warn(
          `[world-clock] clock.json 读不出，按首次创世处理（世界时刻归零、离线补偿丢失；` +
            `该文件将被重写覆盖，要留证据先备份）：${describe(error)}`,
        )
      }
    }

    const realNow = (options.now ?? (() => Date.now()))()
    const state: ClockCheckpoint = persisted ?? {
      accumulatedTU: 0,
      runningSince: realNow,
      genesisMs: realNow,
      lastTick: 0,
    }

    const clock = new WorldClock(dir, options, state)

    // ⚠️ **创世要立刻落盘**：否则进程在第一次检查点（默认 30s）之前崩溃，
    // `clock.json` 根本不存在 → 下次打开会**重新创世**，世界时间归零。
    // 这不是理论风险：T21 的测试里"崩溃（不调 suspend）也不重置时间"一条就撞上了它。
    if (persisted === undefined) await clock.enqueueSave()

    // 上次退出时世界在运行 → 记下离线起点。
    // （`now()` 会靠持久化的 genesisMs 自动把离线区间算进去；这里只是**告诉调用方**隔了多久）
    if (persisted !== undefined && persisted.runningSince !== null) {
      clock.offlineFromTU = persisted.accumulatedTU
    }

    clock.startCheckpoints()
    return clock
  }

  /** 创世锚点（T=0 对应的现实 ms）。 */
  get genesisMs(): number {
    return this.state.genesisMs
  }

  /** 上次 Tingle 的世界时刻（TU）。 */
  get lastTick(): number {
    return this.state.lastTick
  }

  /** 当前 Tingle 间隔（TU）。 */
  get tingleEveryUnits(): number {
    return this.options.tingleEveryUnits
  }

  /**
   * 当前世界时刻（TU，整数秒）。
   *
   * **纯函数**：`(现实 - 创世锚点)`。不依赖任何内存状态 ——
   * 所以进程重启、崩溃、时钟跳变都不会让"现在几点"出现两套答案（只有一个锚点）。
   */
  now(): number {
    const elapsedMs = this.options.now() - this.state.genesisMs
    return Math.floor(elapsedMs / 1000 / SECONDS_PER_UNIT)
  }

  /**
   * 取出「上次已知存活 → 现在」的离线区间（**只能取一次**，第二次返回 `null`）。
   *
   * 拿到后必须**一次性处理**：叙述一句"这段时间过去了"，或按需要生成一条补偿事务 ——
   * **绝不逐 tick 重放**（那是额度与叙事的双重灾难，spec §6.7）。
   */
  consumeOfflineGap(): OfflineGap | null {
    if (this.offlineFromTU === null) return null
    const fromTU = this.offlineFromTU
    this.offlineFromTU = null
    const gapTU = this.now() - fromTU
    return gapTU > 0 ? { fromTU, gapTU } : null
  }

  /** 立刻落一次检查点（把"此刻还活着"记下来）。 */
  async checkpoint(): Promise<void> {
    this.state.accumulatedTU = this.now()
    this.state.runningSince = this.options.now()
    await this.enqueueSave()
  }

  /**
   * 进程退出前调用：最后一次落盘。
   *
   * ⚠️ 与"崩溃"的区别：崩溃时落盘的是**上一个检查点**（离线起点最多提前 `checkpointMs`），
   * 正常退出则精确到此刻。两种情况的行为都不需要调用方特判 —— 补偿区间照样算得出来。
   *
   * ⚠️ 顺序：先 `stop()`（不再产生新的检查点）→ **等在飞的落盘排空** → 再写最终值。
   * 少了"等排空"这一步，一个迟到的检查点会覆盖这次的精确落盘（实测踩过）。
   */
  async suspend(): Promise<void> {
    this.stop()
    await this.saveQueue
    await this.checkpoint()
  }

  /**
   * 启动 Tingle 心跳：每 `tingleEveryUnits`（默认 30 TU = 30 秒）唤醒一次。
   *
   * 用**递归 setTimeout**（而不是 setInterval）：一次心跳的处理可能很慢（要调 World-LLM），
   * setInterval 会在它没跑完时再叠一次；递归则在"这次结束之后"才排下一次。
   */
  startTingle(onFire: (now: number) => void | Promise<void>): void {
    this.stopTingle()
    if (this.options.tingleEveryUnits <= 0) return // 显式关闭心跳（<=0 是"不要心跳"的写法）
    this.tingleOn = true
    this.scheduleTingle(onFire)
  }

  /** 停掉心跳（不影响检查点）。 */
  stopTingle(): void {
    this.tingleOn = false
    if (this.tingleTimer !== null) {
      clearTimeout(this.tingleTimer)
      this.tingleTimer = null
    }
  }

  /** 停掉全部计时器（检查点 + 心跳）。装配层应在 `ctx.effect` 的清理里调用。 */
  stop(): void {
    this.stopTingle()
    if (this.checkpointTimer !== null) {
      clearInterval(this.checkpointTimer)
      this.checkpointTimer = null
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private scheduleTingle(onFire: (now: number) => void | Promise<void>): void {
    const delayMs = this.options.tingleEveryUnits * SECONDS_PER_UNIT * 1000
    this.tingleTimer = setTimeout(() => {
      void this.fireTingle(onFire)
    }, delayMs)
    // 不阻止进程退出（否则测试与关闭流程会被一个心跳吊住）
    this.tingleTimer.unref?.()
  }

  private async fireTingle(onFire: (now: number) => void | Promise<void>): Promise<void> {
    if (this.tingleFiring) return // 上一次还没跑完：跳过这一拍（宁可少一次，不叠）
    this.tingleFiring = true
    try {
      const now = this.now()
      // 先记下"心跳发生过"，再交给调用方 —— 它可能很慢甚至失败，
      // 而 lastTick 是"世界已经感知到这一拍"的事实，不该被一次失败抹掉。
      //
      // ⚠️ **落盘不 await**：`lastTick` 只是元数据（时间本身由创世锚点算，不依赖它），
      // 让一次磁盘写入拖住心跳没有意义 —— 回调可能要调 World-LLM，那才是正事。
      this.state.lastTick = now
      void this.enqueueSave().catch((error: unknown) => {
        this.options.warn(`[world-clock] lastTick 落盘失败：${describe(error)}`)
      })
      await onFire(now)
    } catch (error) {
      this.options.warn(`[world-clock] Tingle 处理失败：${describe(error)}`)
    } finally {
      this.tingleFiring = false
      // ⚠️ 只在心跳仍处于"启动"状态时重排：`await onFire(...)` 可能跑几分钟
      // （一拍 = watch + turn + LLM），期间窗口关闭调了 `stop()` —— 无条件重排会让
      // "已停"的时钟每拍醒来改 lastTick 并落盘，直到进程退出。
      if (this.tingleOn) this.scheduleTingle(onFire)
    }
  }

  private startCheckpoints(): void {
    this.checkpointTimer = setInterval(() => {
      void this.checkpoint().catch((error: unknown) => {
        this.options.warn(`[world-clock] 检查点落盘失败：${describe(error)}`)
      })
    }, this.options.checkpointMs)
    this.checkpointTimer.unref?.()
  }

  /** 原子落盘（入队）：临时文件 + rename（半个 `clock.json` 会让世界时间归零）。 */
  private enqueueSave(): Promise<void> {
    const run = this.saveQueue.then(() => this.saveNow())
    this.saveQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async saveNow(): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(this.state, null, 2), { flag: 'wx' })
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

/** 坏值兜底：非数字 / NaN / 非正 → 默认（只用于"必须为正"的间隔）。 */
function normalizePositive(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  return fallback
}
