/**
 * 能力隔离验收（T7）—— 本项目**整套安全设计的地基**。
 *
 * 对应 spec §8 的 T1 / T2 / T3。三条断言：
 *   T1  能力裁剪：普通 preset 里**不存在** shell 工具行
 *   T2  管理员私聊才有 shell
 *   T3  群聊永不获得 shell
 *   T40 助理全能力（fs / 任务 / 子代理 / 工作流）同样只允许 admin（2026-09-26 扩容，见下）
 *
 * 本文件的写法是**白名单式**：不是"检查已知的两个 preset 没有 shell"，
 * 而是"**只有** xiaoyan-admin 允许有 shell"。这样以后新增第四个 preset 时
 * 若忘了隔离，测试会失败，而不是悄悄放行。
 *
 * 另有一条**反向验证**：确认检测器本身有效（在 admin 上应当检出 shell）。
 * 否则一个"永远返回空"的检测器会让所有断言假绿 —— 那正是 spec §7.3 反例的精神。
 *
 * ⚠️ 运行时那一半（哪个账号的哪类会话拿到哪个 preset）要等 T11 的 bridge 才能测；
 *    此处是**静态能力构成**的验收。两者的关系：构成正确是前提，分配正确是后一步。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = join(import.meta.dirname, '..', '..')
const PRESETS_DIR = join(ROOT, 'presets')

/**
 * 能让 preset 在**本机执行命令**的包。只允许出现在 `SHELL_ALLOWED` 里。
 *
 * 列得宽是有意的：漏一个包就等于漏一个绕过路径。新增 shell 相关插件时
 * 应把它加进这张表，然后测试会在不该出现的地方报错。
 */
const SHELL_PACKAGES = new Set([
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-pwsh-local',
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-terminal',
])

/** **唯一**被允许具备 shell 的 preset。 */
const SHELL_ALLOWED = 'xiaoyan-admin'

/**
 * 助理全能力的行包名（T40；`scripts/build-presets.mjs` 的 `ASSISTANT_ROWS`）。
 * 纪律与 SHELL_PACKAGES 相同：只有 `SHELL_ALLOWED` 允许命中这些行。
 *
 * 注意 `tool-subagent` 一份包名对应**两行**（spawn / fork 两种 config），
 * `list-agents` 的 name 带子路径 —— 所以清单里 control 系有两条条目。
 */
const ASSISTANT_PACKAGES = new Set([
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent-control/list-agents',
  '@deepseek-ai/dsh-tool-workflow',
])

/**
 * 发布版 `@deepseek-ai/dsh-base@0.1.5-rc.3` 装配树里**全部 16 行 `tool-*`**。
 *
 * 来源不是记忆：`dsh plugin --profile bare add @deepseek-ai/dsh-base` +
 * `dsh --profile bare --dump-config`（2026-10-04 在镜像里导出的那份）。
 * ⚠️ 换 dsh 版本时要**重新导一次这份清单**——下面两个方向都靠它：
 *   · base 有而我们没禁 → host 行泄漏给每个 agent（能力面失控）；
 *   · 我们禁了而 base 没有 → **静默不生效**（patch 的 id 对不上不报错），
 *     这正是旧清单里 `tool-str-replace-editor` / `tool-subagent-report` 的形状：
 *     它们只存在于内核检出，发布版没有，写着等于没写。
 */
const RC3_BASE_TOOL_ROWS = [
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-skill',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-list-agents',
  'tool-subagent-control',
  'tool-workflow',
  'tool-result-pruner',
  'tool-todo',
  'tool-goal',
  'tool-ralph',
  'tool-web',
]

/**
 * **只在内核检出里存在**的 `tool-*` 行：发布版 0.1.5-rc.3 没这两个 id，
 * 但检出那棵树由 base 自己声明着它们 —— 所以对应的 disable 行**不能删**，
 * 删了就是把它们放给 agent（2026-10-04 在本机 `--dump-config` 里验到过：两行都还在装配里）。
 * 代价是 dsh 打两句 `patch: entry … not found` 警告，认了。
 * 本机迁到发布版 CLI 之后，这两条连同本清单一起删掉。
 */
