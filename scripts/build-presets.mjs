/**
 * 从 persona/*.md 生成三个 preset 的 agent.cordis.yml。
 *
 * **为什么需要生成而不是手写**：三个 preset（agent / admin / world）共享同一份人格基底，
 * 手写就是三份拷贝 —— 改一处要记得改三处，必然漂移。spec §6.4 的设计是
 * "分叉的是 prompt 模板与可用工具，不是人格本身"，所以人格必须是**单一来源**。
 *
 * 正式的落点是 spec 的 T29（setup 服务：状态机 + 落盘 + 控制台可改）。
 * 本脚本是它的最小前身：先把"单一来源"这件事做对，T29 再把状态机与控制台接上。
 *
 * 用法：node scripts/build-presets.mjs
 *
 * ⚠️ 生成的 agent.cordis.yml 是**产物**，不要手改 —— 手改会在下次生成时被覆盖。
 *    要改内容请改 persona/*.md。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRESETS = join(ROOT, 'presets')

function readPersona(name) {
  return readFileSync(join(ROOT, 'persona', name), 'utf8').trim()
}

const base = readPersona('base.md')
const profile = readPersona('profile.md')
const world = readPersona('world.md')

/** 把一段多行文本缩进成 YAML 块标量的一行行内容。 */
function block(text, indent) {
  const pad = ' '.repeat(indent)
  return text
    .split('\n')
    .map((line) => (line.length ? pad + line : ''))
    .join('\n')
}

/** 人格行：complete: true 让这段成为完整 system prompt。 */
function personaRow(text) {
  return `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    complete: true
    includeRuntimeContext: false
    text: |-
${block(text, 6)}`
}

/** 出网抓取能力 + 我们自己的 SSRF 守卫。三个 preset 都需要。 */
const WEB_ROWS = `# web 抓取工具。
#
# ⚠️ **provider 不在这里声明** —— web provider 是**进程级单例**，由 host 平面的
#    'web-fetch-provider' 行提供（见 cordis.patch.yml）。base 只组合了
#    dsh-web / dsh-web-search-deepseek，**没有** dsh-web-fetch-http，所以要我们自己补；
#    但补在 preset 里会让**第二个被挂载的 preset 失败**：
#      preset "xiaoyan-agent" failed to mount: a web provider with id "http" is already registered
#    （2026-09-25 实测：admin 那条路修好之后，两个 preset 都声明 provider 才暴露出来。）
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'

# SSRF 守卫。dsh-web-fetch-http 明确不做私网防护（src/provider.ts:6），
# 且 MCP 工具会绕过 preset 裁剪（ADR 0005），所以必须在调用点守。
- id: url-guard
  name: 'yanxin/src/net/url-guard.ts'`

/**
 * shell 工具行 —— **只出现在 xiaoyan-admin 里**。
 *
 * 这是 spec §6.10 的能力门落地点：非管理员会话的 preset **里没有这一行**，
 * 所以"非管理员没有 shell"是**能力不存在**，而不是"被拒绝"。
 *
 * ⚠️ **这里不声明 shell 的提供者**（`@deepseek-ai/dsh-bash-local`）。
 * `shell` 服务由 **host 平面**的 `bash` 行提供（见 `cordis.patch.yml`），理由是实测出来的：
 *
 *   1. host 平面有别的消费者 —— `@deepseek-ai/dsh-permission-presets` 会
 *      `pending (waiting for service: shell)`，把提供者整个禁掉会让 boot 直接失败；
 *   2. preset 里再声明一个提供者会**撞服务名**：
 *      `preset "xiaoyan-admin" failed to mount: service "shell" has been registered
 *      at <SandboxPwshExecutor>`
 *
 * （2026-09-25 实测，见 ADR 0013 与 cordis.patch.yml 的说明。）
 *
 * Tier 1：host 平面用 DSH 现成的 bash 执行器。`dsh-bash-sandbox` 在 Windows 无 runner，
 * 所以不用沙箱版；前提是 **DSH 必须在 Git Bash 中启动**，否则 `bash` 不在 PATH 上
 * （本机 Git 装在 D 盘，不得硬编码盘符）。见 ADR 0001。
 * Tier 2（若 Tier 1 跑不通）：换成自建的 `@yanxin/shell-gitbash`（实现在 T5b）。
 */
const SHELL_ROWS = `# ⚠️ shell 工具 —— 本 preset 的**唯一**特权来源。别的 preset 不许有这一段。
#
# ⚠️ 这里**不声明** shell 的提供者（dsh-bash-local）：'shell' 服务由 host 平面的
#    'bash' 行提供（它同时被 permission-presets 依赖）。preset 里再声明一个会撞服务名。
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'`

