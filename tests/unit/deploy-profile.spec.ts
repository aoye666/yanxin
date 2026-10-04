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
import OneBotBridge from '../../src/onebot/bridge.ts'
import OneBotService from '../../src/onebot/service.ts'
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
  '{{ONEBOT_TOKEN}}': '123456', // 纯数字是**有意的**：裸插进 YAML 会被读成 number，服务器实测炸过
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

/**
 * 一份 patch 里**所有**被声明/覆盖的行 id（含 `insert:` 段里嵌的那些）。
 *
 * 为什么不用正则：注释里的示例形状（`# - id: cordis`）会被正则一并收下，
 * 于是"id 打错"的那条检查会**因为一条注释而通过** —— 那正是它要抓的错。
 */
function rowIds(yamlText: string): Set<string> {
  const ids = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const entry = value as Record<string, unknown>
    if (typeof entry.id === 'string') ids.add(entry.id)
    // `insert:` 段的值是"要插进去的行列表"，那些 id 同样真实存在
    if ('insert' in entry) walk(entry.insert)
    if ('config' in entry && Array.isArray(entry.config)) walk(entry.config)
  }
  walk(parse(yamlText))
  return ids
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
    expect(accounts?.[0]?.selfId, 'selfId 必须是 string：QQ 号是纯数字，裸插会被 YAML 读成 number').toBe(
      SAMPLE['{{SELF_ID}}'],
    )
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
    const bundleIds = rowIds(BUNDLE)
    const unknown = [...rowIds(fill(TEMPLATE, SAMPLE))].filter((id) => !bundleIds.has(id))
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

// ── Docker 形态的模板 ───────────────────────────────────────────────────────
//
// 它是 `docker/entrypoint.mjs` 的原料，也是"拉起来就能用"那条路的装配本体。
// 上面那五条纪律一条都不能松 —— 差别只在**值**（绑地址、记忆 provider），
// 以及多出来的一段 host 平面裁剪（Linux 上 `bash-sandbox` 不再被平台门关掉，ADR 0013）。

const DOCKER_TEMPLATE = readFileSync(join(ROOT, 'deploy', 'profile.docker.cordis.patch.yml'), 'utf8')

/** 与 entrypoint 的 values 表同一份键名 —— 两边不一致就红（这条正是本轮飘移检查要的东西）。 */
const DOCKER_SAMPLE: Record<string, string> = {
  '{{WEB_HOST}}': '0.0.0.0',
  '{{WEB_PORT}}': '3080',
  '{{ONEBOT_HOST}}': '0.0.0.0',
  '{{ONEBOT_PORT}}': '8080',
  '{{ONEBOT_PATH}}': '/onebot/v11',
  '{{ONEBOT_TOKEN}}': '123456', // 纯数字是**有意的**：裸插进 YAML 会被读成 number，服务器实测炸过
  '{{SELF_ID}}': '2000000002',
  // 绑号那两行由 entrypoint 整段生成（样本 = 已绑那种形态）。
  '{{IDENTITY_LINES}}':
    '    selfId: "2000000002"\n    # 注册表：这个 QQ 号的会话挂哪套能力\n    accounts:\n      - selfId: "2000000002"\n        preset: xiaoyan-agent',
  '{{WORKSPACE}}': '/home/node/.dsh/yanxin/workspace',
  '{{WORLD_GROUP_ID}}': '0',
  '{{MEMORY_PROVIDER}}': 'reme',
}

function fill(text: string, table: Record<string, string>): string {
  let out = text
  for (const [token, value] of Object.entries(table)) out = out.split(token).join(value)
  return out
}

function dockerRendered(): string {
  return fill(DOCKER_TEMPLATE, DOCKER_SAMPLE)
}

/**
 * `@deepseek-ai/dsh-base` 自己拥有的行 —— profile 层按 id 覆盖它们**不需要**本仓先声明。
 *
 * 这份清单存在的意义是让上面那条"id 必须真实存在"的检查在 Docker 模板上同样有意义：
 * 认错一个 base 行 id 的症状是静默不生效，而 `bash-sandbox` 这一行管的正是
 * "容器里那个非沙箱 shell 到底有没有被禁掉"。
 */
