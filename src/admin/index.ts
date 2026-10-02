/**
 * 管理员名单服务（`ctx.admin`）。
 *
 * **它本身不做任何拦截。** 权限的强制点是 spec §6.10 的 preset 能力构成 ——
 * 带 shell 的 preset 只挂给管理员私聊会话，"非管理员没有 shell"是靠
 * **能力声明期裁掉**实现的，而不是靠这里运行期判定。
 *
 * 本服务只回答"这个人是不是管理员"，供三处使用：
 *   - preset 选择：决定哪个会话挂带 shell 的 preset（T11 的 bridge）
 *   - 审计打标：shell 审计日志要记是谁授权的（§6.10）
 *   - `/yanxin` 控制台：名单的增删（T32）
 *
 * 名单存 `ctx.settings` 的 `yanxin.admin` 命名空间 —— 放在 settings 而非插件 config，
 * 是因为它需要被控制台 **在运行时改** 且能持久化（ADR 0004 的分层：内容配置走 settings）。
 *
 * ⚠️ 装配纪律（ADR 0004）：本模块**只有 default 导出**（这一个类），
 *    没有模块级命名导出 —— 纯逻辑在 `./logic.ts`。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { isAdminIn, normalizeAdminList, withoutAdmin, withAdmin } from './logic.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    admin: AdminService
  }
  interface Events {
    /** 管理员名单已提交变更（参数为新的完整名单）。控制台与审计订阅它。 */
    'yanxin/admin-updated'(admins: readonly string[]): void
  }
}

/**
 * settings 命名空间。
 *
 * ⚠️ 形式受 `SettingsNamespaceInput` 约束：**只允许小写字母、数字、连字符** ——
 * **点号不合法**（`'yanxin.admin'` 会被推断成 `never`，报
 * "not assignable to parameter of type 'never'"）。故用连字符。
 */
const NAMESPACE = 'yanxin-admin'

const ConfigSchema = z.object({
  admins: z
    .array(z.string())
    .default([])
    .description('管理员白名单。为空时 isAdmin 一律返回 false（fail-closed）。'),
})

interface AdminConfig {
  admins: string[]
}

export default class AdminService extends Service {
  /**
   * 需要 settings 服务来注册命名空间。
   *
   * 注：**不写 `static readonly name`** —— `Service` 的服务键由 `super(ctx, 'admin')`
   * 给出，而 `static name` 会与基类成员冲突（TS4114）。DSH 自己的 Service 子类
   * 也都是只写 `super(ctx, name)`，此处对齐上游写法。
   */
  static readonly inject = ['settings']

  /**
   * ⚠️ **必须用 TS 的 `private`，不能用 `#` 私有字段。**
   *
   * cordis 的 `createTraceable` 会把服务值包进 Proxy，且对 getter 走
   * `Reflect.get(target, prop, shadow)` —— **以一个替换过的 receiver 调用 getter**。
   * `#private` 的品牌检查要求 receiver 就是声明它的那个实例，于是必然抛
   * "Cannot read private member ... from an object whose class did not declare it"。
   * 方法同理（`createShadowMethod`）。TS 的 `private` 在运行时被擦除，所以不受影响。
   * DSH 自己的服务（如 `SettingsProvider`）也全部用 TS `private`。见 ADR 0007。
   */
  private readonly scope: SettingsScope<AdminConfig>

  constructor(ctx: Context) {
    super(ctx, 'admin')
    this.scope = ctx.settings.register(NAMESPACE, ConfigSchema)

    // `watch` 返回 disposer；用 `ctx.effect` 把它绑到 fiber 生命周期，
    // 插件卸载时观察者自动解除（避免 spec §7.3 反例里那种"注册了却不反注册"）。
    ctx.effect(
      () =>
        this.scope.watch((next) => {
          ctx.emit('yanxin/admin-updated', next.admins)
        }),
      'yanxin-admin.watch',
    )
  }

  /** 当前名单（只读快照）。**每次读取都过一遍规范化** —— 手改 settings.yaml 带进的空白/重复会被消除。 */
  get admins(): readonly string[] {
    return normalizeAdminList(this.scope.get().admins)
  }

  /** 身份判定。规则见 `logic.ts` 的 fail-closed 三条。 */
  isAdmin(senderId: unknown): boolean {
    return isAdminIn(this.admins, senderId)
  }

  /** 追加一个管理员（幂等、去重）。供控制台与 setup 使用。 */
  async add(senderId: unknown): Promise<void> {
    const next = withAdmin(this.admins, senderId)
    if (next.length === this.admins.length) return
    await this.scope.update({ admins: next })
  }

  /** 移除一个管理员。供控制台使用。 */
  async remove(senderId: unknown): Promise<void> {
    const next = withoutAdmin(this.admins, senderId)
    if (next.length === this.admins.length) return
    await this.scope.update({ admins: next })
  }
}
