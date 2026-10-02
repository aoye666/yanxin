/**
 * 世界工具集 —— 她"伸手"的地方（T26，spec §6.7）。
 *
 * ## 这些工具是她（Bot-LLM）用的，不是给你用的
 *
 * 它们挂在 `xiaoyan-world` preset 上 —— 也就是说**只有在"她过着日子"的那个会话里**可见。
 * 群聊（脚手架）与生活助理（admin）都看不到它们（ADR 0013 的分工：工具行由 preset 声明）。
 *
 * ## 它们都返回"收下了"，不是"结果"
 *
 * `world_act` / `world_wait` / `world_rest` / `world_say` 登记的是**意图**（带期望耗时），
 * 不是执行 —— 动作到期后由裁定者（T25）结算，结果注入她**下一次**的感知。
 * 这是 spec §6.7 的"不等待结果"在工具层的体现：她说完"我去看看手机"就能继续想别的，
 * 而"看完了/没看成"会在之后的某一轮里以"刚想起来的事"出现。
 *
 * ## 命名前缀与两处刻意的不对称
 *
 *   · 工具名一律 `world_` 前缀：裸名（`act`/`say`）太泛，将来跟别的工具撞名很难查
 *   · **`world_say` 是对外的**（经发射闸门 T23 → QQ），**`world_note` 是私人的**（写
 *     `notes/*.md`，人机共用）—— 她说话与写日记是两件事，别混
 *   · **观测渲染里带句柄**（`seen:2`）：她要用它指目标（`world_act` 的 `target`）。
 *     句柄不是内部 id —— 它只在这一次观测里有效（T24a 的纪律）
 *
 * ## 与引擎的关系
 *
 * 本文件只依赖 {@link WorldFacade}（"看/登记/写笔记/翻笔记"四个动词）。
 * 真实现是 T27 接线的 world 引擎；测试注入假 facade —— 于是工具层的验收
 * **不需要**搭一个真的世界。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Intent } from './bot-loop.ts'
import type { Observation } from './observe.ts'

/**
 * 工具层依赖的最小面 —— T27 由真引擎实现；测试注入假的。
 *
 * 刻意只有四个动词：**看**（投影）、**登记**（意图 → 世界）、**写笔记**、**翻笔记**。
 * "怎么结算""什么时候结算"不在这一层（那是 runtime 与 arbiter 的事）。
 */
export interface WorldFacade {
  /** 她在哪儿、那儿能感知到什么（T24a 的投影）。 */
  look(options?: { focus?: 'around' | 'phone' }): Observation
  /** 登记一个意图（**不是**结果）—— 返回"收下了吗"。 */
  submit(intent: Intent): Promise<{ accepted: boolean; detail?: string }>
  /** 写一篇笔记（`notes/*.md`：一篇一个文件、文件名即标题、人机共用）。 */
  writeNote(title: string, body: string): Promise<{ path: string }>
  /** 列出已有的笔记标题（她自己翻本子）。 */
  listNotes(): Promise<string[]>
}

/** 工具名前缀 —— 裸名太泛，将来撞名很难查。 */
const PREFIX = 'world_'

/** 拿一个值当字符串（缺省 → 空串）。 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 拿一个值当正整数（缺省 → 0）。 */
function asDuration(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  return 0
}

/** 把一次观测渲染成**她看得懂的一段话**（带句柄 —— 她要用它指目标）。 */
export function renderObservation(observation: Observation): string {
  const lines: string[] = []

  const place = observation.entities.find((entity) => entity.handle === observation.placeHandle)
  lines.push(place === undefined ? '你在这里。' : `你在「${place.name}」。`)

  const here = observation.entities.filter((entity) => entity.distant !== true)
  if (here.length > 0) {
    lines.push('你能看到：')
    for (const entity of here) {
      const self = entity.self ? '（你自己）' : ''
      lines.push(`- ${entity.name}（${entity.kind}）${self} [${entity.handle}]`)
    }
  }

  const distant = observation.entities.filter((entity) => entity.distant === true)
  if (distant.length > 0) {
    lines.push(`窗外/远处：${distant.map((entity) => entity.name).join('、')}`)
  }

  if (observation.utterances.length > 0) {
    lines.push('你听到：')
    for (const utterance of observation.utterances) {
      const source = utterance.fromPhone === true ? '（手机里）' : ''
      lines.push(`- ${utterance.speaker}${source}：「${utterance.text}」`)
    }
  }

  return lines.join('\n')
}

