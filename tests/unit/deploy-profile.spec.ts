/**
 * 部署模板的静态校验（开源包的"装得上"证据）。
 *
 * `deploy/profile.example.cordis.patch.yml` 是 `scripts/install.mjs` 渲染的原料，
 * 也是新手唯一会照着改的文件 —— 它一旦写错，症状是**别人的实例起不来**，
 * 而错误信息（DSH 的 schema 校验）离真正的原因隔着一层。所以这四条在仓里就断掉：
 *
 *   1. 占位符**全部**能被替换（漏一个开关 = 交付一份带 `{{…}}` 的配置）
 *   2. YAML 解析得过，且 onebot 的**必填键**齐（`port` 缺 → 启动即失败）
 *   3. 三处 `cwd` 完全一致（世界线漏 cwd 会把内核的工程指令喂进她的内心独白）
 *   4. 覆盖的行 id 在 bundle patch 里**真实存在**（id 打错 = 静默不生效）
 *
 * 外加一条纪律性的：模板里不许出现任何**像密钥的字面量**（它是要入库的）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = join(import.meta.dirname, '../..')
const TEMPLATE = readFileSync(join(ROOT, 'deploy', 'profile.example.cordis.patch.yml'), 'utf8')
const BUNDLE = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

/** 与 `scripts/install.mjs` 的 render() 同一张替换表 —— 两边不一致就红。 */
const SAMPLE: Record<string, string> = {
  '{{SELF_ID}}': '2000000002',
  '{{ONEBOT_PORT}}': '8080',
  '{{ONEBOT_PATH}}': '/onebot/v11',
  '{{ONEBOT_TOKEN}}': 'sample-token-not-a-secret',
  '{{WEB_PORT}}': '3080',
  '{{WORKSPACE}}': 'C:/example/yanxin/workspace',
  '{{WORLD_GROUP_ID}}': '3000000003',
  '{{WORLD_PROVIDER}}': 'example-llm',
  '{{WORLD_MODEL}}': 'example-model',
}

function rendered(): string {
  let text = TEMPLATE
  for (const [token, value] of Object.entries(SAMPLE)) text = text.split(token).join(value)
  return text
}

/** 把 `- id: x` 的覆盖块摊平成 `{ id -> config }`。 */
function overrides(yamlText: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  for (const entry of parse(yamlText) as Array<{ id?: string; config?: Record<string, unknown> }>) {
    if (entry?.id !== undefined) out.set(entry.id, entry.config ?? {})
  }
  return out
}

describe('部署模板 profile.example.cordis.patch.yml', () => {
  it('占位符全部在替换表里（漏一个 = 交付一份半成品配置）', () => {
    const left = [...new Set((TEMPLATE.match(/\{\{[A-Z_]+\}\}/g) ?? []))].filter((t) => !(t in SAMPLE))
    expect(left, `模板里有 install.mjs 不认识的占位符：${left.join(' ')}`).toEqual([])
  })

  it('渲染后 YAML 解析得过，且 onebot 的必填键齐', () => {
    const onebot = overrides(rendered()).get('onebot')
    expect(onebot, 'profile 层必须有 onebot 这一段（bundle 里故意不给 config）').toBeDefined()
    // port 是 z.natural().required() —— 缺了就是"启动即校验失败"，这一条最值钱
    expect(Number(onebot?.port)).toBeGreaterThan(0)
    expect(onebot?.host).toBe('127.0.0.1') // 只绑回环
    expect(typeof onebot?.token).toBe('string')
    expect(onebot?.token).not.toBe('')
    const accounts = onebot?.accounts as Array<Record<string, unknown>> | undefined
    expect(accounts, 'accounts[] 空着的话任何连接都会被拒').toBeInstanceOf(Array)
    expect(accounts?.length ?? 0).toBeGreaterThan(0)
    expect(String(accounts?.[0]?.selfId)).toBe(SAMPLE['{{SELF_ID}}'])
    expect(['xiaoyan-agent', 'xiaoyan-admin', 'xiaoyan-world']).toContain(String(accounts?.[0]?.preset))
  })

  it('⭐ 三处 cwd 完全一致（世界线漏了这一行，她的内心独白会混进内核的 AGENTS.md）', () => {
    const map = overrides(rendered())
    const cwdOf = (id: string) => map.get(id)?.cwd as string | undefined
    const bridge = cwdOf('onebot-bridge')
    expect(bridge, 'onebot-bridge 要有 cwd').toBeTypeOf('string')
    // bash 与 world-engine 只在"这一版启用了 shell / 世界线"时才要求带 cwd
    expect(cwdOf('bash'), 'bash 段必须带 cwd，否则 shell 落在 DSH 的启动目录').toBe(bridge)
    expect(cwdOf('yanxin-world-engine'), '世界引擎必须带 cwd').toBe(bridge)
  })

  it('覆盖的行 id 在 bundle patch 里真实存在（id 打错 = 静默不生效）', () => {
    const bundleIds = new Set((BUNDLE.match(/- id: ([a-z0-9-]+)/g) ?? []).map((s) => s.replace('- id: ', '')))
    const unknown = [...overrides(rendered()).keys()].filter((id) => !bundleIds.has(id))
    expect(unknown, `这些 id 在 bundle patch 里不存在：${unknown.join(' ')}`).toEqual([])
  })

  it('模板里没有密钥形态的字面量（这份是要入库的）', () => {
    // 只看非注释行：注释里的举例（`?tavilyApiKey=…`）是纪律说明，不是值
    const valueLines = TEMPLATE.split('\n').filter((line) => !line.trimStart().startsWith('#'))
    const suspicious = valueLines.filter((line) =>
      /(key|token|secret|password|passwd|pwd|credential)\s*[:=]\s*['"]?(?!\{\{)[A-Za-z0-9_-]{8,}/i.test(line),
    )
    expect(suspicious, `这些行像内联密钥：\n${suspicious.join('\n')}`).toEqual([])
  })
})
