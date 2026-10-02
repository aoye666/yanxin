/**
 * 裁定者 —— World-LLM 的适配层（T25，spec §6.7）。
 *
 * 它做的事：**把一个到期的动作 + 当前世界，交给世界模型，换回一个提案** ——
 * 而且模型**永远不直接写文件**：它的输出先过内核的校验（`kernel.check`），
 * 不合法就把**机读诊断**喂回去让它改，最多 N 轮；用尽仍不合法 → 返回 `null`
 * （"这次裁不了"，运行时保持 pending，等下一拍心跳重来）。
 *
 * ## 两个模型的视角是**刻意不同**的
 *
 * | | 看到什么 | 为什么 |
 * |---|---|---|
 * | Bot-LLM（她自己） | **句柄**（`seen:n`） | 她只能指她感知到的东西（T24a） |
 * | World-LLM（裁定者） | **内部 id** | 它要**写提案**，而提案里是 id —— 给它句柄它反而没法干活 |
 *
 * 所以"句柄"是**她的**限制，不是世界的限制。裁定者需要看见全貌（包括她看不到的
 * `hidden` 属性）—— 它是"世界的真相"这一侧的。它被约束的地方在别处：
 * **不能为她生成台词、不能改她的意图/人格/记忆**（写进提示词，也写进这里的纪律）。
 *
 * ## 无状态
 *
 * 每次裁定都从传入的 `world` 快照重建提示词 —— 没有跨调用的记忆。
 * "世界已经变了"因此天然被处理：runtime 传进来的就是**此刻**的快照（T24b）。
 *
 * ## 刻意不做
 *
 * 不调用真实的 LLM（那是 T27 的接线）；不提交提案（那是 runtime 的职责）；
 * 不重试模型调用本身的网络错误（抛出去给 runtime 的 catch —— 它在下一拍会重来）。
 */
import type { KernelDiagnostic } from './error.ts'
import type { WorldKernel } from './kernel.ts'
import type { JsonValue, TransactionProposal, WorldAction, WorldSnapshot } from './state.ts'

/**
 * 一个"世界模型可以调用的工具"的形状。
 *
 * 不写死具体某一个：裁定者用 `propose_world`，创世用 `install_world`（`genesis.ts`），
 * 而**适配器（真实 LLM 接线）只需要认识这个形状** —— 一处接线吃下两个口子。
 */
export interface WorldTool {
  readonly name: string
  readonly description: string
  readonly schema: JsonValue
}

/** 让世界模型用的工具 —— 它**只能**通过这一个口子提交变化。 */
export const PROPOSE_WORLD = {
  name: 'propose_world',
  description:
    '提交你对世界的裁定：一串操作（动作完成/失败、实体的创建/移动/改变）。' +
    '你不会直接修改任何文件 —— 这些操作会先被校验，合法才提交。',
  schema: {
    type: 'object',
    required: ['operations'],
    additionalProperties: false,
    properties: {
      operations: {
        type: 'array',
        description: '要提交的操作。结算一个动作通常包含一条 action.finish。',
        items: { type: 'object', required: ['op'], additionalProperties: true },
      },
    },
  } as JsonValue,
} as const

export interface WorldModelRequest {
  /** 完整的提示词（世界现状 + 到期动作 + 任务）。 */
  prompt: string
  /**
   * 模型**必须**用这个工具（对应 OpenAI 兼容的 `tool_choice: 'required'`，
   * spec §6.7 的纪律：不要让它写自由文本，让它给一个结构化提案）。
   */
  tool: WorldTool
}

export interface WorldModelReply {
  /** 工具调用的参数（**未校验**：形状对不对由内核说了算）。 */
  arguments?: unknown
  /** 模型的自由文本（只进日志）。 */
  text?: string
}

/** 世界模型调用（T27 接真实 LLM；测试注入假的）。 */
export type CallWorldModel = (request: WorldModelRequest) => Promise<WorldModelReply>

export interface ArbiterOptions {
  kernel: WorldKernel
  callModel: CallWorldModel
  /** 最多让模型改几次（默认 2 —— 一次原稿 + 一次带诊断的修正）。 */
  maxAttempts?: number
  warn?: (message: string) => void
}

const DEFAULT_MAX_ATTEMPTS = 2

export class WorldArbiter {
  private readonly maxAttempts: number
  private readonly warn: (message: string) => void

  constructor(private readonly options: ArbiterOptions) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  /**
   * 裁定一个到期的动作。
   *
   * @returns 通过校验的提案；`null` = 这次裁不了（模型没给出合法提案 / 调用失败之外的用尽重试）。
   */
  async adjudicate(action: WorldAction, world: WorldSnapshot): Promise<TransactionProposal | null> {
    const base = renderContext(action, world)
    let prompt = base

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const reply = await this.options.callModel({ prompt, tool: PROPOSE_WORLD })
      const built = buildProposal(reply, action)

      if (built === undefined) {
        // 模型没给工具调用（或者给的不是操作数组）—— 也说清楚，让它下一轮给
        prompt = `${base}\n\n## 上一次不行\n你没有用 ${PROPOSE_WORLD.name} 给出操作数组。请用它提交。`
        continue
      }

      const diagnostics = this.options.kernel.check(built)
      if (diagnostics.length === 0) return built

      // ⚠️ 这就是 spec §6.7 说的"模型可修正后重提"：把**机读诊断**原样喂回去 ——
      // 它带着"哪条操作的哪个字段、为什么、目标长什么样"，模型据此能一次改对
      prompt = `${base}\n\n## 上一次的提案被拒（第 ${attempt} 次）\n${diagnostics
        .map(renderDiagnostic)
        .join('\n')}\n请修正后重新提交。`
      this.warn(
        `[world-arbiter] 第 ${attempt} 次提案未通过校验（${diagnostics.length} 条）：${diagnostics[0]?.message ?? ''}`,
      )
    }

