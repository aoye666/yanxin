/**
 * shell 审计记录的**构造**（纯函数）—— spec §6.10 的字段表：
 * 时间 / 账号 / 会话 / 完整命令 / exit code / 耗时 / 输出字节数 / 危险等级。
 *
 * 与落盘分开的理由是测试：这一层不该碰文件系统，也不该依赖真实的 bash 执行器 ——
 * 于是"字段齐不齐、值取得对不对"可以用构造出来的 exec/result 直接断言。
 *
 * ⚠️ 五处**如实**的记录（不是缺点，是这张表能成立的前提）：
 *   1. **命令是脱敏后的**：原文若含密钥，落盘的是 `«redacted»` 形态；同时写
 *      `commandRedacted: true` 说明"这行被改过"（spec §7.4-D 与 §6.10 的冲突取前者）。
 *   2. **耗时是我们自己量的**：DSH 的 `ToolExecutionResult` 没有 duration 字段
 *      （类型定义里查不到），所以用 pre-execute 到 result 的墙钟差，字段名就叫
 *      `durationMs`（我们量的，不是工具报的）。
 *   3. **账号是从会话命名约定解析的**：工具接缝没有发起者身份（见 `./session-subject.ts`）。
 *      `session` 原文一并写下，供人核对。
 *   4. **字节数是"带内"的**：`stdoutBytes` 量的是结果里 `stdout.text` 的长度，而输出超过
 *      `maxOutputBytes` 时 DSH 会把超出部分写进 spill 文件 —— 所以 `truncated.stdout` 为真时
 *      这个数**小于**真实输出。全量大小只能顺着 `spillPath` 去看（我们没有那个接缝）。
 *   5. **覆盖面不止 `bash`**：见下方 `EXECUTABLE_TOOLS`。`tool` 记的是**真实工具名**，
 *      所以 MCP 工具的调用也在表里，不会被当成 bash 的调用。
 *
 * ⚠️ 只用命名导出（ADR 0004）。
 */
import { Buffer } from 'node:buffer'
import { classifyCommand } from './danger.ts'
import { hasSecret, redactSecrets } from './redact.ts'
import { parseSessionId } from './session-subject.ts'

/** shell 工具名（`@deepseek-ai/dsh-tool-bash`：`packages/shell/tool-bash/src/index.ts` 的 `name: 'bash'`） */
export const SHELL_TOOL_NAME = 'bash'

/**
 * 会**执行东西**的工具名（审计的覆盖面）。
 *
 * 为什么不止 `bash`：MCP 工具绕过 preset 的能力裁剪（ADR 0005），在 DSH 的调用接缝上
 * 它就是一次普通工具调用。只认 `bash` 等于给"执行"留了一条不留痕的路 ——
 * 而审计的全部价值就在于"每条命令都有一行"。
 *
 * `pwsh` / `exec` / `terminal` 在本装配里已被 disable（`cordis.patch.yml` 的 host 清单）。
 * 仍然列出来是**有意的冗余**：哪天上游多挂一个执行器，审计先看见，spec 后改。
 */
const EXECUTABLE_TOOLS: readonly RegExp[] = [/^bash$/, /^pwsh$/, /^exec$/, /^terminal$/, /^mcp__/]

/**
 * 命令文本可能藏在哪几个参数键下。
 *
 * 与 `url-guard` 递归扫 `url`/`urls` 同一个取向：MCP 各家的参数名不统一，
 * 逐工具硬编码参数表意味着"新工具 = 漏审计"。
 */
const COMMAND_KEYS: readonly string[] = ['command', 'cmd', 'script']

/**
 * 这次调用是不是"执行了点东西"。是则返回命令文本，否则 `undefined`。
 *
 * ⚠️ 这是**观察者**的判据，不是权限判据 —— 拦什么由 preset 的能力裁剪负责（§7.4-B）。
 */
