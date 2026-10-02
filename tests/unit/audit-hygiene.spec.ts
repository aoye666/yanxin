/**
 * 密钥卫生的端到端检查（T36 / spec §7.4-D）：
 * **用假密钥跑一遍三条落盘链路，然后 grep 整个 `$DSH_HOME` —— 零命中。**
 *
 * 为什么必须是"跑链路 + grep 文件"，而不是"检查代码里有没有 console.log(key)"：
 * 密钥泄漏的形态是**数据流**（参数 → 记录 → 文件），静态检查看不出。
 * 这里的三条链路就是本仓库全部的落盘出口：
 *   1. `url-guard` 的拦截/放行审计（URL 里可能带 key —— MCP 端点就是这样）
 *   2. `shell` 的命令审计（命令行里可能带 `export KEY=…`、`Authorization: Bearer …`）
 *   3. `console` 的写操作审计（被拒原因里可能带 token）
 *
 * 假密钥用**真实前缀**（`sk-` / `tvly-` / `Bearer`）—— 否则测的是"我认得这几个假串"，
 * 而不是"脱敏规则认得真形态"。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply as applyShellAudit } from '../../src/admin/shell-audit.ts'
import { auditDir, auditFile } from '../../src/audit/log.ts'
import { sendJson } from '../../src/console/api.ts'
import { apply as applyUrlGuard } from '../../src/net/url-guard.ts'

/** 假密钥：形态与真的一致，值是假的。 */
const SECRET = {
  tavily: 'tvly-dev-FAKE0000000000000000',
  deepseek: 'sk-fake0000000000000000',
  bearer: 'FAKEbearer1234567890',
  console: 'yanxin-console-FAKE-123456',
  onebot: 'onebot-FAKE-abcdef',
} as const

const ALL_SECRETS = Object.values(SECRET)

/** 放行用的 `next()`（守卫的放行路径就是把它原样返回）。 */
const nextAllow = async (): Promise<unknown> => undefined

/** 极简 ctx：只提供我们用到的 `on` / `emit` / `logger`。 */
function fakeCtx(): { ctx: any; fire: (event: string, ...args: unknown[]) => Promise<unknown> } {
  const listeners = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const ctx = {
    on: (event: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      listeners.set(event, fn)
    },
    emit: () => {},
    logger: { warn: () => {} },
  }
  return {
    ctx,
    fire: async (event: string, ...args: unknown[]) => {
      const fn = listeners.get(event)
      if (fn === undefined) throw new Error(`没有监听 ${event}`)
      return fn(...args)
    },
  }
}

