/**
 * 世界模型调用 —— 把 DSH 的 `ctx.llm` 接到 T25 的 `CallWorldModel` 上（T27b）。
 *
 * ## 为什么需要它
 *
 * T25 的裁定者与 T27 的创世都只认一件事：**给一段提示词 + 一个工具，拿回一份结构化参数**。
 * 它们不知道模型从哪来（那是刻意的：测试注入 mock 就能把整条链路验完）。本文件就是那个
 * "从哪来"——一次**无会话的一次性调用**（不是 agent 对话，没有历史、没有工具循环）。
 *
 * ## 与桥那条路的区别（别把两件事混起来）
 *
 * | | 群聊 / 生活（bridge / Bot-LLM） | 这里的裁定与创世 |
 * |---|---|---|
 * | 形态 | **agent 会话**（有历史、有工具循环、有记忆） | **一次性调用**（无状态） |
 * | 谁在说话 | 小研本人 | 世界模型（它不是角色，是"世界真相"那一侧） |
 * | 状态放哪 | session 日志 + 记忆 | 提示词里（每次从快照重建） |
 *
 * 所以裁定者**没有记忆**是设计，不是缺陷：它每次看到的是"此刻的世界"（T25 的纪律）。
 *
 * ## 一处 API 上的将就（如实记下）
 *
 * spec §6.7 写的是 `tool_choice: 'required'`（强制它给结构化提案）。但 vendored 的
 * `GenerateOptions` **没有 `toolChoice` 字段**（只有 `tools`）—— 于是"必须调工具"这件事
 * 只能靠提示词 + **上层的反馈重试**兜：模型要是只回文本，裁定者会把
 * "你没有用 propose_world 给出操作数组"喂回去再问一次（`arbiter.ts` 已有这条路径）。
 * 这是降级，不是等价替代 —— 所以写在这里，免得下次有人以为它真的强制了。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
// 类型层面：`ctx.get('agentDefaultModel')` 需要它（ADR 0010 的同一个坑）
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { CallWorldModel } from './arbiter.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    worldModel: WorldModelService
  }
}

/** 模型路由（provider 是注册的适配器路由名，model 是该路由下的模型 id）。 */
export interface ModelRoute {
  provider: string
  model: string
}

export interface WorldModelCallerOptions {
  /** 流式调用（生产是 `ctx.llm.stream`；测试注入假的）。 */
  stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  /** 每次调用前解析路由（热改 settings 后立即生效，不必重载行）。 */
  route: () => ModelRoute
  /** 系统提示词。**默认不给**：裁定者与创世的提示词自带身份说明，重复注入只会打架。 */
  system?: string
  maxTokens?: number
  /** 裁定是"照章办事"，温度压低调 —— 创意不是这一侧的事。 */
  temperature?: number
  warn?: (message: string) => void
}

export const WORLD_MODEL_DEFAULTS = {
  /**
   * 补全预算。注意带 reasoning 的模型把思考也算在这份预算里，而
   * `BlockAssembler.blocks()` 在 `max-tokens` 截断时会丢掉 tool-call（截断的参数不是
   * 合法 JSON）—— 所以提案短不代表这个数可以小。
   *
   * ⚠️ 2026-10-01 曾因"43/43 全空"把它从 4096 提到 16384，**那个成因是错的**
   * （真因是 `finish=error` 的 429，见下面的告警），故退回 4096。
   */
  maxTokens: 4096,
  temperature: 0.3,
} as const

/**
 * 造一个 `CallWorldModel`。
 *
 * 语义上的三条承诺：
 *   · **模型没调工具** → 不抛，返回文本（上层用反馈重试；那是 T25 的纪律）
 *   · **参数不是合法 JSON** → 同上（脏数据不该变成异常穿透到运行时）
 *   · **流本身报错**（网络/鉴权/额度）→ **抛出去**：那要重试的地方在运行时与心跳，
 *     在这里吞掉只会让"这次裁不了"看起来像"世界什么都没发生"
 */
