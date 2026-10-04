/**
 * 设置页（T32）—— 命名空间总览 + **模型路由**的可写入口。
 *
 * ## 可写面为什么只有模型路由
 *
 * 控制台能改配置 = 权限提升面（`tasks/plan.md` 的风险表里就这么记着）。所以这一页的
 * 可写项**刻意只有一项**：`agent-default-model`（她这轮用哪个 provider / 模型）。
 * 其余命名空间改动的**归属地**各自明确：
 *
 *   · `yanxin-admin` → 管理员页（有专页，写在那里）
 *   · `yanxin-window` → 时段页（同上）
 *   · 其余（`llm-pi-ai` 的凭据、`yanxin-memory` 的 endpoint、onebot 端口…）→ **部署配置**，
 *     手改 `$DSH_HOME/settings.yaml`。它们是"进程/凭据级"的东西，放在浏览器里改不合适。
 *
 * 页面上把这条"谁能改"的分配**写出来**，而不是让运营者猜为什么某个框是灰的。
 *
 * ## 值怎么显示
 *
 * 一律走 `ctx.settings.describe({ redactSecrets: true })` —— 官方文档明说
 * "Every wire surface MUST pass redactSecrets"，而控制台就是 wire surface。
 * 于是即便将来有人把密钥塞进某个命名空间，这里拿到的也是脱敏后的描述符。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Block } from '../logic.ts'
import { brief, missingService } from './support.ts'

/** 装配纪律（ADR 0004）：命名导出 + `inject`，**不写 default**。 */
export const name = 'yanxin-console-settings-page'
export const inject = ['console']

/** 本页可写的命名空间（其余都是只读或另有专页）。 */
export const MODEL_NAMESPACE = 'agent-default-model'

/** 另有专页的命名空间（页面上如实标注）。 */
const DEDICATED: Record<string, string> = {
  'yanxin-admin': '管理员页',
  'yanxin-window': '时段页',
}

/** settings 描述符里我们要的两个字段（其余忽略）。 */
export interface NamespaceDescriptor {
  ns: string
  value: unknown
}

/** 一个可选的模型路由（provider + model）。 */
export interface ModelChoice {
  provider: string
  model: string
}

/**
 * 从 `llm-pi-ai` 的值里抽出"有哪些 provider / model 可用"。
 *
 * 形状来自 `$DSH_HOME/settings.yaml`（`providers.<id>.models[].id`）——
 * 这是**读外部结构**，所以整个函数是防御式的：形状不认识就返回空数组，
 * 让页面显示"列不出来"，而不是抛异常把页打崩。
 */
export function modelChoices(llmPiAi: unknown): ModelChoice[] {
  const providers = (llmPiAi as { providers?: unknown } | undefined)?.providers
  if (providers === null || typeof providers !== 'object') return []
  const out: ModelChoice[] = []
  for (const [provider, raw] of Object.entries(providers as Record<string, unknown>)) {
    const models = (raw as { models?: unknown } | undefined)?.models
    if (!Array.isArray(models)) continue
    for (const item of models) {
      const id = (item as { id?: unknown } | undefined)?.id
      if (typeof id === 'string' && id !== '') out.push({ provider, model: id })
    }
  }
  return out
}

/** 某条路由能不能用：必须在网关列出来的清单里 —— 拼错一个字母会让她整个不回话。 */
export function checkModelRoute(
  input: { provider?: unknown; model?: unknown },
  choices: readonly ModelChoice[],
): { ok: true; route: ModelChoice } | { ok: false; reason: string } {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (provider === '' || model === '') return { ok: false, reason: 'provider 与 model 都要填' }
  if (choices.length > 0 && !choices.some((c) => c.provider === provider && c.model === model)) {
    return { ok: false, reason: `网关里没有这条路由：${provider}/${model}（从页面列出的清单里选）` }
  }
  return { ok: true, route: { provider, model } }
}

/** 页面的区块（纯函数）。 */
export function renderSettingsBlocks(
  descriptors: readonly NamespaceDescriptor[],
  choices: readonly ModelChoice[],
  base: string,
): readonly Block[] {
  const blocks: Block[] = []

  if (descriptors.length === 0) {
    blocks.push({ kind: 'notice', tone: 'warn', text: '没有任何注册过的 settings 命名空间 —— 服务都没装载？' })
  } else {
    blocks.push({
      kind: 'table',
      caption: '命名空间',
      head: ['命名空间', '在本页', '当前值'],
      rows: descriptors.map((descriptor) => [
        descriptor.ns,
        descriptor.ns === MODEL_NAMESPACE ? '**可改**' : DEDICATED[descriptor.ns] ?? '只读',
        brief(descriptor.value),
      ]),
    })
  }

  blocks.push({
    kind: 'form',
    action: `${base}/api/settings/model`,
    submit: '换模型',
    fields: [
      { name: 'provider', label: 'provider', hint: '例如 agnes / suotianyi' },
      { name: 'model', label: 'model', hint: '例如 agnes-3.0-flash' },
    ],
  })

  if (choices.length > 0) {
    blocks.push({
      kind: 'table',
      caption: `网关里可用的路由（${choices.length} 条）`,
      head: ['provider', 'model'],
      rows: choices.map((choice) => [choice.provider, choice.model]),
    })
  } else {
    blocks.push({
      kind: 'notice',
      tone: 'warn',
      text: '列不出可用的模型清单（`llm-pi-ai` 命名空间不在或形状变了）—— 这一页仍可写，但填错会让她不回话。',
    })
  }

  blocks.push({
    kind: 'p',
    text: '换完立刻生效（世界模型每次调用都现查这条路由）。改其它命名空间：管理员/时段有专页，其余属于部署配置，手改 `$DSH_HOME/settings.yaml`。',
  })
  return blocks
}

/** 装页与接口。 */
export function apply(ctx: Context): void {
  ctx.console.page({
    slug: 'settings',
    title: '设置',
    render({ base }) {
      const settings = ctx.get('settings') as
        | {
            describe(options?: { redactSecrets?: boolean }): readonly NamespaceDescriptor[]
            get(ns: string): unknown
          }
        | undefined
      if (settings === undefined) return missingService('settings')

      const descriptors = settings.describe({ redactSecrets: true })
      return renderSettingsBlocks(descriptors, modelChoices(settings.get('llm-pi-ai')), base)
    },
  })

  ctx.console.api({
    route: 'settings/model',
    method: 'POST',
    async handler({ body }) {
      const settings = ctx.get('settings') as
        | { get(ns: string): unknown; update(ns: string, patch: object): Promise<void> }
        | undefined
      if (settings === undefined) return { error: 'settings 服务不在 —— 改不了路由' }

      const checked = checkModelRoute(
        (body ?? {}) as { provider?: unknown; model?: unknown },
        modelChoices(settings.get('llm-pi-ai')),
      )
      if (!checked.ok) return { error: checked.reason }

      try {
        await settings.update(MODEL_NAMESPACE, checked.route)
      } catch (error) {
        return { error: `写路由失败：${brief(error instanceof Error ? error.message : error, 200)}` }
      }
      return { detail: `已切到 ${checked.route.provider}/${checked.route.model}（下一次调用就按它走）` }
    },
  })
}