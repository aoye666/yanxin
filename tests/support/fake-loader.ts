/**
 * 测试用的假 loader（T19）。
 *
 * ## 为什么不是 mock
 *
 * `ctx.loader` 的类型来自 `@deepseek-ai/cordis-plugin-loader`，而它**刻意不在**依赖里
 * （ADR 0006：装了会带进第二份 cordis，实测测试进程直接 ERR_MODULE_NOT_FOUND）。
 * 于是 T17/T19 要验收的核心交互 —— "窗口服务经 loader 启停引擎行" —— 在类型上
 * 只能用本地最小面声明（`src/window/index.ts` 的 `LoaderEntryLike` / `LoaderSurface`），
 * 在**测试**上就需要一个真会 dispose / 重装载的 loader。
 *
 * mock 掉（比如让 `update` 只改个标志位）就成了"测自己写的 mock"：引擎的
 * `ctx.effect` 有没有真的回滚、重装后是不是**新实例**、无关服务受不受影响 ——
 * 这些恰恰是 T19 要钉住的东西，mock 一个都测不出来。
 *
 * ## 忠实度：复刻 `vendor/loader/src/config/entry.ts` 的 update 中被我们用到的部分
 *
 * | 语义 | vendor 的行为 | 本文件 |
 * |---|---|---|
 * | 无变化 | `deepEqual` diff 为空 → 直接 return（no-op） | `next === current` → return |
 * | 变 disabled | `await this._dispose(previous)`（真 dispose fiber） | `fiber.dispose()` |
 * | 变 enabled | `await this.init()`（真装载） | `ctx.plugin(plugin, config)` |
 * | nullish 值 | **删键**，生效值 = `Boolean(undefined)` = false | `Boolean(patch.disabled)` |
 *
 * **不复制**：父级继承（`_disabled` 的祖先链）、`!!js` 表达式、`_patchContext`
 * 的增量 config 更新、写回持久化。这些我们**没有用到**（窗口服务只传 `disabled`），
 * 复制它们只会让假 loader 变成一份需要同步维护的 fork。
 *
 * ⚠️ 默认 `disabled: true` —— 与生产 patch 一致（`cordis.patch.yml` 的引擎行就是
 * `disabled: true` 的 fail-safe）。也让构造器零异步：初始启用的 entry 需要在构造期
 * 装载，而构造器不能 await。
 *
 * ⚠️ 装配纪律（ADR 0004）：本文件只 `export default`（FakeLoader）—— 其余用具名导出
 * 是因为它们是**类型与类型化辅助**，不是插件入口。FakeLoader 自己是 Service 子类，
 * 「default 导出 + 命名导出」的混合形态与 `memory-settings.ts` 同型。
 */
import { Service, type Context, type Fiber } from '@deepseek-ai/cordis'

/** 一条假行的定义。 */
export interface FakeEntrySpec {
  /** loader 行 id（窗口服务按它找行）。 */
  id: string
  /** 装什么：任意 cordis 插件（通常是 Service 子类，如 `WorldEngine`）。 */
  plugin: unknown
  /** 行 config。 */
  config?: unknown
  /** 初始状态。默认 `true`（fail-safe，与生产 patch 一致）。 */
  disabled?: boolean
}

/** cordis `plugin()` 的参数类型（避免 import 内部类型）。 */
type PluginArg = Parameters<Context['plugin']>[0]

/**
 * 一条假 loader 行 —— **持有真 fiber**。
 *
 * `disabled` 是 getter（不是字段）：真实 Entry 的 `disabled` 是"含父级继承"的 getter，
 * 窗口服务读它做对齐判断（`entry.disabled === !open` 时跳过 update）。假 entry 没有
 * 父级，所以就是自身状态，但**保持 getter 形态**以免调用方养成"能写它"的错觉。
 */
export class FakeEntry {
  readonly options: { readonly id: string }

  /** 当前 fiber（`undefined` = 未装载 / 已卸载）。 */
  fiber: Fiber | undefined

  /** `update` 收到的每一次请求（断言"无变化时不调 update"用）。 */
  readonly updates: boolean[] = []

  private disabledFlag: boolean

  constructor(
    private readonly ctx: Context,
    private readonly spec: FakeEntrySpec,
  ) {
    this.options = { id: spec.id }
    this.disabledFlag = spec.disabled ?? true
  }

  get disabled(): boolean {
    return this.disabledFlag
  }

  /**
   * 启停（唯一被窗口服务用到的入口）。
   *
   * ⚠️ `nullish = 删键` 的复刻就在这里：vendor 把 `undefined` 解释为"删除该键"，
   * 生效值是 `Boolean(undefined) = false`（= 启用）。所以传 `undefined` 与传
   * `false` 的**最终状态相同** —— 但生产代码仍显式传 `false`（写值 vs 删键的语义
   * 差别，将来 update 若有别的副作用就分化了，见 `src/window/index.ts` 的注释）。
   */
  async update(patch: { disabled?: boolean | null }): Promise<void> {
    const next = Boolean(patch.disabled)
    this.updates.push(next)

    if (next === this.disabledFlag) return // vendor：diff 为空 → no-op

    this.disabledFlag = next
    if (next) await this.unload()
    else await this.load()
  }

  /** 真装载：`ctx.plugin` 返回的 fiber，`await` 到服务就绪。 */
  private async load(): Promise<void> {
    this.fiber = (await this.ctx.plugin(this.spec.plugin as PluginArg, this.spec.config as never)) as Fiber
  }

  /** 真卸载：dispose fiber —— 其 effect 全部回滚（这才是"回滚"的证据）。 */
  private async unload(): Promise<void> {
    const fiber = this.fiber
    this.fiber = undefined
    await fiber?.dispose()
  }
}

/**
 * 假 loader 服务：`super(ctx, 'loader')` —— 生产代码按服务名找它
 * （`src/window/index.ts` 的 `loader()` 是运行时断言访问 `ctx.loader`）。
 */
export default class FakeLoader extends Service {
  private readonly map = new Map<string, FakeEntry>()

  constructor(ctx: Context, specs: FakeEntrySpec[]) {
    super(ctx, 'loader')
    for (const spec of specs) this.map.set(spec.id, new FakeEntry(ctx, spec))
  }

  /** 与真实 loader 同形的查询面（窗口服务 `for...of entries()` 用它找行）。 */
  entries(): Iterable<FakeEntry> {
    return this.map.values()
  }

  /** 仅供测试：按 id 取行（断言 disabled / fiber / updates）。 */
  entry(id: string): FakeEntry {
    const entry = this.map.get(id)
    if (entry === undefined) throw new Error(`假 loader 里没有行「${id}」`)
    return entry
  }
}