const BASE_OWNED_ROWS = new Set(['bash-sandbox'])

describe('部署模板 profile.docker.cordis.patch.yml（容器形态）', () => {
  it('占位符全部在渲染器的替换表里（漏一个 = 容器起来带一份半成品配置）', () => {
    const left = [...new Set((DOCKER_TEMPLATE.match(/\{\{[A-Z_]+\}\}/g) ?? []))].filter(
      (token) => !(token in DOCKER_SAMPLE),
    )
    expect(left, `模板里有 entrypoint 不认识的值：${left.join(' ')}`).toEqual([])
  })

  it('覆盖的行 id 都真实存在（本仓 bundle patch 或 dsh-base）', () => {
    const known = rowIds(BUNDLE)
    const unknown = [...rowIds(dockerRendered())].filter((id) => !known.has(id) && !BASE_OWNED_ROWS.has(id))
    expect(unknown, `这些 id 在两边都不存在：${unknown.join(' ')}`).toEqual([])
  })

  it('⭐ 记忆 provider 必须真的写进行 config（缺了这一行 = 她静默失忆，且没有 warn）', () => {
    // 代码缺省是 'none'（src/memory/service.ts），三级回退 settings → 行 config → 缺省。
    // 所以"镜像里 ReMe 起来了"和"记忆线可用"是两件事 —— 这一条把后者钉死。
    // ⚠️ 行 id 是 `memory`；`yanxin-memory` 只是 settings 的命名空间名，装配树里没这一行。
    const memory = overrides(dockerRendered()).get('memory')
    expect(memory, 'profile 层必须有 memory 这一段（行 id 不是 yanxin-memory）').toBeDefined()
    expect(memory?.provider).toBe('reme')
    expect(String(memory?.endpoint)).toBe('http://127.0.0.1:2333')
  })

  it('⭐ 未绑号的首启也得起得来：不写 selfId，accounts 留空表', () => {
    // 这就是 `docker run` 第一次跑的真实形态（还没给 YANXIN_SELF_ID）。
    // 旧写法把 `selfId:` 和一条空的 accounts 条目照样渲染出去，cordis 的 schema 判
    // `$.accounts[0].selfId missing required value` → **整个 profile 挂载失败**，
    // 于是"拉取就能用"在最常见的第一次启动上不成立（2026-10-04 真机验收撞到）。
    const unbound = fill(DOCKER_TEMPLATE, {
      ...DOCKER_SAMPLE,
      '{{IDENTITY_LINES}}': '    # 还没绑号（在控制台的初始化向导里做）\n    accounts: []',
    })
    const onebot = overrides(unbound).get('onebot')
    expect(onebot, 'onebot 段必须在').toBeDefined()
    expect(onebot, '未绑号就不该出现 selfId 这个键').not.toHaveProperty('selfId')
    expect(onebot?.accounts).toEqual([])

    // 反向也要成立：绑了却没写 accounts 等于这个号挂不上任何能力
    const bound = overrides(dockerRendered()).get('onebot')
    expect(bound?.selfId, 'selfId 必须是 string：QQ 号裸插会被 YAML 读成 number → profile 挂不上').toBe('2000000002')
    expect(bound?.accounts).toEqual([{ selfId: '2000000002', preset: 'xiaoyan-agent' }])
    expect(bound?.token, '纯数字 token 渲染后必须是 string（服务器第一次公网部署就是炸在这）').toBe('123456')

    // entrypoint 那两条分支得和上面的样本同形（改一边忘另一边 = 交付时才是第一次真跑）
    const entry = readFileSync(join(ROOT, 'docker', 'entrypoint.mjs'), 'utf8')
    expect(entry, "entrypoint 必须仍然渲染 '{{IDENTITY_LINES}}'").toContain("'{{IDENTITY_LINES}}'")
    expect(entry, '未绑号那条分支要给空表').toContain('accounts: []')
    expect(entry, '未绑号那条分支不能写 selfId').not.toMatch(/selfId: \$\{selfId\}\n\s*# 还没绑号/)
    expect(entry, '绑号那两条 selfId 都必须走 esc（带引号），裸插值会被 YAML 定型成 number').toContain(
      'selfId: "${esc(selfId)}"',
    )
  })

  it('⭐ 非沙箱 shell 的边界：bash-local 保留（带完整 config），只禁 bash-sandbox', () => {
    const map = overrides(dockerRendered())

    // 用户口径是"继续用 bash-local" —— 禁掉它她就没有 shell 了。
    // ⚠️ profile 层是**整字段覆盖**，所以这一行必须把三键写全（少写一键就是把 bundle 的行
    // 定义抹成代码缺省），与本机版的形态一致。
    const bash = map.get('bash')
    expect(bash, '容器版必须带 bash 的 cwd（否则她的文件足迹散进 /app）').toBeDefined()
    expect(bash?.cwd).toBe('/home/node/.dsh/yanxin/workspace')
    expect(Number(bash?.timeoutMs)).toBeGreaterThan(0)
    expect(Number(bash?.maxOutputBytes)).toBeGreaterThan(0)
    expect(bash).not.toHaveProperty('disabled')

    // 容器里真正要禁的是它：Linux 上 base 的 win32 平台门不成立，
    // 不显式禁就会与 bash-local 抢 `shell` 服务名（ADR 0013 那个坑的镜像版本）
    // ⚠️ 读**渲染后**的那份：模板里 `{{IDENTITY_LINES}}` 独占一行，未渲染时整份不是合法 YAML。
    const sandbox = parse(dockerRendered()).find((entry: { id?: string }) => entry?.id === 'bash-sandbox') as
      | { disabled?: unknown }
      | undefined
    expect(sandbox, '模板必须带 bash-sandbox 的禁用行').toBeDefined()
    expect(sandbox?.disabled).toBe(true)
  })

  it('三处 cwd 一致（与本机版同一条纪律，容器版换了根路径）', () => {
    const map = overrides(dockerRendered())
    const cwdOf = (id: string) => map.get(id)?.cwd as string | undefined
    const bridge = cwdOf('onebot-bridge')
    expect(bridge, 'onebot-bridge 要有 cwd').toBeTypeOf('string')
    expect(cwdOf('bash'), 'bash 段必须带 cwd').toBe(bridge)
  })

  it('绑地址是占位符而不是硬编码（只绑回环跑不通；写死 0.0.0.0 又关不掉）', () => {
    expect(DOCKER_TEMPLATE).toContain('host: {{WEB_HOST}}')
    expect(DOCKER_TEMPLATE).toContain('host: {{ONEBOT_HOST}}')
  })

  it('与本机版覆盖同一批行，只多容器形态必需的三段；两边都不带密钥字面量', () => {
    const machineIds = rowIds(fill(TEMPLATE, SAMPLE))
    const dockerIds = rowIds(dockerRendered())
    // 多出来的三段各有理由：
    //   · web-server —— 容器里绑回环等于没有控制台
    //   · memory —— provider 的代码缺省是 none，容器形态要显式打开（本机形态让用户自己开）
    //   · bash-sandbox —— Linux 上 base 的 win32 平台门不成立，不显式禁就会抢注 `shell`
    expect([...dockerIds].filter((id) => !machineIds.has(id)).sort()).toEqual([
      'bash-sandbox',
      'memory',
      'web-server',
    ])
    // 反向也要成立：容器版不能悄悄**少**装本机版的某一段（少一段 = 那条部署值没人读）
    expect([...machineIds].filter((id) => !dockerIds.has(id))).toEqual([])

    for (const [name, text] of [
      ['本机版', TEMPLATE],
      ['容器版', DOCKER_TEMPLATE],
    ] as const) {
      const valueLines = text.split('\n').filter((line) => !line.trimStart().startsWith('#'))
      const suspicious = valueLines.filter((line) =>
        /(key|token|secret|password|passwd|pwd|credential)\s*[:=]\s*['"]?(?!\{\{)[A-Za-z0-9_-]{8,}/i.test(line),
      )
      expect(suspicious, `${name}模板里有像内联密钥的行：\n${suspicious.join('\n')}`).toEqual([])
    }
  })
})

// ── 键的**行归属**（防"放错行"）────────────────────────────────────────────
//
// 上面那些检查比的是"段落有没有缺"，抽不到这一类错：键写得对，但挂在**别的行**上。
// patch 既没有深度合并、也不校验键归属 —— 挂错行的症状是"配置看着在，实际一路静默
// 落回代码缺省"。容器版就这么把 `groupTrigger: name` 写在 `onebot`（传输层）行里过，
// 线上表现为名字触发完全不生效，而日志一个字都不报。
//
// 名单不在这里抄一遍：**读两个插件自己声明的 config schema**。改了代码里的键，
// 这条检查跟着变；只有"挂错行"才会红。

/** schemastery 的对象类型把字段放在 `dict` 上（探针实测，非公开签名）。 */
function schemaKeys(schema: unknown): Set<string> {
  const dict = (schema as { dict?: Record<string, unknown> }).dict
  return new Set(Object.keys(dict ?? {}))
}

const BRIDGE_KEYS = schemaKeys(OneBotBridge.Config)
const TRANSPORT_KEYS = schemaKeys(OneBotService.Config)

/**
 * `onebot` 行里**已知没人读**的键。
 *
 * `selfId` 是两份模板都写的一行，但 `onebot` 的 schema 里只有 `accounts[]`（路由靠它）。
 * 它今天是无害的冗余，删它属于改部署形态（要连 entrypoint 一起动），不在这条检查里顺手做。
 */
const KNOWN_DEAD_KEYS = new Set(['selfId'])

describe('部署模板 —— 键必须挂在认得它的行上', () => {
  const both = (): Array<[string, Map<string, Record<string, unknown>>]> => [
    ['本机版', overrides(fill(TEMPLATE, SAMPLE))],
    ['容器版', overrides(dockerRendered())],
  ]

  it('⭐ 桥的键（dryRun / groupTrigger / 分段那几个）一个都不许出现在 onebot 行', () => {
    for (const [name, map] of both()) {
      const misplaced = Object.keys(map.get('onebot') ?? {}).filter((key) => BRIDGE_KEYS.has(key))
      expect(misplaced, `${name}：这些桥的键挂到了传输层行 onebot 上，会被静默忽略：${misplaced.join(' ')}`).toEqual([])
    }
  })

  it('onebot / onebot-bridge 两行的键都在各自 schema 里（拼错的键同样是静默失效）', () => {
    for (const [name, map] of both()) {
      const unknownBridge = Object.keys(map.get('onebot-bridge') ?? {}).filter((key) => !BRIDGE_KEYS.has(key))
      expect(unknownBridge, `${name}：onebot-bridge 写了它不认的键：${unknownBridge.join(' ')}`).toEqual([])

      const unknownTransport = Object.keys(map.get('onebot') ?? {}).filter(
        (key) => !TRANSPORT_KEYS.has(key) && !KNOWN_DEAD_KEYS.has(key),
      )
      expect(unknownTransport, `${name}：onebot 写了它不认的键：${unknownTransport.join(' ')}`).toEqual([])
    }
  })

  it('容器版那四个部署值真的挂在 onebot-bridge 上（漏一项 = 该项没人读）', () => {
    const bridge = overrides(dockerRendered()).get('onebot-bridge') ?? {}
    for (const key of ['dryRun', 'contextMessages', 'groupTrigger', 'maxReplyChars']) {
      expect(bridge, `onebot-bridge 少了 ${key}`).toHaveProperty(key)
    }
    // 而这一行必须是**整段重写**过的形态：cwd 也在一起（见文件头的整字段覆盖纪律）
    expect(bridge).toHaveProperty('cwd')
  })
})
