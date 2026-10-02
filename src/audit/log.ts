/**
 * 审计落盘 —— `$DSH_HOME/yanxin/audit/<kind>.jsonl` 的**唯一出口**。
 *
 * 三条纪律都在这里兑现（spec §7.4-D / §6.10）：
 *   1. **密钥脱敏**：任何记录都先过 `redactValue` 再序列化 —— 调用方不需要记得脱敏
 *   2. **永不抛**：审计不可用不是拒绝服务的理由（url-guard 拒调用、shell 执行、
 *      控制台写操作都调它；任何一处因为审计失败而中断，都是把"记录"放到了"做事"前面）
 *   3. **路径调用时求值**：`$DSH_HOME` 在测试里会被接管（`tests/support/isolate-dsh-home.ts`），
 *      模块级常量会错过它 —— 那正是"跑一次单测污染生产数据"的形态
 *
 * ⚠️ 只用命名导出（ADR 0004）。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { redactValue } from './redact.ts'

/** 审计文件种类（一类一个文件，便于按用途 grep 与轮转）。 */
export type AuditKind = 'url-guard' | 'console' | 'shell'

/** 审计目录（`$DSH_HOME/yanxin/audit/`）。 */
export function auditDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'yanxin', 'audit')
}

/** 某一类审计的文件路径。 */
export function auditFile(kind: AuditKind): string {
  return join(auditDir(), `${kind}.jsonl`)
}

/**
 * 追加一条审计记录（脱敏后）。
 *
 * 记录形状：`{ at: ISO 时间, ...字段 }`。调用方给什么字段就记什么字段 ——
 * 各类审计的**必填字段**由各自的测试盯着（shell 见 `src/audit/shell-record.ts`）。
 *
 * `onError`：**永不抛**这条纪律不变，但"抛不了"不等于"什么都不说"。
 * 一个静默失败的审计器与一个没有审计器，症状完全一样（都不写文件）——
 * 所以把失败交给调用方去 `logger.warn`，让磁盘满 / 权限错在日志里留得下一行。
 */
export async function writeAudit(
  kind: AuditKind,
  record: Record<string, unknown>,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    const file = auditFile(kind)
    await mkdir(dirname(file), { recursive: true })
    const safe = redactValue(record) as Record<string, unknown>
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...safe })}\n`, 'utf8')
  } catch (error) {
    onError?.(error) // 静默：审计不可用不是拒绝服务的理由
  }
}