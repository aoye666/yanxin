/**
 * shell 审计插件（T36 / spec §6.10 的"每条命令写审计日志"）。
 *
 * **覆盖面**：判据是"名字像执行器 + 参数里有命令文本"（`executableCommandOf`），
 * 不是"名字等于 `bash`"。原因：MCP 工具绕过 preset 的能力裁剪（ADR 0005），
 * 只认 `bash` 会给"执行"留一条不留痕的路。
 *
 * 接缝选择（两个监听器，都不是控制）：
 *   · `tools/pre-execute` —— **只记开始时刻**，随即 `next()`（不改判定、不加延迟）
 *   · `tools/result`      —— 每次调用 finalize 后触发（含被拒/中止路径），
 *                            监听器抛错被 DSH 吞成一条 warn，**不会影响工具结果**
 *
 * 为什么不用 `tools/post-execute`：那是 waterfall 决策接缝（可 accept/replace/block），
 * 审计是纯观察者，放在决策链上没有任何收益，只多一处可能影响模型行为的代码。
 * 用时差量耗时也是没有办法的办法 —— DSH 的结果类型里没有 duration 字段
 * （`ToolExecutionResult` 只有 isError/content/value/meta，见 T36 记录）。
 *
 * **能看到的身份面**（必须记住的限度）：`exec.agent.id` 是**会话**，
 * 不是"说话的人"。账号是从会话命名约定解析出来的（`src/audit/session-subject.ts`）。
 *
 * ⚠️ 装配纪律：只用命名导出，不用 `export default`（ADR 0004）。
 */

import { buildShellAuditRecord, executableCommandOf } from '../audit/shell-record.ts'
import { writeAudit } from '../audit/log.ts'

export const name = 'yanxin-shell-audit'
export const inject = ['tools']

export function apply(ctx: any): void {
  /** callId → 开始时刻（毫秒）。只在两次调用之间活着，取完即删。 */
  const startedAt = new Map<string, number>()

  // 报活：审计"在不在"必须是日志里能看见的事实（与 window-service / bridge 同一取向）——
  // 一个静默的审计器与一个没有审计器，症状完全一样（都不写文件）。
  ctx.logger?.info?.('[yanxin-shell-audit] 就绪：每次执行类工具调用（bash / mcp__*）写一行审计')

  ctx.on('tools/pre-execute', (exec: any, next: () => Promise<any>) => {
    if (executableCommandOf(exec?.name, exec?.arguments) !== undefined && typeof exec.callId === 'string') {
      startedAt.set(exec.callId, Date.now())
    }
    return next()
  })

  ctx.on('tools/result', (exec: any, result: any) => {
    if (executableCommandOf(exec?.name, exec?.arguments) === undefined) return
    const callId = typeof exec.callId === 'string' ? exec.callId : ''
    const record = buildShellAuditRecord({
      exec,
      result,
      startedAtMs: startedAt.get(callId),
      finishedAtMs: Date.now(),
    })
    startedAt.delete(callId) // 不随会话增长：一次调用一行，取完就删
    void writeAudit('shell', record, (error) => {
      // 落盘失败只 warn（审计不该拖住执行），但不能连一声都不吭 —— 见 `src/audit/log.ts`
      ctx.logger?.warn?.('[yanxin-shell-audit] 这条审计**没落盘**：%s', error instanceof Error ? error.message : String(error))
    })
  })
}