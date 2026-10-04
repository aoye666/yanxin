/**
 * 人格文本的**拼装规则**（单一来源）。
 *
 * 为什么搬到 TS 而不是留在 `scripts/build-presets.mjs` 里：同一段文本现在有两个写入者 ——
 *   · 脚本：从包内 `persona/` 的三段生成 `presets/<id>/agent.cordis.yml`
 *   · 控制台人格页：把新写的段落重新嵌入 `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`
 * 规则各写一份必然漂移，而漂移的症状正是 `world-step` 要拦的那件事 ——
 * 她按一份设定说话，世界的实体却按另一份长出来。所以两边都从这里取。
 *
 * 三条纪律：
 *   · **人格是三个 preset 的共享基底**（spec §6.4：分叉的是工具面与提示模板，不是人格本身）
 *   · 拼装只产生**文本**，不碰 YAML —— 落到 yml 里是 `persona-embed.ts` 的事
 *   · 这个文件必须**可被 `node` 直接 import**（`scripts/build-presets.mjs` 要 import 它）：
 *     所以只用可擦除的 TS 语法（无 enum / 无命名空间 / 无参数属性），且不 import 任何运行时依赖
 */

/** 三种模式 —— 与三个 preset 一一对应。 */
export const PRESET_MODES = ['agent', 'admin', 'world'] as const

export type PresetMode = (typeof PRESET_MODES)[number]

/** preset id（`presets/<id>/`、`$DSH_HOME/.agent-presets/<id>/` 用的都是这个）。 */
export const PERSONA_IDS: Record<PresetMode, string> = {
  agent: 'xiaoyan-agent',
  admin: 'xiaoyan-admin',
  world: 'xiaoyan-world',
}

/** preset id → 模式（安装时按目录名反查；表外的一律**不碰**，结构归生成脚本所有）。 */
export const MODE_BY_PRESET_ID: ReadonlyMap<string, PresetMode> = new Map(
  PRESET_MODES.map((mode) => [PERSONA_IDS[mode], mode] as const),
)

/** 三段人格源（`persona/` 里的三个文件）。 */
export interface PersonaSources {
  base: string
  profile: string
  world: string
}

/** 人格源的文件名（**唯一一份清单** —— 向导装哪个文件、证据读哪个文件都从这里取）。 */
export const PERSONA_SOURCE_NAMES: Record<keyof PersonaSources, string> = {
  base: 'base.md',
  profile: 'profile.md',
  world: 'world.md',
}

/** 世界模式在人格里加的那段"姿态"说明（不是世界定义本身，那是 `world.md`）。 */
export const WORLD_STANCE =
  '\n\n## 现在的状态\n你正在过自己的生活——不在跟谁即时对话，而是在自己的世界里行动。\n\n'

/**
 * 某一种模式的完整 system prompt 人格段。
 *
 * `agent` 与 `admin` **文本完全相同** —— 两者的分叉在工具面（`bash` / 文件 / 子代理那些行），
 * 不在人格。这里刻意不写差异，写了就是"两个 preset 各说一套"的开始。
 */
export function composePersona(mode: PresetMode, sources: PersonaSources): string {
  const head = `${sources.base.trim()}\n\n${sources.profile.trim()}`
  return mode === 'world' ? `${head}${WORLD_STANCE}${sources.world.trim()}` : head
}

/**
 * 出厂空模板的标记（公开包的 `persona/*.md` 里全是这种行）。
 *
 * 判"她有没有被人写过"**不能只看文件非空** —— 空模板里有标题、有 `> TODO` 说明，
 * 内容一大堆，`hasContent` 会判"人格已装好"，于是新用户一路在空模板上创了世。
 * 这是这条判据存在的全部理由（`src/setup/install.ts` 的证据读取用它）。
 *
 * 认法很宽松：任何一行**以 TODO 开头**（前面可有引用符与空白）就算模板痕迹。
 * 误判的方向是"说她还没被写过"，而那是可见、可纠正的 —— 比反过来（悄悄用空模板创世）安全。
 */
export function isPersonaDraftTemplate(text: string): boolean {
  return text
    .split('\n')
    .some((line) => /^\s*>?\s*TODO\b|^\s*>?\s*TODO[：:]/i.test(line))
}
