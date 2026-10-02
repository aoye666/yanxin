/**
 * 初始化向导的**公共类型**（T28，spec §6.11）。
 *
 * 单独一个文件是为了打断循环依赖：`logic.ts`（纯判定）与 `index.ts`（读写文件的服务）
 * 都要用这些类型，而任一方都不该 import 另一方。
 */

/** 向导的四步 —— **数组顺序就是依赖顺序**（世界要在人格之后，账号要在世界之后）。 */
export const SETUP_STEPS = ['persona', 'background', 'world', 'accounts'] as const

export type SetupStep = (typeof SETUP_STEPS)[number]

/**
 * 对外状态。
 *
 * `init` = 一步都没完成；`ready` = 四步**既做过又成立**；
 * 其余值 = "已完成到这里"（`persona` 表示只完成了第一步）。
 *
 * ⚠️ 它是**推导出来的**（记录 ∩ 证据），不是随便写进文件的一个字段 —— 见 `logic.ts`
 * 关于"两个真相来源"的说明。
 */
export type SetupStatus = 'init' | SetupStep | 'ready'

/** 步骤在顺序里的位置（用于比较与排序）。 */
export function stepIndex(step: SetupStep): number {
  return SETUP_STEPS.indexOf(step)
}

/** 某一步的现场判定结果。 */
export interface StepState {
  step: SetupStep
  /** 现场真的满足这一步（与"记录里说做过"是两件事）。 */
  satisfied: boolean
  /** 不成立时缺什么 —— **可操作**的几句话，直接显示给运营者。 */
  missing: string[]
}

/** 给控制台/CLI 的完整进度（`logic.reconcile()` 的产物形状）。 */
export interface SetupProgress {
  status: SetupStatus
  /** 下一步该做的（`ready` 时为 `null`）。 */
  next: SetupStep | null
  steps: { step: SetupStep; completed: boolean; satisfied: boolean; runnable: boolean; missing: string[] }[]
  /** 记录里说做过、现在却不成立的步骤。 */
  reverted: SetupStep[]
  /** 提醒（不拦 ready）。 */
  warnings: string[]
}

/**
 * 向导的错误。
 *
 * `code` 是机读的（控制台据此决定显示"去补上什么"还是"这是程序缺陷"），
 * `details` 是**可操作**的几句话（缺哪个文件、哪个配置项）。
 */
export class SetupError extends Error {
  constructor(
    readonly code: 'STEP_BLOCKED' | 'STEP_FAILED' | 'BAD_INPUT' | 'NOT_WIRED',
    message: string,
    readonly details?: string[],
  ) {
    super(message)
    this.name = 'SetupError'
  }

  /** 给人看的一整段（日志与 HTTP 响应直接用）。 */
  get summary(): string {
    const lines = this.details ?? []
    return lines.length === 0 ? this.message : `${this.message}：${lines.join('；')}`
  }
}