/** 等文件出现（落盘是 fire-and-forget：DSH 的 emit 监听器不会被 await，测试要自己等）。 */
async function waitForFile(path: string, timeoutMs = 1_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(path)) return readFileSync(path, 'utf8')
    if (Date.now() > deadline) throw new Error(`等不到审计文件：${path}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 递归读一个目录下所有文件的内容（目录不在或文件读不了就跳过）。 */
function readTree(dir: string): string {
  if (!existsSync(dir)) return ''
  const chunks: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) chunks.push(readTree(full))
    else if (statSync(full).isFile()) chunks.push(readFileSync(full, 'utf8'))
  }
  return chunks.join('\n')
}

describe('T36 密钥卫生：假密钥跑三条链路', () => {
  it('url-guard：拒一条、放一条，两条都进了审计且都不含密钥', async () => {
    const { ctx, fire } = fakeCtx()
    applyUrlGuard(ctx)

    // ① 被拒：内网地址 + URL 里挂着 key（MCP 端点的真实形态）
    const denied = await fire(
      'tools/pre-execute',
      {
        callId: 'c1',
        name: 'mcp__tavily__tavily_extract',
        arguments: { urls: [`http://127.0.0.1:2333/mcp?tavilyApiKey=${SECRET.tavily}`] },
      },
      nextAllow,
    )
    expect(denied).toMatchObject({ kind: 'deny' })

    // ② 放行：公网 IP 字面量 + 查询串里挂着 key（这行同样会落盘）
    const allowed = await fire(
      'tools/pre-execute',
      {
        callId: 'c2',
        name: 'web_fetch',
        arguments: { url: `https://8.8.8.8/x?access_token=${SECRET.deepseek}` },
      },
      nextAllow,
    )
    expect(allowed).toBeUndefined() // `next()` 返回 undefined 就是"没拦"

    const text = readFileSync(auditFile('url-guard'), 'utf8')
    expect(text).toContain('«redacted')
    for (const secret of ALL_SECRETS) expect(text).not.toContain(secret)
  })

  it('shell：命令行与输出里的密钥都不落盘', async () => {
    const { ctx, fire } = fakeCtx()
    applyShellAudit(ctx)

    const command = `export DEEPSEEK_API_KEY=${SECRET.deepseek} && curl -H "Authorization: Bearer ${SECRET.bearer}" http://127.0.0.1:2333/health`
    const exec = {
      callId: 's1',
      name: 'bash',
      arguments: { command, description: '探活' },
      agent: { id: 'admin:1000000001' },
    }
    await fire('tools/pre-execute', exec, nextAllow)
    await fire('tools/result', exec, {
      isError: false,
      value: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        // 输出里也塞一个密钥：工具回显环境变量是常见行为
        stdout: { text: `TOKEN=${SECRET.onebot}\n`, truncated: false },
        stderr: { text: '', truncated: false },
      },
    })

    const lines = (await waitForFile(auditFile('shell'))).split('\n').filter((line) => line.length > 0)
    expect(lines.length).toBeGreaterThan(0)
    const record = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>

    // spec §6.10 的字段表逐条在位
    for (const key of [
      'at',
      'session',
      'account',
      'command',
      'exitCode',
      'durationMs',
      'stdoutBytes',
      'danger',
    ]) {
      expect(record, key).toHaveProperty(key)
    }
    expect(record.account).toBe('1000000001')
    expect(record.exitCode).toBe(0)
    expect(record.commandRedacted).toBe(true)
    for (const secret of [SECRET.deepseek, SECRET.bearer, SECRET.onebot]) {
      expect(JSON.stringify(record)).not.toContain(secret)
    }
  })

  it('console：写操作审计里的 token 也不落盘', async () => {
    const { auditWrite } = await import('../../src/console/registry.ts')
    await auditWrite({ emit: () => {} } as never, {
      path: '/yanxin/api/setup/run',
      method: 'POST',
      ok: false,
      reason: `token=${SECRET.console} 被拒`,
    })

    const text = readFileSync(auditFile('console'), 'utf8')
    expect(text).toContain('/yanxin/api/setup/run')
    expect(text).not.toContain(SECRET.console)
    expect(text).toContain('«redacted')
  })

  it('控制台响应的唯一出口也脱敏（sendJson）', () => {
    // spec §7.4-D：控制台响应同样不得包含密钥。这里对**唯一出口**直接断言，
    // 于是将来任何一页把配置回显出去，都不会带出密钥。
    const written: string[] = []
    const res = {
      writeHead: () => {},
      end: (body: string) => {
        written.push(body)
      },
    } as unknown as ServerResponse

    sendJson(res, 200, {
      ok: true,
      data: { note: `token=${SECRET.console}`, admins: ['1000000001'] },
    })

    const body = written.join('')
    expect(body).not.toContain(SECRET.console)
    expect(body).toContain('«redacted')
    // 不该误伤：管理员名单要原样出去（键名不以 key/token/secret/password 结尾）
    expect(body).toContain('1000000001')
  })

  it('grep 整个 $DSH_HOME：五个假密钥零命中，且每行都是合法 JSON', () => {
    const dshHome = process.env.DSH_HOME ?? ''
    expect(dshHome, '测试隔离必须接管 DSH_HOME').not.toBe('')

    const tree = readTree(dshHome)
    for (const secret of ALL_SECRETS) {
      expect(tree, `密钥泄漏进 $DSH_HOME：${secret}`).not.toContain(secret)
    }

    // 审计行必须能一行一条地解析（否则"零命中"可能只是没写进去）
    const auditText = readTree(auditDir())
    const lines = auditText.split('\n').filter((line) => line.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const parsed = JSON.parse(line) as { at?: unknown }
      expect(typeof parsed.at).toBe('string')
    }
  })
})