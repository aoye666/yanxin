/**
 * 窗口服务（`ctx.window`）—— spec §6.6 的时间窗基础设施。
 *
 * ## 它做什么
 *
 * 每分钟（可配）裁决一次"现在是否在开放窗口内"，然后把 **World 引擎的 loader 行**
 * （默认 `yanxin-world-engine`）启停到对应状态：
 *
 * ```
 *   窗口判定（纯逻辑 logic.ts）
 *        │  open / closed
 *        ▼
 *   WindowService（本文件）        ← root 级常驻；settings 可改时段
 *        │  entry.update({ disabled: !open })   增量 reconcile，不重启进程
 *        ▼
 *   World 引擎行（Phase 5 填实）    ← 窗口外被 dispose：主动行为归零
 * ```
 *
 * ## 三条设计约束（都不是随便定的）
 *
 * ① **本服务必须 root 级常驻**（spec §6.6）：它启停的是引擎**行**，自己不能被
 *    同一个开关关掉 —— 否则"窗口关了 → 调度器也没了 → 永远醒不来"。
 * ② **只约束主动行为**（2026-09-26 修正）：被 @ 的被动响应走 bridge、不经过引擎，
 *    因此不受窗口影响。窗口管"自主运转"，不管"存在感"。
 * ③ **fail-safe 方向是"不开放"**：时段非法或为空 → 判关闭；引擎行找不到 →
 *    跳过裁决并告警（patch 里引擎行默认 `disabled: true`，天然停在安全侧）。
 *
 * ## 为什么不用 `@deepseek-ai/dsh-schedule`
 *
 * 它是 session-local、最小 5 分钟固定间隔、无日历规则（spec §2 已核）。vendored
 * cordis 也没有 timer 服务，所以用裸 `setInterval` + `ctx.effect` 绑生命周期 ——
 * 与 `onebot/service.ts` 的存活检测完全同构。
 *
 * ⚠️ 装配纪律：只用 `export default`（ADR 0004）；实例字段用 TS `private`（ADR 0007）。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { allowWorld } from '../setup/guard.ts'
import { describeError as describe } from '../describe.ts'
import { normalizeWindows, withinAnyWindow, type WindowSpec } from './logic.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    window: WindowService
  }
  interface Events {
    /**
     * 主动行为窗口**真的翻转**时发出（参数 = 现在是否开放）。
     *
     * 只在 `update` 成功执行后发：状态本来就一致不算变化（装载期首次对齐、
     * 同状态的重复裁决都不会触发）。订阅者：控制台状态页、审计。
     */
    'yanxin/window-changed'(open: boolean): void
  }
}

/**
 * settings 命名空间。
 *
 * ⚠️ 形式受 `SettingsNamespaceInput` 约束：只允许小写字母、数字、连字符（ADR 0007）。
 */
const NAMESPACE = 'yanxin-window'

/**
 * 默认配置（三级回退的最后一层）。
 *
 * ⚠️ 与 `memory/service.ts` 同一个理由：**schema 刻意不写 `.default()`** ——
 * 写了的话 settings 文档里永远有值，行 config 会被静默忽略。默认只放这一处常量。
 */
export const WINDOW_DEFAULTS = {
  /** 默认窗口：每天 14:00–18:00（下午 4 小时，spec §6.6）。 */
  windows: [{ start: '14:00', end: '18:00' }],
  /** World 引擎的 loader 行 id。 */
  engineEntryId: 'yanxin-world-engine',
  /** 裁决间隔：1 分钟（判定粒度本就是分钟，更密没有意义）。 */
  tickMs: 60_000,
} as const