const CHECKOUT_ONLY_TOOL_ROWS = ['tool-str-replace-editor', 'tool-subagent-report']

/** 三个模式 preset（`presets/` 下以 xiaoyan- 开头的目录）。 */
const MODE_PRESETS = readdirSync(PRESETS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('xiaoyan-'))
  .map((e) => e.name)
  .sort()

interface Row {
  id?: string
  name?: string
  group?: boolean
  config?: unknown
  disabled?: unknown
}

/** 展平 preset 的行树（group 行的 config 是子行数组）。 */
function flattenRows(value: unknown, out: Row[] = []): Row[] {
  if (!Array.isArray(value)) return out
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const row = item as Row
    out.push(row)
    // group 行的 config 是子行数组；即便当前生成的 preset 没有 group，也照展平，
    // 免得以后有人用 group 把 shell 藏进去。
    if (Array.isArray(row.config)) flattenRows(row.config, out)
  }
  return out
}

function loadRows(preset: string): Row[] {
  const file = join(PRESETS_DIR, preset, 'agent.cordis.yml')
  return flattenRows(parse(readFileSync(file, 'utf8')))
}

/** 检测器：一个 preset 里所有 shell 相关的行。 */
function shellRows(rows: Row[]): Row[] {
  return rows.filter((r) => typeof r.name === 'string' && SHELL_PACKAGES.has(r.name))
}

const rowsByPreset = new Map(MODE_PRESETS.map((p) => [p, loadRows(p)]))

describe('T7 —— preset 文件本身可解析', () => {
  it('至少存在三个模式 preset', () => {
    expect(MODE_PRESETS.length).toBeGreaterThanOrEqual(3)
  })

  it.each(MODE_PRESETS)('%s 的 agent.cordis.yml 是合法的行数组', (preset) => {
    const rows = rowsByPreset.get(preset) ?? []
    expect(rows.length).toBeGreaterThan(0)
    // 每行都该有 id 与 name（生成器保证；手改破坏了这里会报错）
    for (const row of rows) {
      expect(row.id, `${preset} 有行缺少 id`).toBeTruthy()
      expect(row.name, `${preset} 有行缺少 name`).toBeTruthy()
    }
  })
})

describe('T7 —— 反向验证：检测器本身有效', () => {
  it('检测器能在 xiaoyan-admin 上检出 shell（否则下面的断言会假绿）', () => {
    const found = shellRows(rowsByPreset.get(SHELL_ALLOWED) ?? [])
    expect(found.length).toBeGreaterThan(0)
    // ⚠️ 查的是**工具行**（`tool-bash`），不是 shell 的**提供者**（`dsh-bash-local`）——
    // 提供者现在在 **host 平面**（bundle patch 的 `bash` 行）。原因见 ADR 0013：
    // ① `permission-presets` 等 host 行依赖 `shell` 服务，把提供者放进 preset 会让
    //    host 侧 pending；② preset 里再声明一个会**撞服务名**（mount 失败）。
    // host 侧的那一半由本文件末尾的「host 平面的能力裁剪」钉住。
    expect(found.map((r) => r.name)).toContain('@deepseek-ai/dsh-tool-bash')
  })

  it('检测器对纯人格 preset 返回空（不是永远返回空，而是真的在判断）', () => {
    // 用一个构造出来的行集验证：含 shell 名称 → 检出；不含 → 空
    expect(shellRows([{ name: '@deepseek-ai/dsh-bash-local' }])).toHaveLength(1)
    expect(shellRows([{ name: '@deepseek-ai/dsh-persona' }])).toHaveLength(0)
  })
})