/**
 * Agent 模式的**全能力工具行**（2026-09-26 方向修正：admin 私聊 = 生活助理，能力拉满）。
 *
 * 行定义**照抄** monorepo base patch（`packages/bundle/base/cordis.patch.yml`），
 * 含 config —— preset 行是会话期独立装载的，config 不带就按裸默认走。
 * host 平面上同 id 的行已被 bundle patch `disabled`（见 cordis.patch.yml），
 * 但 preset 行不依赖 host 行（与 tool-bash 同机制，ADR 0013 的分工原则：
 * 提供者放 host，工具行由 preset 声明；这两个工具的"提供者"就是包本身）。
 *
 * ⚠️ 连锁风险（ADR 0013 的教训：依赖被上一层掩盖）：subagent/workflow 系在
 *     base 里还有邻居行（`workflow-worker-thread` 等）。worker-thread 未被禁、
 *     在 host 平面活着；若实测报 pending/缺服务，照 ADR 0013 的路子逐层排查。
 *
 * 选型说明（用户 2026-09-26 定）：文件系统 + 任务计划 + 子代理工作流三类全开；
 * `tool-skill` / `tool-ralph` / `tool-jobs` 仍禁 —— 前两个是编码工作流，与助理无关。
 */
const ASSISTANT_ROWS = `# ── Agent 模式全能力（仅 admin preset）──────────────────────────
# 文件系统读写
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

- id: tool-str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
  config:
    maxOutputChars: 16000

# 任务与计划
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'

# 子代理（spawn 可持续 + fork 一次性 + 控制/列举/回报）
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    backgroundMode: continuable

- id: tool-subagent-fork
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
    toolName: subagent_fork
    backgroundMode: one-shot

- id: tool-subagent-control
  name: '@deepseek-ai/dsh-tool-subagent-control'

- id: tool-subagent-list-agents
  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'

- id: tool-subagent-report
  name: '@deepseek-ai/dsh-tool-subagent-report'

# 工作流（动态工作流的 worker 服务由 host 平面的 workflow-worker-thread 提供）
- id: tool-workflow
  name: '@deepseek-ai/dsh-tool-workflow'`

const HEADER = (id, note) => `# 由 scripts/build-presets.mjs 生成 —— **不要手改**（改 persona/*.md 后重跑）。
# preset id: ${id}
#
# ${note}
#
# 能力裁剪取证方法（ADR 0005）：解压 $DSH_HOME/sessions/**/session.jsonl.zstd，
# 读 request/header 事件里的 tools 数组 —— 那是发给模型的真实工具表。`

const files = {
  'xiaoyan-agent': {
    yml: `${HEADER('xiaoyan-agent', '群聊脚手架（Phase 5 前顶着）/ 非管理员私聊兜底。人格 + 网页抓取，**没有 shell**。')}

${personaRow(base + '\n\n' + profile)}

${WEB_ROWS}
`,
    meta: {
      name: '小研（群聊）',
      description: '毕小研本人。安静温柔、中文 1~3 句，能抓网页看。不带 shell 与文件工具。',
      order: 5,
    },
  },

  'xiaoyan-admin': {
    yml: `${HEADER('xiaoyan-admin', 'Agent 模式落地：管理员私聊（生活助理）。上面全部 + shell + 文件/任务/子代理全能力。')}

${personaRow(base + '\n\n' + profile)}

${WEB_ROWS}

${SHELL_ROWS}

${ASSISTANT_ROWS}
`,
    meta: {
      name: '小研（管理员）',
      description: '毕小研本人 + 生活助理全能力（shell / 文件 / 任务 / 子代理）。仅限管理员私聊会话。',
      order: 6,
    },
  },

  'xiaoyan-world': {
    yml: `${HEADER('xiaoyan-world', 'World 模式。世界姿态人格 + 世界定义，**没有 shell**。世界工具待 Phase 5。')}

${personaRow(
      base +
        '\n\n' +
        profile +
        '\n\n## 现在的状态\n你正在过自己的生活——不在跟谁即时对话，而是在自己的世界里行动。\n\n' +
        world,
    )}

${WEB_ROWS}

# 世界工具集（T26）—— 她"伸手"的地方：observe / act / wait / rest / say / note / notes。
#
# ⚠️ 它 inject ['tools', 'world']：世界引擎没装载时它会 pending（工具不注册，**不崩**）——
#    那正是"她不在世界里"的如实表现（窗口外引擎本就不装载，见 spec §6.6）。
# ⚠️ say 经发射闸门（T23）发出；note 写 notes/*.md（人机共用）—— 两件事别混。
- id: world-tools
  name: 'yanxin/src/world/tools.ts'
`,
    meta: {
      name: '小研（世界）',
      description: '毕小研在自己的世界里生活。世界工具待 Phase 5。不带 shell。',
      order: 7,
    },
  },
}

for (const [dir, { yml, meta }] of Object.entries(files)) {
  const target = join(PRESETS, dir)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'agent.cordis.yml'), yml, 'utf8')
  const metaYml =
    `name: ${meta.name}\n` +
    `description: ${meta.description}\n` +
    `# 出厂的四个 preset 是 1/2/3/4；order: 0 会排到最后（ADR 0004），故从 5 起。\n` +
    `order: ${meta.order}\n`
  writeFileSync(join(target, 'preset.yml'), metaYml, 'utf8')
  console.log(`生成 presets/${dir}/  (order=${meta.order})`)
}

console.log('\n完成。安装到 DSH：cp -r presets/<id> "$DSH_HOME/.agent-presets/"')