/**
 * settings 的 schema（`yanxin-window` 命名空间）。
 *
 * 时段元素用 `.required()`：手改 settings.yaml 只写半个时段（缺 `end`）会被
 * schema 校验拒掉（保持上一个好值并 warn），而不是装进一个坏窗口。
 * 格式（"HH:mm"）的校验在 `normalizeWindows` 里 —— **schema 管形状，纯函数管语义**。
 *
 * ⚠️ **数组字段必须显式 `.default(undefined)`**（2026-09-26 实测踩到，ADR 0014 决策二的同族坑）：
 * schemastery 的 `z.array()` **自带 `[]` 默认值** —— 不写这条时，`settings.yaml` 里没配
 * `yanxin-window` 会让 `scope.get().windows` 返回 `[]`（而非 `undefined`），
 * 于是 `windows` getter 的三级回退**永远卡在第一级**，内置默认 14:00–18:00 变成死代码，
 * 窗口恒关、World 引擎永不装载。71 条纯函数单测抓不到它 —— 它只活在"真实 settings
 * + 空配置"的装配路径上（`window-service.spec.ts` 有专门的真实装配测试堵这个洞）。
 *
 * 不导出的原因：导出会让 `tsc` 为推断类型生成 `.d.ts` 时引用 cosmokit 内部路径而报
 * **TS2742**（`pnpm build` 才暴露 —— onebot 的同一课）。而测试并不需要它：
 * `window-service.spec.ts` 经服务自己 register 的 scope 写入，覆盖的仍是**生产 schema**。
 */
const SettingsSchema = z.object({
  windows: z
    .array(z.object({ start: z.string().required(), end: z.string().required() }))
    // 同 OptionsSchema：`as never` 只为过类型签名，运行时值就是 undefined
    .default(undefined as never)
    .description('主动行为的开放时段（本地时间 "HH:mm"，左闭右开；支持多窗口与跨天）。'),
  paused: z
    .boolean()
    .default(undefined as never)
    .description(
      '手动暂停：true 时引擎行**恒被卸下**（窗口开着也不装载）。给控制台的"世界引擎开关"用' +
        '—— 比如额度紧张时按一下停，不用改 patch 重启。',
    ),
})

/**
 * 行 config 的 schema（bundle patch / profile patch）。
 *
 * 与 settings 拆开：`engineEntryId` / `tickMs` 是**装配结构**（指向哪个 loader 行、
 * 多久裁决一次），按 ADR 0004 的分层只该在 patch 层改，不属于运营内容。
 *
 * ⚠️ `windows` 同样要 `.default(undefined)`：行 config 与 settings 用的是同一个
 * schemastery，数组默认值的行为一致 —— 只修 settings 那一级，回退会卡在
 * "行 config 的 `[]`"上，缺陷换层存在而不是消失。
 */
const OptionsSchema = z.object({
  windows: z
    .array(z.object({ start: z.string().required(), end: z.string().required() }))
    // `.default(undefined)` 的**运行时**行为是把"没写"归一成 undefined（实测），
    // 但 schemastery 的类型签名不接受 undefined —— `as never` 只是过类型，
    // 不改变运行时值（never 可赋给任何参数类型）。
    .default(undefined as never)
    .description('同 settings 的形状；settings 里的值优先级更高。'),
  engineEntryId: z.string().description('World 引擎在 loader 里的行 id。'),
  tickMs: z.natural().description('窗口裁决间隔（毫秒）。'),
})

/** 行 config 里字段可能不全（回退见 {@link WINDOW_DEFAULTS}）。 */
interface WindowOptions {
  windows?: WindowSpec[]
  engineEntryId?: string
  tickMs?: number
}

/** settings 的可改面：时段 + 手动暂停（装配结构不开放给运行时改）。 */
interface WindowSettings {
  windows?: WindowSpec[]
  paused?: boolean
}

/**
 * loader 行的最小面，对齐 vendor/loader 的 `Entry`（语义已核对：
 * `disabled` 是**含父级继承**的 getter；`update` 是增量 reconcile —— 会
 * dispose / init 对应 fiber，无变化时 no-op，失败时保持原状可重试）。
 *
 * ⚠️ 为什么是本地声明而不是 import：`ctx.loader` 的类型来自
 * `@deepseek-ai/cordis-plugin-loader`，而它**刻意不在**我们的依赖里（ADR 0006：
 * 装了会带进第二份 cordis，实测测试进程直接 ERR_MODULE_NOT_FOUND）。编译期看不见，
 * 运行时由 DSH 装配提供 —— `inject` 里的 `'loader'` 保证服务就位后才装载本插件。
 * 面声明得越窄越稳：只列我们用到的成员。
 */
interface LoaderEntryLike {
  readonly options: { readonly id?: string }
  readonly disabled: boolean
  update(config: { disabled: boolean }): Promise<void>
}

/** loader 服务在本文件可见的最小面。 */
interface LoaderSurface {
  entries(): Iterable<LoaderEntryLike>
}

