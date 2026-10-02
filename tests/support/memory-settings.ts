/**
 * 测试用的内存版 settings provider。
 *
 * 为什么需要：`SettingsProvider` 是抽象类，`dsh-settings-file` 是文件持久化的实现
 * （我们没装它）。而任何依赖 `ctx.settings` 的服务都必须在测试里有一个可用的
 * provider —— 否则只能去搭真实环境，那既慢又脆。
 *
 * 抽象面只有三个成员（`writable` / `load` / `persist`），所以内存实现很短。
 * `[Service.init]` 是**具体方法**（provider 基类已实现加载与发布），子类不需要覆盖。
 *
 * ⚠️ 本文件是测试支撑代码，不进 bundle：`package.json` 的 `files` 只含 `lib`/
 *    `cordis.patch.yml`/`presets`/`persona`，`tsconfig.build.json` 只编译 `src`。
 *
 * ⚠️ 装配纪律（ADR 0004）：只有 default 导出。
 */
import { SettingsProvider } from '@deepseek-ai/dsh-settings'

export default class MemorySettings extends SettingsProvider {
  /** 内存 provider 允许写入（否则 `update` 会被拒）。 */
  readonly writable = true

  /**
   * 模拟磁盘上的「用户文档」：命名空间 → 该命名空间的完整用户段。
   *
   * ⚠️ 用 TS 的 `private` 而非 `#` —— cordis 的 `createTraceable` 会用替换过的
   * receiver 调用服务成员，`#` 私有字段的品牌检查会因此失败。见 ADR 0007。
   *
   * ⚠️ 字段名**不能叫 `document`**：`SettingsProvider` 基类已有一个 private
   * `document`，而 TS 的私有是名义的 —— 同名会被判为
   * "Types have separate declarations of a private property" 而报错。
   */
  private store: Record<string, unknown> = {}

  protected override async load(): Promise<Record<string, unknown>> {
    return structuredClone(this.store)
  }

  protected override async persist(ns: string, section: Record<string, unknown>): Promise<void> {
    this.store[ns] = structuredClone(section)
  }

  /** 仅供测试断言：读出当前「落盘」的原始文档。 */
  snapshot(): Record<string, unknown> {
    return structuredClone(this.store)
  }
}
