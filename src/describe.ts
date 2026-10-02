/**
 * 任意抛出物 → 一行可读文本（告警与日志共用的最小呈现）。
 *
 * 曾经各文件自带一份私有 `describe()`（同一行逻辑写了 10 遍）—— 统一放这里，
 * 将来要改错误呈现（比如带 stack、截断超长 message）只动一处。
 *
 * ⚠️ 与 `world/error.ts` 的 `KernelError.summary` 是两回事：那边带机读诊断的
 * 首条摘要（更适合喂回模型）；这里是给人看的日志一行。要 KernelError 增强版的
 * 呈现，就地组合：`error instanceof KernelError ? error.summary : describeError(error)`。
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