export default class WindowService extends Service {
  /**
   * 需要 settings（读/观察时段）与 loader（启停引擎行）。
   *
   * ⚠️ **不要写 `inject: ['logger']`**（onebot 的实测教训）：`ctx.logger` 是
   * Context 自带字段，不是 provide 注册的服务，写进 inject 会永远等待而不激活。
   */
  static readonly inject = ['settings', 'loader']

  /**
   * 行 config 的 schema。必须挂成 `static Config`（cordis 从这里读取校验）。
   * **必须显式标注 `z<WindowOptions>`**（onebot 的 TS2742 教训：不标注时 `tsc`
   * 产出 `.d.ts` 会因推断类型引用 cosmokit 内部路径而报错，`pnpm build` 才暴露）。
   */
  static readonly Config: z<WindowOptions> = OptionsSchema

  private readonly scope: SettingsScope<WindowSettings>

  /** entry 缺失的告警只打一次（否则每 tick 一条，日志会被淹）。 */
  private warnedMissing = false

  /** "世界还没创世"的告警同样只打一次（T30 加的判据；它不会自己变好）。 */
  private warnedWorld = false

  /** 裁决的串行队列：timer 与 settings watch 可能同时触发，不让 update 并发。 */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly config: WindowOptions

  constructor(ctx: Context, config: WindowOptions = {}) {
    super(ctx, 'window')
    this.config = config
    this.scope = ctx.settings.register(NAMESPACE, SettingsSchema)

    // 定时裁决。裸 setInterval 必须经 ctx.effect 绑生命周期 —— 少了这层，
    // 插件卸载后 interval 还在跑（T19 专门证伪这个形态的泄漏）。
    ctx.effect(() => {
      const timer = setInterval(() => {
        void this.evaluate()
      }, this.tickMs)
      return () => clearInterval(timer)
    }, 'yanxin-window.timer')

    // settings 变更 → 立即重裁决（否则改了时段最多要等一个 tick 才生效）。
    ctx.effect(
      () =>
        this.scope.watch(() => {
          void this.evaluate()
        }),
      'yanxin-window.watch',
    )

    this.ctx.logger.info(
      `[yanxin-window] 就绪：${this.windows.length} 条时段 / 引擎行「${this.engineEntryId}」/ 每 ${this.tickMs}ms 裁决`,
    )

    // 装载期立即对齐一次。**不 await**（构造不该阻塞生命周期）：evaluate 幂等，
    // 失败也只是日志里一条 warn，下一轮 tick 自动收敛。
    void this.evaluate()
  }

  /** 当前生效的时段：**settings → 行 config → 内置默认**，三级回退。 */
  get windows(): readonly WindowSpec[] {
    return normalizeWindows(this.scope.get().windows ?? this.config.windows ?? WINDOW_DEFAULTS.windows)
  }

  /**
   * 手动暂停（settings `yanxin-window.paused`）。true 时引擎行**恒被卸下**——
   * 窗口开着也不装载。与"关闭时段"是两回事：暂停是运营者明确的意志（控制台开关），
   * 关窗是时间到了；页面上把这两种"她没在过日子"分开说。
   */
  get paused(): boolean {
    return this.scope.get().paused === true
  }

  /** World 引擎的 loader 行 id（窗口唯一会动的开关）。 */
  get engineEntryId(): string {
    return this.config.engineEntryId ?? WINDOW_DEFAULTS.engineEntryId
  }

  /** 裁决间隔（毫秒）。坏值（非数字 / NaN / 非正）回退默认 —— schema 之外的兜底。 */
  get tickMs(): number {
    const raw = this.config.tickMs
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : WINDOW_DEFAULTS.tickMs
  }

  /** 现在是否处于开放窗口（**时间判定**；引擎是否已装载是 loader 的真相，不是这里）。 */
  get isOpen(): boolean {
    return withinAnyWindow(new Date(), this.windows)
  }

