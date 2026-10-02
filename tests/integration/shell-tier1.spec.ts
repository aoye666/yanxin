/**
 * T5 **Tier 1** 验收：`dsh-bash-local` 在 win32 上能否真的执行命令。
 *
 * 为什么这件事需要一个测试：`dsh-bash-local` 的 README 明确写着
 * **"POSIX-only — the `bash` binary is hardcoded, and the underlying service's
 * group semantics are POSIX; Windows is unsupported."**（ADR 0001）
 * 我们**明知如此还是用了它**（Tier 1），所以必须实测，不能靠"应该行"。
 *
 * 这个测试同时是 **Tier 2（自建 `@yanxin/shell-gitbash`）的验收基线**：
 * 换了实现之后，同一套断言必须照样通过。
 *
 * ⚠️ **必须在 Git Bash 中运行 `pnpm test`**：Tier 1 零代码方案的成立前提就是
 *    `bash` 能在 PATH 上被解析到。若从 PowerShell/cmd 启动，`bash` 可能不在 PATH 上，
 *    下面的 `bash 可解析性` 那条会给出明确诊断，而不是让你看到一堆难懂的失败。
 *    （开发机上 Git 装在**非系统盘**，`C:\Program Files\Git` 这条标准路径并不存在 ——
 *     任何探测逻辑都不得硬编码盘符。）
 *
 * ⚠️ **API 用法**（实测发现，spec/plan 原先想当然写错了）：
 *    `ctx.shell.run()` 接受的是**已 resolve 的 `ShellExecSpec`**，不是 `ShellExecRequest`。
 *    `resolve()` 是必需的公开前置步骤，它负责填 `workdir` / `timeoutMs` /
 *    `stdoutMaxBytes` / `sandboxPolicy` 这些必需字段。直接 `run({ command })` 会在
 *    运行时报 `deadline timeoutMs must be a positive finite number`。
 *    故此处用 `sh()` 把两步包起来。
 */
import { Context } from '@deepseek-ai/cordis'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-shell'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import MemorySettings from '../support/memory-settings.ts'

const opened: Context[] = []

async function makeShellCtx(): Promise<Context> {
  const ctx = new Context()
  opened.push(ctx)
  // bash-local 依赖 settings（它把 shell 的预算注册成 settings 命名空间）
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(BashLocal, { timeoutMs: 20_000, maxTimeoutMs: 60_000 })
  return ctx
}

/** 两步执行：先 `resolve` 填默认值，再 `run`。见文件头的 API 用法说明。 */
function sh(ctx: Context, request: ShellExecRequest): Promise<ShellRunResult> {
  return ctx.shell.run(ctx.shell.resolve(request))
}

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
})

describe('Tier 1 前置：bash 可解析性（这条失败就是环境问题，不是代码问题）', () => {
  it('bash 能在 PATH 上被解析到', async () => {
    const ctx = await makeShellCtx()
    const probe = await sh(ctx, { command: 'command -v bash' })
    const found = probe.stdout.text.trim()
    expect(
      probe.exitCode === 0 && found.length > 0,
      `bash 不在 PATH 上（stdout=${JSON.stringify(probe.stdout.text)} stderr=${JSON.stringify(probe.stderr.text)}）。` +
        `\n→ Tier 1 的成立前提是 **在 Git Bash 中启动 DSH**（ADR 0001）。请用 Git Bash 跑 pnpm test。` +
        `\n→ 若从其他 shell 启动，需要改用 Tier 2 的自建执行器（显式 bashPath）。`,
    ).toBe(true)
  })
})

describe('Tier 1 —— 基本执行', () => {
  it('echo 能跑通并拿到 stdout', async () => {
    const ctx = await makeShellCtx()
    const r = await sh(ctx, { command: 'echo tier1-ok' })
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(r.aborted).toBe(false)
    expect(r.stdout.text).toContain('tier1-ok')
    expect(r.stdout.truncated).toBe(false)
  })

  it('确认执行的是 bash，而不是 cmd / pwsh', async () => {
    const ctx = await makeShellCtx()
    const r = await sh(ctx, { command: 'echo "$BASH_VERSION"; uname -s' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.text.trim().length).toBeGreaterThan(0)
    // uname 在 Git Bash 下形如 MINGW64_NT-10.0-26200
    expect(r.stdout.text.toLowerCase()).toMatch(/mingw|msys|cygwin|darwin|linux/)
  })

  it('stdout 与 stderr 分开收集', async () => {
    const ctx = await makeShellCtx()
    const r = await sh(ctx, { command: 'echo to-out; echo to-err >&2' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.text).toContain('to-out')
    expect(r.stdout.text).not.toContain('to-err')
    expect(r.stderr.text).toContain('to-err')
  })

  it('bash 特性可用（管道 / 变量 / 退出码）', async () => {
    const ctx = await makeShellCtx()
    const r = await sh(ctx, { command: 'false; echo "exit=$?"; echo a b c | wc -w' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.text).toContain('exit=1')
    expect(r.stdout.text.trim().endsWith('3')).toBe(true)
  })
})

describe('Tier 1 —— 退出码与错误分类', () => {
  it('失败命令返回非零退出码，而不是抛异常', async () => {
    const ctx = await makeShellCtx()
    const r = await sh(ctx, { command: 'exit 42' })
    expect(r.exitCode).toBe(42)
    expect(r.timedOut).toBe(false)
  })

  it('命令不存在时非零退出，且 stderr 有内容', async () => {
    const ctx = await makeShellCtx()
    const r = await sh(ctx, { command: 'definitely-not-a-command-xyz' })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.text.length).toBeGreaterThan(0)
  })

  it('超时被正确分类为 timedOut（不是 aborted）', async () => {
    const ctx = await makeShellCtx()
    const r = await sh(ctx, { command: 'sleep 30', timeoutMs: 1_500 })
    expect(r.timedOut).toBe(true)
    expect(r.aborted).toBe(false)
    expect(r.timeoutMs).toBeLessThanOrEqual(60_000)
  })

  it('调用方 abort 被分类为 aborted', async () => {
    const ctx = await makeShellCtx()
    const ac = new AbortController()
    const task = sh(ctx, { command: 'sleep 30', signal: ac.signal })
    setTimeout(() => ac.abort(), 400)
    const r = await task
    expect(r.aborted).toBe(true)
    expect(r.timedOut).toBe(false)
  })
})

describe('Tier 1 —— 工作目录与输出上限', () => {
  it('workdir 生效', async () => {
    const ctx = await makeShellCtx()
    const r = await sh(ctx, { command: 'pwd', workdir: process.cwd() })
    expect(r.exitCode).toBe(0)
    // Git Bash 的 pwd 是 /e/... 形式，与 Windows 盘符形式不同；而且本仓会被别人 clone 到
    // 任何目录、任何名字下 —— 所以断言"含当前目录名"，不写死任何项目名或盘符。
    const here = process.cwd().split(/[\\/]/).pop()?.toLowerCase() ?? ''
    expect(here).not.toBe('')
    expect(r.stdout.text.toLowerCase()).toContain(here)
  })

  it('超大输出被截断且标记 truncated（并有 spill 文件）', async () => {
    const ctx = await makeShellCtx()
    // 生成远超 64000 字节默认上限的输出
    const r = await sh(ctx, { command: 'yes x | head -c 200000' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.truncated).toBe(true)
    expect(r.stdout.spillPath ?? '').not.toBe('')
  })
})