export function worldModelCaller(options: WorldModelCallerOptions): CallWorldModel {
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const maxTokens = options.maxTokens ?? WORLD_MODEL_DEFAULTS.maxTokens
  const temperature = options.temperature ?? WORLD_MODEL_DEFAULTS.temperature

  return async (request) => {
    const route = options.route()
    const assembler = new BlockAssembler()

    const stream = options.stream({
      provider: route.provider,
      model: route.model,
      ...(options.system === undefined ? {} : { system: options.system }),
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: request.prompt }],
          // 来源标记走 `plugin`：这条调用不属于任何 QQ 会话（它是世界侧的裁定/创世）
          source: { kind: 'plugin', plugin: 'yanxin-world-model' },
        }),
      ],
      tools: [
        {
          name: request.tool.name,
          description: request.tool.description,
          parameters: asParameters(request.tool.schema),
        },
      ],
      maxTokens,
      temperature,
    })

    for await (const chunk of stream) assembler.push(chunk)

    const blocks = assembler.blocks()
    const text = blocks
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()
    const call = blocks.find((block) => block.type === 'tool-call')

    if (call === undefined) {
      // ⚠️ 别急着说"模型没调用工具" —— `BlockAssembler.blocks()` 在 `finish.kind ===
      //    'max-tokens'` 时会**主动丢掉所有 tool-call**（截断的参数不是合法 JSON，执行它
      //    比不执行更危险）。带 reasoning 的模型把思考算进补全预算，4096 很容易先被吃光：
      //    模型其实调了工具，是我们把它扔了。2026-10-01 现场 43/43 全是这种"空"，
      //    而旧告警把它报成"模型只回了文本"，于是排查整个方向都偏了。
      const finish = assembler.finish
      const excerpt = text.replace(/\s+/g, ' ').slice(0, 120)
      // ⚠️ `finish=error` / `aborted` 时，llm 层把原因放在 `failure` 里 —— 不读它就等于
      //    把一次失败的调用报成"模型不肯调用"。2026-10-01 就是这么空转了 77 次。
      const failure = 'failure' in finish ? finish.failure : undefined
      if (failure !== undefined) {
        warn(
          `[world-model] ${request.tool.name} 这次调用失败了（finish=${finish.kind}，code=${failure.code}` +
            `${failure.status === undefined ? '' : `，http=${failure.status}`}）：${failure.message} —— 交给上层用反馈重试`,
        )
        return text === '' ? {} : { text }
      }
      const output = assembler.usage?.outputTokens ?? 0
      const reasoning = assembler.usage?.reasoningTokens === undefined ? '' : `，其中思考 ${assembler.usage.reasoningTokens}`
      warn(
        finish.kind === 'max-tokens'
          ? `[world-model] ${request.tool.name} 的调用被丢弃：回复在 ${output} 个输出 token 处被 max-tokens 截断${reasoning}` +
            `（截断的工具调用参数不完整，装配器按规矩不交出来）—— 重试也不会好，得加大 maxTokens`
          : `[world-model] 模型没有调用 ${request.tool.name}（finish=${finish.kind}，回了 ${text.length} 字符文本：${excerpt === '' ? '空' : `"${excerpt}"`}）—— 交给上层用反馈重试`,
      )
      return text === '' ? {} : { text }
    }

    const parsed = parseArguments(call.arguments, warn, request.tool.name)
    return {
      ...(parsed === undefined ? {} : { arguments: parsed }),
      ...(text === '' ? {} : { text }),
    }
  }
}

/** 工具的 `schema` 是 JSON 值；这里只接受对象形状（其余当空 schema）。 */
function asParameters(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return {}
  return schema as Record<string, unknown>
}

/** 工具参数（模型给的 JSON 字符串）→ 值。坏 JSON 不算"提案"，交给上层反馈重试。 */
function parseArguments(raw: string, warn: (message: string) => void, toolName: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    warn(`[world-model] ${toolName} 的参数不是合法 JSON（${raw.slice(0, 120)}）—— 当作没给提案`)
    return undefined
  }
}

// ── 装配（bundle patch 的 `world-model` 行）─────────────────────────────────

const ConfigSchema = z.object({
  provider: z.string().description('覆盖默认路由的 provider（缺省用 agent-default-model 的当前选择）。'),
  model: z.string().description('覆盖默认路由的 model。'),
  maxTokens: z.natural().description('单次调用的输出上限。'),
  temperature: z.number().description('采样温度（裁定/提取是照章办事，默认 0.3）。'),
})

interface WorldModelConfig {
  provider?: string
  model?: string
  maxTokens?: number
  temperature?: number
}

/**
 * 世界模型服务（`ctx.worldModel`）。
 *
 * ⚠️ `inject: ['llm']` 是硬依赖：**没有 LLM 就没有这个适配器**。它缺席时这一行会 pending，
 * 而不是提供一个"调用必失败"的假服务（那种静默失败是最难查的）。
 *
 * 路由**每次调用现查**（`agentDefaultModel.currentSelection()`）：改完 settings 立即生效，
 * 不必重载这一行 —— 与桥选模型的方式一致（同一处口径，不会有第二套默认）。
 */
export default class WorldModelService extends Service {
  static readonly inject = ['llm']

  static readonly Config: z<WorldModelConfig> = ConfigSchema

  /** 裁定者与创世共用的调用口。 */
  readonly call: CallWorldModel

  constructor(ctx: Context, config: WorldModelConfig = {}) {
    super(ctx, 'worldModel')

    this.call = worldModelCaller({
      // ⚠️ `.call(llm, …)` 而不是 `llm.stream(…)`：服务是 Proxy，receiver 换了会出
      //    "私有字段读不到"那类故障（ADR 0007 记过同一个坑）。
      stream: (options) => {
        const llm = this.ctx.llm
        return llm.stream.call(llm, options)
      },
      route: () => this.route(config),
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      warn: (message) => this.ctx.logger.warn(message),
    })

    this.ctx.logger.info('[yanxin-world-model] 世界模型适配器就绪（裁定 + 创世共用）')
  }

  /**
   * 当前路由。
   *
   * 优先级：**行 config**（部署要指定"世界用哪个模型"时）→ `agent-default-model`
   * 的当前选择（与桥同一处口径）。
   */
  private route(config: WorldModelConfig): ModelRoute {
    if (config.provider !== undefined && config.model !== undefined) {
      return { provider: config.provider, model: config.model }
    }

    const selection = this.ctx.get('agentDefaultModel') as { currentSelection?: () => ModelRoute } | undefined
    const current = selection?.currentSelection?.()
    if (current !== undefined) return current

    throw new Error(
      '没有模型路由：settings 里没配 agent-default-model，行 config 也没写 provider/model',
    )
  }
}