    this.warn(`[world-arbiter] ${this.maxAttempts} 次都没给出合法提案（${action.id}）—— 这次裁不了`)
    return null
  }
}

/**
 * 把一次裁定请求渲染成给世界模型的提示词。
 *
 * ⚠️ 这里给它**内部 id**（与她对模型看到的句柄相反）：它要写提案，而提案里是 id。
 * 同时给它 `hidden` 属性（它是世界真相那一侧）——但她看不到（T24a 的投影）。
 */
export function renderContext(action: WorldAction, world: WorldSnapshot): string {
  const lines: string[] = []

  lines.push('# 你的位置')
  lines.push('你不是在扮演任何角色。你是这个世界的裁定者：她说要做一件事，时间到了，你来决定发生了什么。')
  lines.push('')
  lines.push('# 世界现状')
  lines.push(`世界时间：${world.effectiveAt}（TU）｜ 已提交事务：${world.sequence}`)
  lines.push('实体：')
  for (const entity of Object.values(world.entities)) {
    const where = entity.location === null ? '（最外层）' : `在 ${entity.location}`
    const owner = entity.owner === undefined || entity.owner === null ? '' : `，属于 ${entity.owner}`
    const attributes = Object.entries(entity.attributes)
      .map(([key, value]) => `${key}=${JSON.stringify(value.value)}${value.visibility === 'hidden' ? '(hidden)' : ''}`)
      .join(' ')
    lines.push(
      `- ${entity.id}：${entity.name}（${entity.kind}，${where}${owner}，rev ${entity.revision}）${attributes === '' ? '' : ` ${attributes}`}`,
    )
  }
  lines.push('')
  lines.push('# 到期的动作')
  lines.push(`- ${action.id}：${action.actorId} 的「${action.intent}」`)
  if (action.targetIds !== undefined && action.targetIds.length > 0) {
    lines.push(`  目标：${action.targetIds.join('、')}（发起时版本：${JSON.stringify(action.targetVersions)}）`)
  }
  lines.push(`  发起于 ${action.startedAt}，期望 ${action.expectedEnd ?? action.startedAt} 完成，现在是 ${world.effectiveAt}`)
  lines.push('')
  lines.push('# 你的任务')
  lines.push(`用 ${PROPOSE_WORLD.name} 给出结算：她这件事**完成了还是失败了**（在 action.finish 的 reason 里说清），`)
  lines.push('以及世界因此发生了什么变化（东西移动了、状态改变了……）。')
  lines.push('只提交**确实发生**的变化 —— 你没提交的，就没发生。')
  lines.push('')
  lines.push('# 操作的形状（照这个来，错了整批退回）')
  lines.push('- `action.finish`：`{ op:"action.finish", id, status, reason }` —— **status 只能是 `completed` / `cancelled` / `failed`**（不要写 `success`）')
  lines.push('  ⚠️ 不要把"顺便改状态"塞进这条操作 —— 要改实体就**单独发一条** `{ op:"update", id, changes:{ attributes:{…} } }`')
  lines.push('- `update` 的状态改动写在 `changes.attributes`，如 `{ current_state: { value:"…", visibility:"public" } }`')
  lines.push('- `say`：`{ op:"say", actorId, text }`；`move`：`{ op:"move", id, location }`')
  lines.push('')
  lines.push('## 你不能做的事')
  lines.push('- 不能替她说话（那是她自己的事）、不能改她的意图/人格/记忆')
  lines.push('- 不能让不存在的东西出现（引用必须指向上面列出的实体 id）')

  return lines.join('\n')
}

/** 诊断 → 给模型看的一行（机读信息 + 一句人话）。 */
function renderDiagnostic(diagnostic: KernelDiagnostic): string {
  const where = diagnostic.opIndex === undefined ? '' : `第 ${diagnostic.opIndex + 1} 条操作：`
  const target = diagnostic.targetId === undefined ? '' : `（目标 ${diagnostic.targetId}）`
  return `- ${where}${diagnostic.code} ${target} ${diagnostic.message}`
}

/**
 * 把模型的回复组装成提案。
 *
 * 机械细节由这里负责（模型只管"发生什么"）：幂等键**确定性**（`settle:<动作 id>` ——
 * 一个动作只结算一次，重复提交被内核的幂等挡住）。
 *
 * ⚠️ `action.finish` 的 `id` 由这里**强制**填成被裁定那个动作的 id，不信模型抄的：
 * 裁定器一次只结算一个已知动作，"结算哪个"根本不是模型的知识。让它手打 id 只制造
 * 失败模式 —— 2026-10-01 实测它会把 `act:tool.9.4` 写成 `tool.9.4`（提示词里动作 id
 * 就列在一串裸实体 id 下面，容易被当成同一种形状），内核回 `UNKNOWN_ACTION`，
 * 两次重试的调用全烧掉，动作留在 pending 等下一拍再赌一次。
 */
function buildProposal(reply: WorldModelReply, action: WorldAction): TransactionProposal | undefined {
  const args = reply.arguments
  if (args === null || typeof args !== 'object') return undefined
  const operations = (args as { operations?: unknown }).operations
  if (!Array.isArray(operations) || operations.length === 0) return undefined

  return {
    idempotencyKey: `settle:${action.id}`,
    operations: operations
      .map((op) =>
        typeof op === 'object' && op !== null && (op as { op?: unknown }).op === 'action.finish'
          ? { ...op, id: action.id }
          : op,
      )
      .filter((op) => typeof op === 'object' && op !== null) as TransactionProposal['operations'],
    source: 'world-llm',
    correlationId: action.id,
  }
}