describe('T1 / T3 —— 只有 xiaoyan-admin 可以具备 shell', () => {
  it.each(MODE_PRESETS)('%s', (preset) => {
    const found = shellRows(rowsByPreset.get(preset) ?? [])
    if (preset === SHELL_ALLOWED) {
      // admin 必须有（T2 的能力侧）
      expect(found.length, `${preset} 应当有 shell 行`).toBeGreaterThan(0)
    } else {
      // 其余任何 preset 一个 shell 行都不许有（T1 / T3）
      expect(
        found.map((r) => `${r.id}(${r.name})`),
        `${preset} 不应含任何 shell 行`,
      ).toEqual([])
    }
  })

  it('shell 行没有被 disabled 之外的机制隐藏：admin 的 tool-bash 行是启用的', () => {
    const admin = rowsByPreset.get(SHELL_ALLOWED) ?? []
    const bash = admin.find((r) => r.name === '@deepseek-ai/dsh-tool-bash')
    expect(bash).toBeDefined()
    // disabled 若被显式设成 true，则"有这行"就名不副实
    expect(bash?.disabled).not.toBe(true)
  })
})

/**
 * T40 —— 助理全能力只允许 xiaoyan-admin。
 *
 * 2026-09-26 用户拍板"Agent 能力全开"（handoff §三）：admin preset 从 4 行扩到
 * **15 行**（`ASSISTANT_ROWS`，`scripts/build-presets.mjs`）。白名单纪律与上面
 * 的 shell 一族相同 —— 其余 preset 一个都不许有，忘了隔离就会红。
 *
 * 实测记录（2026-09-26，隔离实例 8081 + `spike/extract-tools.mjs` 读
 * `request/header.tools` —— 权威证据是模型真实收到的工具表，不是本文件）：
 *   admin 会话模型可见工具共 **20 个** —— bash / create_goal / edit / get_goal /
 *   glob / grep / interrupt_agent / list_agents / read / read_image / send_message /
 *   str_replace_editor / subagent / subagent_fork / todo_write / update_goal /
 *   web_fetch / web_search / workflow / write（旧版 shell + web 只有 3 个）。
 *   行 → 工具的展开由 DSH 决定，静态测试钉住的是**行集合**本身。
 */
describe('T40 —— 助理全能力（fs / 任务 / 子代理 / 工作流）只允许 xiaoyan-admin', () => {
  const assistantRows = (preset: string): Row[] =>
    (rowsByPreset.get(preset) ?? []).filter(
      (r) => typeof r.name === 'string' && ASSISTANT_PACKAGES.has(r.name),
    )

  it('反向验证：检测器在 admin 上检出全部 10 行（包名拼错会让下面的断言假绿）', () => {
    // 10 而不是 11：`tool-subagent-report` 在 2026-10-04 随基线迁到发布版 0.1.5-rc.3 时删了
    // （那条包线停在 0.1.2-alpha.3，rc.3 的 subagent-control 也没有 ./report 导出）。
    expect(assistantRows(SHELL_ALLOWED).length, 'admin 应检出 10 行（subagent 含 spawn/fork 两行）').toBe(10)
  })

  it.each(MODE_PRESETS.filter((p) => p !== SHELL_ALLOWED))('%s 不含任何助理全能力行', (preset) => {
    expect(
      assistantRows(preset).map((r) => `${r.id}(${r.name})`),
      `${preset} 不应含任何助理全能力行`,
    ).toEqual([])
  })

  it('admin 的行集合恰好是那 14 行（防悄悄增删能力）', () => {
    const ids = (rowsByPreset.get(SHELL_ALLOWED) ?? []).map((r) => r.id).sort()
    expect(ids).toEqual(
      [
        'persona',
        'tool-bash',
        'tool-fs',
        'tool-fs-search',
        'tool-goal',
        'tool-str-replace-editor',
        'tool-subagent',
        'tool-subagent-control',
        'tool-subagent-fork',
        'tool-subagent-list-agents',
        'tool-todo',
        'tool-web',
        'tool-workflow',
        'url-guard',
      ].sort(),
    )
  })

  it('admin 的每一行都是启用的（不是"有行但被禁用"的名不副实）', () => {
    const hidden = (rowsByPreset.get(SHELL_ALLOWED) ?? []).filter((r) => r.disabled === true)
    expect(hidden.map((r) => r.id)).toEqual([])
  })
})

