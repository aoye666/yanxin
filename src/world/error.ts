/**
 * 内核的错误与**机读诊断**（spec §6.7）。
 *
 * 诊断要能被模型读懂并自行修正 —— 这是"模型提案 → 内核校验"这条链路能闭合的关键：
 * 拒了它，它得知道**哪里错了、为什么错、目标长什么样**，否则只能瞎猜重试。
 *
 * 所以诊断是**结构化的**（code / opIndex / entityId / field / reason），
 * 不是一句人话。`message` 只是给人看的补充。
 */
import type { EntityKind } from './state.ts'

/** 引用类问题为什么被拒。 */
export type DiagnosticReason =
  /** 引用的实体不存在 */
  | 'missing'
  /** 引用的实体类型不对（location 要 place、owner 要 actor） */
  | 'wrong_kind'
  /** 只对物件允许 owner，actor/place 不能有主人 */
  | 'owner_not_allowed'
  /** 容纳关系成环（A 在 B 里、B 在 A 里） */
  | 'cycle'
  /** 类目不在白名单（未知操作） */
  | 'unknown_op'
  /** 乐观并发：版本不符 */
  | 'version_mismatch'
  /** 幂等键缺失 */
  | 'missing_key'

export interface KernelDiagnostic {
  /** 机读码（`KernelError.code` 的子类，便于模型按类处理）。 */
  code: string
  /** 提案里第几条操作出的问题（从 0 开始）；整体性问题省略。 */
  opIndex?: number
  /** 出问题的操作类型。 */
  op?: string
  entityId?: string
  /**
   * 出问题的字段名。
   *
   * 引用类的是 `location` / `owner` / `id` / `version` / `op` / `idempotencyKey`；
   * **形状类**的那批（`entity` / `entity.id` / `entity.kind` / `changes` / `action` /
   * `action.id` / `actorId` / `text`）由 `describeShapeProblem` 产出 ——
   * 模型漏字段时给它一条能照着改的诊断，而不是让应用阶段抛裸 TypeError。
   */
  field?:
    | 'location'
    | 'owner'
    | 'id'
    | 'version'
    | 'op'
    | 'idempotencyKey'
    | 'entity'
    | 'entity.id'
    | 'entity.kind'
    | 'changes'
    | 'action'
    | 'action.id'
    | 'actorId'
    | 'text'
    | 'status'
  /** 被引用却没找到（或类型不对）的目标 id。 */
  targetId?: string
  reason: DiagnosticReason
  /** 期望的实体类型（引用校验用）。 */
  expectedKinds?: EntityKind[]
  /** 实际找到的类型（引用校验用）。 */
  actualKind?: EntityKind
  /** 成环时的闭合路径，如 `["room", "house", "room"]`。 */
  path?: string[]
  message: string
}

/**
 * 内核拒绝一次提案时抛的错。
 *
 * ⚠️ **`INVALID_JSON` 与校验失败都用它** —— 区别在 `code`：
 * `VALIDATION_FAILED` 是业务规则（可修正后重提），`INVALID_JSON` 是数据形态问题（更基础）。
 */
export class KernelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: KernelDiagnostic[],
  ) {
    super(message)
    this.name = 'KernelError'
  }

  /** 诊断摘要（日志与测试断言用）。 */
  get summary(): string {
    const first = this.details?.[0]
    return first === undefined ? this.message : `${this.message}：${first.message}`
  }
}

/** 构造一条诊断（收窄构造参数，避免调用处写一长串字段）。 */
export function diagnostic(input: Omit<KernelDiagnostic, 'message'> & { message: string }): KernelDiagnostic {
  return input
}