  /**
   * 裁决一次：把引擎行的启停对齐到"当前时间是否在窗口内"。
   *
   * 公开（不只供内部 timer）：测试用 `evaluate(固定时间)` 注入时钟，免去做假时钟；
   * 控制台将来也可以拿它做"立即生效"。返回这一轮的**开放状态**（不是 update 的成败）。
   *
   * 串行队列：timer 与 watch 可能同时触发 —— 让"找行 → 比状态 → update"整段排队，
   * 避免两个 update 交错。
   */
  async evaluate(now: Date = new Date()): Promise<boolean> {
    const run = this.queue.then(() => this.reconcile(now))
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 真正的对齐（在队列里跑）。三步，每步都有明确的失败姿态：
   *   1. 判定（纯函数，永不失败）
   *   2. 找行（找不到 → warn-once + 跳过；行出现后自动恢复）
   *   3. 启停（失败 → warn + **不假装成功**，下一轮自动重试）
   */
  private async reconcile(now: Date): Promise<boolean> {
    const open = withinAnyWindow(now, this.windows)
    // ⚠️ 手动暂停压过一切：窗口开着、世界存在，运营者按了停就是停（控制台开关的语义）。
    //    读的是每次裁决现查的 settings —— watch 会在写入后立刻触发重裁决，所以
    //    开关在页面上按下去，引擎行同一拍就装卸，不用等 tick、更不用重启。
    const paused = this.paused

    const entry = this.findEngineEntry()
    if (entry === undefined) {
      if (!this.warnedMissing) {
        this.warnedMissing = true
        this.ctx.logger.warn(
          `[yanxin-window] loader 里找不到引擎行「${this.engineEntryId}」—— 窗口裁决跳过（行出现后自动恢复）`,
        )
      }
      return open
    }
    this.warnedMissing = false

    // ── 世界里还没有她，就别让她过日子（T30，spec §6.11）──────────────────
    //
    // 窗口开着只说明"现在是有空的时候"；还得**世界真的存在**（创过世、有时钟）——
    // 否则引擎装载起来会对着一个空世界跑（`observe()` 会因"世界里没有她"而抛）。
    // 判据来自向导的现场证据，不看"某人说做过没有"。
    //
    // ⚠️ 软查（`ctx.get`）而不是 inject：窗口是 root 级常驻的调度器，不该被向导的
    //    装载顺序挡住 —— 它必须能独立裁决（连引擎行找不到都要 warn-once 地活着）。
    const world = await allowWorld(this.ctx)
    const shouldRun = open && !paused && world.ok
    if (open && !world.ok) this.warnWorldNotReady(world)

    // 已经在对的状态：什么都不做。update 无变化本身是 no-op，但连调用都省了，
    // 顺带保证事件只反映**真实翻转**。
    if (entry.disabled === !shouldRun) return open

    try {
      // ⚠️ 显式传 `disabled: false`（而不是 undefined）：vendor/loader 的 update
      //    把 **nullish 值解释为"删除该键"** —— 这里要的是写值，不是删键。
      await entry.update({ disabled: !shouldRun })
    } catch (error) {
      this.ctx.logger.warn(`[yanxin-window] 启停引擎行失败（下轮重试）：${describe(error)}`)
      return open
    }

    this.ctx.emit('yanxin/window-changed', open)
    this.ctx.logger.info(
      `[yanxin-window] 主动行为窗口${open ? '开启' : '关闭'}${paused ? '（已被手动暂停）' : ''}：` +
        `引擎行「${this.engineEntryId}」已${shouldRun ? '装载' : '卸载'}`,
    )
    return open
  }

  /** "世界还没创世"只告警一次（每轮 tick 都喊会把日志淹掉，而它不会自己变好）。 */
  private warnWorldNotReady(world: { status: string; advice?: string }): void {
    if (this.warnedWorld) return
    this.warnedWorld = true
    this.ctx.logger.warn(
      `[yanxin-window] 窗口开着，但${world.advice ?? '世界还没准备好'}（向导状态 ${world.status}）`,
    )
  }

  /** 在 loader 树里找引擎行。**每次现查、不缓存** —— 树会变（reload 后 entry 对象会换）。 */
  private findEngineEntry(): LoaderEntryLike | undefined {
    const loader = this.loader()
    if (loader === undefined) return undefined
    for (const entry of loader.entries()) {
      if (entry.options.id === this.engineEntryId) return entry
    }
    return undefined
  }

  /**
   * 取 loader 服务（断言而非 import —— 见 {@link LoaderEntryLike}）。
   *
   * 按"可能没有"处理：`inject` 保证正常情况下它存在，但宁可走 warn-once 分支，
   * 也不要一个 TypeError 把整次裁决炸掉。
   */
  private loader(): LoaderSurface | undefined {
    return (this.ctx as Context & { loader?: LoaderSurface }).loader
  }
}