describe('纵深防御 —— 三个 preset 都必须带 URL 守卫', () => {
  it.each(MODE_PRESETS)('%s 含 url-guard', (preset) => {
    const names = (rowsByPreset.get(preset) ?? []).map((r) => r.name)
    expect(names).toContain('yanxin/src/net/url-guard.ts')
  })

  it.each(MODE_PRESETS)('%s 含 web 工具行，但**不**含 provider（provider 是进程级单例）', (preset) => {
    const names = (rowsByPreset.get(preset) ?? []).map((r) => r.name)
    expect(names).toContain('@deepseek-ai/dsh-tool-web')
    // 实测（ADR 0013）：两个 preset 各声明一份 provider 会让第二个挂载失败 ——
    //   a web provider with id "http" is already registered
    // 所以 provider 必须在 host 平面（下面那组断言钉住它）。
    expect(names).not.toContain('@deepseek-ai/dsh-web-fetch-http')
  })
})

/**
 * **host 平面**（bundle patch）的能力裁剪 —— ADR 0013 的回归护栏。
 *
 * 能力边界由**两处共同**决定，而此前只检查了前一处，所以全绿时隔离其实是失效的：
 *
 * | 平面 | 决定什么 | 在哪 |
 * |---|---|---|
 * | agent 平面 | 模型可见的**工具行** | `presets/xiaoyan-<模式>/agent.cordis.yml` |
 * | host 平面 | **服务提供者** + host 行的禁用 | `cordis.patch.yml` |
 *
 * 这一组断言的意义：**光看 preset 文件证明不了任何运行时能力** —— 那正是 ADR 0013
 * 那次失效的根源（preset 里一个 shell 行都没有，而模型手里有 `pwsh`）。
 */
describe('ADR 0013 —— host 平面的能力裁剪（bundle patch）', () => {
  const patch = parse(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')) as unknown

  /** 展平 patch 的顶层数组 + 每个 `insert` 的子行。 */
  function patchRows(): Row[] {
    const out: Row[] = []
    if (!Array.isArray(patch)) return out
    for (const entry of patch) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Row & { insert?: unknown }
      if (Array.isArray(row.insert)) flattenRows(row.insert, out)
      else out.push(row)
    }
    return out
  }

  const rows = patchRows()

  it('host 平面提供 Git Bash 作为 `shell` 服务（不是 pwsh 沙箱）', () => {
    // `permission-presets` 等 host 行依赖 `shell`；单纯禁掉提供者会让 boot 直接失败
    // （实测：dsh: 1 entry did not activate / waiting for service: shell）
    expect(rows.some((r) => r.name === '@deepseek-ai/dsh-bash-local')).toBe(true)
    const pwshSandbox = rows.find((r) => r.id === 'pwsh-sandbox')
    expect(pwshSandbox?.disabled, 'pwsh-sandbox 必须被禁用，否则与上面的 bash 抢 shell 服务名').toBe(true)
  })

  it('`permission-presets` 被禁用（它要求受限执行器，配非沙箱 bash 时不该装载）', () => {
    const permission = rows.find((r) => r.id === 'permission')
    expect(permission?.disabled).toBe(true)
  })

  it('host 平面提供 web provider（它是进程级单例，不能在 preset 里重复声明）', () => {
    // 发布版 dsh-base 0.1.5-rc.3 **自带** `- id: web-fetch-http`，我们只覆盖它的 config；
    // 早先我们自己插的那行叫 `web-fetch-provider`，与 base 那份撞成同一个插件两次实例化，
    // 容器起不来（2026-10-04）。所以这里查的是 base 的 id。
    expect(rows.some((r) => r.id === 'web-fetch-http' && r.name === '@deepseek-ai/dsh-web-fetch-http')).toBe(true)
  })

  it('plan-mode 被禁用（编码 agent 的工作流，且会往 prompt 注入规则）', () => {
    expect(rows.find((r) => r.id === 'plan-mode')?.disabled).toBe(true)
  })

  it.each(RC3_BASE_TOOL_ROWS)('host 行的 %s 被禁用（模型可见性只由 preset 决定）', (id) => {
    const row = rows.find((r) => r.id === id)
    expect(row, `bundle patch 里缺少对 ${id} 的禁用 —— host 行会泄漏给每个 agent`).toBeDefined()
    expect(row?.disabled).toBe(true)
  })

  it('反向验证：我们禁的每一行 tool-* 都在两份清单之一里（没有拼错的 id）', () => {
    const known = new Set([...RC3_BASE_TOOL_ROWS, ...CHECKOUT_ONLY_TOOL_ROWS])
    const disabledTool = rows.filter((r) => r.disabled === true && (r.id ?? '').startsWith('tool-')).map((r) => r.id ?? '')
    const dead = disabledTool.filter((id) => !known.has(id))
    expect(dead, `这些 tool-* 禁用行在两份清单里都不存在（id 拼错或基线已变）：${dead.join(', ')}`).toEqual([])
  })

  it('双向差集：发布版 16 行 + 检出独有 2 行，恰好等于我们的禁用集合', () => {
    // 单向断言会漏一半：只查"base 有的都被禁"漏掉拼错的 id；只查反向则漏掉上游新增的工具。
    const disabledTool = rows
      .filter((r) => r.disabled === true && (r.id ?? '').startsWith('tool-'))
      .map((r) => r.id ?? '')
      .sort()
    expect(disabledTool).toEqual([...RC3_BASE_TOOL_ROWS, ...CHECKOUT_ONLY_TOOL_ROWS].sort())
  })
})