export function executableCommandOf(name: unknown, args: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  if (!EXECUTABLE_TOOLS.some((pattern) => pattern.test(name))) return undefined
  if (args === null || typeof args !== 'object') return undefined
  for (const key of COMMAND_KEYS) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** bash 工具 canonical 结果里我们关心的那几个字段（其余忽略）。 */
interface BashValue {
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  aborted?: boolean
  stdout?: { text?: string; truncated?: boolean; spillPath?: string }
  stderr?: { text?: string; truncated?: boolean }
}

export interface ShellAuditInput {
  /** `ToolExecution`（这里只取名字/参数/agent/callId）。 */
  exec: {
    callId?: unknown
    name?: unknown
    arguments?: unknown
    agent?: { id?: unknown } | undefined
  }
  /** `ToolExecutionResult`。 */
  result: { isError?: unknown; error?: { name?: string; code?: string; message?: string }; value?: unknown }
  /** pre-execute 时我们记下的时刻（毫秒）；没有就记 `null`。 */
  startedAtMs?: number
  /** 构造记录的时刻（由调用方给，保持本函数纯粹）。 */
  finishedAtMs: number
}

function asBashValue(value: unknown): BashValue | undefined {
  if (value === null || typeof value !== 'object') return undefined
  return value as BashValue
}

function bytesOf(text: string | undefined): number {
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0
}

/** 组装一条 shell 审计记录。字段缺失一律写 `null`（**不省略**：读的人要能看出"没取到"）。 */
export function buildShellAuditRecord(input: ShellAuditInput): Record<string, unknown> {
  const { exec, result } = input
  const args = (exec.arguments ?? {}) as { description?: unknown; workdir?: unknown }
  const rawCommand = executableCommandOf(exec.name, exec.arguments) ?? ''
  const command = redactSecrets(rawCommand)
  const verdict = classifyCommand(rawCommand)

  const session = typeof exec.agent?.id === 'string' ? exec.agent.id : undefined
  const subject = session === undefined ? undefined : parseSessionId(session)

  const value = asBashValue(result.value)
  const stdout = value?.stdout
  const stderr = value?.stderr

  const record: Record<string, unknown> = {
    tool: typeof exec.name === 'string' ? exec.name : SHELL_TOOL_NAME,
    callId: typeof exec.callId === 'string' ? exec.callId : null,
    session: session ?? null,
    mode: subject?.mode ?? null,
    // 账号是"从会话命名解析出来的"（工具接缝没有发起者身份）—— 详见本文件头
    account: subject?.account ?? null,
    channel: subject?.channel ?? null,
    groupId: subject?.groupId ?? null,
    command,
    commandRedacted: hasSecret(rawCommand),
    description: typeof args.description === 'string' ? redactSecrets(args.description) : null,
    // ⚠️ 记的是**调用方要的工作目录**，不是"命令真正跑在哪"。执行器的取值是
    //    `request.workdir ?? config.cwd ?? process.cwd()`（dsh-bash-local `lib/index.js:170`），
    //    后两个我们在工具接缝上看不见 —— 缺席即"没要求"，落到哪由部署配置决定。
    requestedWorkdir: typeof args.workdir === 'string' ? redactSecrets(args.workdir) : null,
    danger: verdict.level,
    dangerTags: verdict.tags,
    exitCode: typeof value?.exitCode === 'number' ? value.exitCode : null,
    signal: value?.signal ?? null,
    timedOut: value?.timedOut ?? false,
    aborted: value?.aborted ?? false,
    stdoutBytes: bytesOf(stdout?.text),
    stderrBytes: bytesOf(stderr?.text),
    truncated: { stdout: stdout?.truncated ?? false, stderr: stderr?.truncated ?? false },
    spillPath: stdout?.spillPath ?? null,
    durationMs: input.startedAtMs === undefined ? null : input.finishedAtMs - input.startedAtMs,
    isError: result.isError === true,
    errorCode: result.error?.code ?? null,
    errorMessage: result.error?.message ?? null,
  }
  return record
}