/**
 * 初始化向导页（T34，spec §6.11）—— `ctx.setup` 状态机的前端。
 *
 * 这是整套东西**唯一的人工入口**：装人格、装背景、创世、绑账号四步都要在这里点得动
 * （CLI 侧只有 `ctx.setup.run(...)`，运维不该被要求写代码）。
 *
 * ## 它显示什么
 *
 *   · **状态一句话**（`init` / 某一步 / `ready`）—— 从状态机推导，不是自己算的
 *   · **四步表**：记录里说做过吗、现场真的成立吗、现在能不能跑、缺什么
 *     （"记录 ∩ 证据"的判定在 `setup/logic.ts`，这里只显示结果）
 *   · **下一步的按钮**：一个表单，把步骤名与它需要的输入一起交上去
 *   · **告警**：不拦 ready 但那件事该知道（"协议端还没连上"）
 *
 * ## 它不做什么
 *
 *   · **不自己判状态**：一律问 `ctx.setup.progress()` —— 两份判定必然漂移
 *   · **不吞错**：`SetupError` 的 `summary`（一句话 + 可操作细节）原样回给页面
 *   · **不写检查逻辑**：能不能跑由 `runnable` 给（前端不许比后端懂得多）
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Block } from '../logic.ts'
import type { SetupProgress, SetupStatus, SetupStep } from '../../setup/types.ts'
// 类型层面：让 `ctx.get('setup')` 看见服务键与进度形状
import type {} from '../../setup/index.ts'

/** 装配纪律（ADR 0004）：命名导出 + `inject`，**不写 default**。 */
export const name = 'yanxin-console-setup'
export const inject = ['console']

/** 每一步给运营者看的一句话（缺省就显示步骤名）。 */
const STEP_LABELS: Record<SetupStep, string> = {
  persona: '人格基底',
  background: '背景资料',
  world: '世界（创世）',
  accounts: '她的 QQ 号',
}

/** 状态的一句话说法。 */
function statusLine(status: SetupStatus): string {
  if (status === 'ready') return '已就绪：四步都做完了，现场也对得上。'
  if (status === 'init') return '还没开始 —— 从「人格基底」开始。'
  return `已完成到「${STEP_LABELS[status]}」，下一步看表格里的按钮。`
}

/** 把进度渲染成区块。 */
export function renderSetupBlocks(progress: SetupProgress, base: string): readonly Block[] {
  const blocks: Block[] = [{ kind: 'p', text: statusLine(progress.status) }]

  blocks.push({
    kind: 'table',
    caption: '四步',
    head: ['步骤', '记录', '现场', '现在能跑吗', '缺什么'],
    rows: progress.steps.map((step) => [
      `${STEP_LABELS[step.step]}（${step.step}）`,
      step.completed ? '做过' : '—',
      step.satisfied ? '成立' : '不成立',
      step.runnable ? '能' : '不能',
      step.missing.join('；') || '—',
    ]),
  })

  for (const warning of progress.warnings) blocks.push({ kind: 'notice', tone: 'info', text: warning })

  const next = progress.steps.find((step) => step.runnable && (!step.completed || !step.satisfied))
  if (next === undefined) {
    blocks.push({ kind: 'p', text: '没有可跑的步骤了。' })
  } else {
    blocks.push(...runForm(next.step, next.missing, base))
  }

  blocks.push({
    kind: 'p',
    text: '改过人格或世界定义之后要重跑对应步骤；世界已存在时重建要显式勾选（旧世界会归档，不删除）。',
  })
  return blocks
}

/** 一步的提交表单（只带这一步需要的输入）。 */
function runForm(step: SetupStep, missing: readonly string[], base: string): readonly Block[] {
  const fields: {
    name: string
    label: string
    type?: 'text' | 'password' | 'hidden' | 'checkbox'
    value?: string
    hint?: string
  }[] = [{ name: 'step', label: '步骤', type: 'hidden', value: step }]

  if (step === 'accounts') {
    fields.push({
      name: 'accountId',
      label: '她的 QQ 号',
      hint: '必须是 onebot 账号注册表里已有的那个（当前缺什么见下面）',
    })
  }
  if (step === 'world') {
    fields.push({
      name: 'rebuild',
      label: '世界已存在时推倒重建（旧世界会归档保留）',
      type: 'checkbox',
      value: 'false',
    })
  }

  return [
    { kind: 'p', text: `下一步：${STEP_LABELS[step]}${missing.length === 0 ? '' : `（还缺：${missing.join('；')}）`}` },
    { kind: 'form', action: `${base}/api/setup/run`, submit: `跑「${STEP_LABELS[step]}」`, fields },
  ]
}

/** 装页与接口。 */
export function apply(ctx: Context): void {
  ctx.console.page({
    slug: 'setup',
    title: '初始化',
    async render({ base }) {
      const setup = ctx.get('setup') as { progress(): Promise<SetupProgress> } | undefined
      if (setup === undefined) {
        return [{ kind: 'notice', tone: 'warn', text: '初始化服务不在（`setup` 行没装载）—— 这一页暂时不可用。' }]
      }
      return renderSetupBlocks(await setup.progress(), base)
    },
  })

  ctx.console.api({
    route: 'setup/run',
    method: 'POST',
    async handler({ body }) {
      const setup = ctx.get('setup') as
        | {
            run(
              step: SetupStep,
              input: { accountId?: string; rebuild?: boolean },
            ): Promise<{ status: SetupStatus; detail: string }>
          }
        | undefined
      if (setup === undefined) return { error: '初始化服务不在（`setup` 行没装载）' }

      const input = (body ?? {}) as { step?: unknown; accountId?: unknown; rebuild?: unknown }
      const step = typeof input.step === 'string' ? (input.step as SetupStep) : undefined
      if (step === undefined) return { error: '没给 step' }

      try {
        const result = await setup.run(step, {
          ...(typeof input.accountId === 'string' && input.accountId.trim() !== ''
            ? { accountId: input.accountId.trim() }
            : {}),
          ...(input.rebuild === 'true' || input.rebuild === true ? { rebuild: true } : {}),
        })
        return { step, detail: `${STEP_LABELS[step]}：${result.detail}` }
      } catch (error) {
        // 向导的失败信息本来就是"给人看、可操作"的（SetupError.summary）——原样回给页面
        const summary = (error as { summary?: string }).summary
        return { step, error: summary ?? (error instanceof Error ? error.message : String(error)) }
      }
    },
  })
}