describe('人格是完整 system prompt（不混入编码 agent 引导语）', () => {
  it.each(MODE_PRESETS)('%s 的 persona 行声明 complete: true', (preset) => {
    const persona = (rowsByPreset.get(preset) ?? []).find((r) => r.name === '@deepseek-ai/dsh-persona')
    expect(persona, `${preset} 缺少 persona 行`).toBeDefined()
    const config = persona?.config as { complete?: unknown; includeRuntimeContext?: unknown } | undefined
    expect(config?.complete).toBe(true)
    expect(config?.includeRuntimeContext).toBe(false)
  })

  it.each(MODE_PRESETS)('%s 的人格文本完整来自 persona/（单一来源，任何手工改动都会破）', (preset) => {
    const persona = (rowsByPreset.get(preset) ?? []).find((r) => r.name === '@deepseek-ai/dsh-persona')
    const text = String((persona?.config as { prefix?: unknown } | undefined)?.prefix ?? '')

    /** 源文件内容（读取方式与 `build-presets.mjs` 一致：trim 后拼进 prompt）。 */
    const source = (name: string): string =>
      readFileSync(join(import.meta.dirname, '..', '..', 'persona', name), 'utf8').trim()

    // ⚠️ 断言**源文件全文**都在，而不是某句"特征句"：
    // 硬编码特征句（曾用「带班的老师」）会在内容微调时**假失败** —— 而它真正要防的是
    // "preset 与 persona/ 漂移"（有人手改生成物、或改了源文件忘了重跑生成脚本）。
    // 全文比对把这件事测准：内容随便改，只要重跑过 build-presets.mjs 就是绿的。
    expect(text, `${preset} 缺少 base.md 的内容`).toContain(source('base.md'))
    expect(text, `${preset} 缺少 profile.md 的内容`).toContain(source('profile.md'))
  })
})

describe('T26 —— 世界工具只在 xiaoyan-world 里（她"伸手"的地方不外借）', () => {
  const WORLD_TOOLS = 'yanxin/src/world/tools.ts'

  it('⭐ xiaoyan-world 有世界工具行；群聊与助理**都看不到**', () => {
    const rowsOf = (preset: string): { name?: string }[] => rowsByPreset.get(preset) ?? []

    expect(
      rowsOf('xiaoyan-world').some((row) => row.name === WORLD_TOOLS),
      'xiaoyan-world 缺少世界工具行（重跑 build-presets.mjs？）',
    ).toBe(true)

    for (const preset of MODE_PRESETS.filter((item) => item !== 'xiaoyan-world')) {
      expect(
        rowsOf(preset).some((row) => row.name === WORLD_TOOLS),
        `${preset} 不该有世界工具 —— 那些动词（act/say/note）只属于"她过着日子"的那个会话`,
      ).toBe(false)
    }
  })
})