/**
 * `wait` / `rest` 的**最低时长**（TU，秒）= 10 分钟（T27b-6）。
 *
 * 为什么要设下限（用户 2026-09-27 的决定）：她原来会频繁地"等 60 秒"，于是每一小段就要
 * 一次模型调用 —— 额度被短等待吃光。让她**一次等久一点**（群里真有事会被消息打断，
 * 见 `interruptWaiting`），同样的日子用少得多的调用过完。
 */
export const MIN_IDLE_UNITS = 600

/** 把时长抬到下限，并如实说明（回执里她要知道自己实际等了多久）。 */
function idleDuration(raw: unknown): { duration: number; clamped: boolean } {
  const asked = asDuration(raw)
  return asked >= MIN_IDLE_UNITS ? { duration: asked, clamped: false } : { duration: MIN_IDLE_UNITS, clamped: true }
}

/**
 * 造出全部世界工具（给定 facade）。
 *
 * 导出成函数（而不是直接在 `apply` 里注册）：这样测试能**直接调 `execute`** 验收行为，
 * 不必搭一个真的 cordis 上下文与工具运行时。
 */
export function worldTools(facade: WorldFacade): ToolDefinition[] {
  /** 登记意图并把它翻成一句如实的话（被拒就说被拒 —— 不假装成功）。 */
  const submitIntent = async (intent: Intent): Promise<{ text: string }> => {
    const result = await facade.submit(intent)
    if (!result.accepted) {
      return { text: `这件事没登记上${result.detail === undefined ? '' : `：${result.detail}`}` }
    }
    return { text: intent.kind === 'say' ? '话记下了（下一次感知会看到它有没有说出去）。' : '记下了 —— 做完了会想起来。' }
  }

    /**
   * 一个通用的输出形状：一句给模型看的话。
   *
   * ⚠️ `as const` 不能省：`defineTool` 的泛型靠**字面量类型**推 `InferValue` ——
   * 共享的字面量对象会被推成 `type: string`（而不是 `'object'`），于是泛型解不出值类型、
   * 连锁报一串 `value: never`。
   */
  const simpleOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args: unknown, value: { text: string }): { type: 'text'; text: string }[] => [
      { type: 'text', text: value.text },
    ],
  } as const

  return [
    defineTool({
      name: `${PREFIX}observe`,
      description:
        '看看你现在能感知到什么。默认看周围（你在哪儿、那儿有什么、听见了什么）；' +
        '也可以看手机（群里在说什么）。你只能指你在观测里看到的东西 —— 每条都带一个 [seen:n] 句柄。',
      parameters: {
        focus: {
          type: 'string',
          enum: ['around', 'phone'],
          description: '看哪儿：around = 周围（默认）；phone = 手机里的消息。',
        },
      },
      output: simpleOutput,
      execute(args) {
        const focus = args.focus === 'phone' ? 'phone' : 'around'
        return Promise.resolve({ text: renderObservation(facade.look({ focus })) })
      },
    }),

    defineTool({
      name: `${PREFIX}act`,
      description:
        '去做一件事。它会花掉你估计的时间（duration，单位 TU≈秒）—— 做完之前你不会知道结果，' +
        '到时候你会"想起来"。可以指定对象（target 用观测里的 [seen:n] 句柄）。',
      parameters: {
        intent: { type: 'string', required: true, description: '你要做什么，用你自己的话说（如"去看看手机"）。' },
        duration: { type: 'integer', required: true, description: '你估计要花多久（TU，秒）。最少 1。' },
        target: { type: 'string', description: '对象句柄（观测里的 [seen:n]，可省略）。' },
      },
      output: simpleOutput,
      execute(args) {
        return submitIntent({
          kind: 'act',
          intent: asString(args.intent),
          duration: asDuration(args.duration),
          ...(typeof args.target === 'string' && args.target !== '' ? { handle: args.target } : {}),
        })
      },
    }),

    defineTool({
      name: `${PREFIX}wait`,
      description:
        '等一会儿（什么也不做，就是让时间过去）。' +
        `⚠️ 最少要等 ${MIN_IDLE_UNITS} TU（10 分钟）—— 等久一点没关系：**群里来消息会打断它**，` +
        '所以不要把等待切得很碎（那是白费力气）。',
      parameters: {
        duration: {
          type: 'integer',
          required: true,
          description: `等多久（TU，秒）。少于 ${MIN_IDLE_UNITS} 会按 ${MIN_IDLE_UNITS} 算。`,
        },
      },
      output: simpleOutput,
      async execute(args) {
        const { duration, clamped } = idleDuration(args.duration)
        const result = await submitIntent({ kind: 'wait', intent: '等一等', duration })
        return clamped
          ? { text: `${result.text}（你说的时间太短，按 ${MIN_IDLE_UNITS} TU≈10 分钟登记了；群里有消息会把你叫醒）` }
          : result
      },
    }),

    defineTool({
      name: `${PREFIX}rest`,
      description:
        '歇一阵（比 wait 更长的那种）。' +
        `⚠️ 最少也是 ${MIN_IDLE_UNITS} TU（10 分钟）；群里来消息会打断。`,
      parameters: {
        duration: {
          type: 'integer',
          required: true,
          description: `歇多久（TU，秒）。少于 ${MIN_IDLE_UNITS} 会按 ${MIN_IDLE_UNITS} 算。`,
        },
      },
      output: simpleOutput,
      async execute(args) {
        const { duration, clamped } = idleDuration(args.duration)
        const result = await submitIntent({ kind: 'rest', intent: '歇一会儿', duration })
        return clamped
          ? { text: `${result.text}（你说的时间太短，按 ${MIN_IDLE_UNITS} TU≈10 分钟登记了；群里有消息会把你叫醒）` }
          : result
      },
    }),

    defineTool({
      name: `${PREFIX}say`,
      description:
        '说一句话（对外 —— 会经发射闸门发出去，比如发到群里）。' +
        '⚠️ 说出去就收不回来了，所以只在真想说话时用。',
      parameters: { text: { type: 'string', required: true, description: '你要说的原话。' } },
      output: simpleOutput,
      execute(args) {
        return submitIntent({ kind: 'say', text: asString(args.text) })
      },
    }),

    defineTool({
      name: `${PREFIX}note`,
      description:
        '往你的本子上写一篇（日记、备忘、对谁的一点印象……）。' +
        '和"记忆"不一样：这是你自己主动写下的，随时可以翻（它不影响你怎么被记住，但你会读到它）。',
      parameters: {
        title: { type: 'string', required: true, description: '标题（会变成文件名）。' },
        body: { type: 'string', required: true, description: '正文。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { path: { type: 'string', required: true }, text: { type: 'string', required: true } },
        },
        render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
      },
      async execute(args) {
        const { path } = await facade.writeNote(asString(args.title), asString(args.body))
        return { path, text: `写好了：${path}` }
      },
    }),

    defineTool({
      name: `${PREFIX}notes`,
      description: '翻翻你的本子（看看都写过什么标题）。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { titles: { type: 'array', required: true, items: { type: 'string' } } },
        },
        render: (_args: unknown, value: { titles: string[] }) => [
          {
            type: 'text' as const,
            text: value.titles.length === 0 ? '本子还是空的。' : `本子上有：${value.titles.join('、')}`,
          },
        ],
      },
      async execute() {
        return { titles: [...(await facade.listNotes())] }
      },
    }),
  ]
}

// ── cordis 插件入口（preset 行 `yanxin/src/world/tools.ts`）────────────────

/** 装配纪律（ADR 0004）：命名导出 + `inject`，**不写 default**。 */
export const name = 'yanxin-world-tools'
export const inject = ['tools', 'world']

/**
 * 注册工具。
 *
 * facade 从 world 引擎拿（`ctx.world`）—— 引擎在 T27 实现 `WorldFacade`。
 * 现在（T27 之前）引擎还没有那四个动词，所以这里**告警并跳过**：
 * 让"引擎还没长出手"这件事可见，而不是注册一堆调不通的工具。
 */
export function apply(ctx: Context): void {
  const facade = ctx.world as unknown as Partial<WorldFacade>
  if (typeof facade.look !== 'function' || typeof facade.submit !== 'function') {
    ctx.logger?.warn?.('[yanxin-world-tools] world 引擎还没实现 WorldFacade（T27 接线）—— 世界工具未注册')
    return
  }
  for (const tool of worldTools(facade as WorldFacade)) ctx.tools.register(tool)
}