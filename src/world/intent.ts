/**
 * 意图 → 提案的**唯一**翻译处（T27，从 T24c 的 `bot-loop` 抽出来）。
 *
 * ## 为什么抽出来
 *
 * 她有两只手，但只有一套机械细节：
 *
 *   · **Bot-LLM 循环**（T24c）——她想一轮，产出一个意图；
 *   · **世界工具**（T26）——她"伸手"登记（`world_act` / `world_say`…），
 *     facade 收到的也是同一个 `Intent` 形状。
 *
 * 两条路的共同点正是**必须写成提案才能进世界**：句柄解析、`expectedEnd`、
 * 确定性幂等键、动作 id。这些如果各写一份，就会出现"工具那条路能指到没见过的
 * 东西"这种事故 —— T24c 的纪律是**句柄解析只发生在一个地方**，这里就是那个地方。
 *
 * ## 三条机械细节（模型不该操心、也就无从写错）
 *
 *   · **句柄 → 内部 id**：`seen:3` 只在**最近一次观测**里有效；解析不到就抛
 *     （瞎编的句柄 → 这一轮作废，比"猜一个 id"安全得多）
 *   · **`expectedEnd = 现在 + duration`**：她把"要花多久"说出来，时刻由这里算
 *   · **幂等键确定性**：`<前缀>:<世界序号>.<第几轮>` —— 同一个位置重提不会双发
 */
import type { Intent } from './bot-loop.ts'
import type { TransactionProposal } from './state.ts'

export interface IntentTranslation {
  /** 发起时刻（世界时间 TU）。 */
  at: number
  /** 她的实体 id（动作的 actor / 说话人）。 */
  selfId: string
  /** 提案依据的世界序号（与 `turn` 一起构成幂等键）。 */
  sequence: number
  /** 同一序号内的第几轮（调用方自增；每提一次 +1）。 */
  turn: number
  /** **最近一次观测**的句柄 → 内部 id。 */
  handles: ReadonlyMap<string, string>
  /** 幂等键前缀（默认 `turn`）—— 区分"她自己想的"与"她伸手登记的"。 */
  keyPrefix?: string
  /** 来源标记（进事务日志，便于审计）。 */
  source?: string
}

/**
 * 翻译一个意图。
 *
 * @throws 意图缺必要字段（`say` 没 text）/ 句柄不在最近观测里 ——
 *   调用方应把这一轮**作废**（不重试），下一轮她会重新看一次世界再决定。
 */
export function translateIntent(intent: Intent, context: IntentTranslation): TransactionProposal {
  const prefix = context.keyPrefix ?? 'turn'
  const stamp = `${context.sequence}.${context.turn}`
  const key = `${prefix}:${stamp}`
  const source = context.source ?? 'bot-llm'

  if (intent.kind === 'say') {
    if (typeof intent.text !== 'string' || intent.text.trim() === '') {
      throw new Error('say 意图缺 text')
    }
    return {
      idempotencyKey: key,
      effectiveAt: context.at,
      operations: [{ op: 'say', actorId: context.selfId, text: intent.text }],
      source,
    }
  }

  // act / wait / rest 都是"要花时间的动作"，区别在**意图文本**（怎么裁定是 T25 的事）
  // 与 `kind`（能不能被打断是 T27b-6 的事：群里来消息时 wait/rest 会提前收场）
  const intentText =
    typeof intent.intent === 'string' && intent.intent.trim() !== '' ? intent.intent : defaultIntent(intent.kind)
  const duration = normalizeDuration(intent.duration)
  const targetIds = intent.handle === undefined ? [] : [resolve(intent.handle, context.handles)]

  return {
    idempotencyKey: key,
    effectiveAt: context.at,
    operations: [
      {
        op: 'action.start',
        action: {
          // ⚠️ 动作 id 里带上**路径前缀**（`act:turn.5.1` / `act:tool.5.1`）：两条路各数各的轮次，
          // 而它们可能看到同一个世界序号（她"伸手登记"时她的循环正好也在想一轮）——
          // 少了这个区分，两条路会撞到同一个动作 id，后者的登记会被内核当重复动作拒掉。
          id: `act:${prefix}.${stamp}`,
          actorId: context.selfId,
          intent: intentText,
          ...(intent.kind === 'act' || intent.kind === 'wait' || intent.kind === 'rest' ? { kind: intent.kind } : {}),
          ...(targetIds.length === 0 ? {} : { targetIds }),
          // ⚠️ 验收要的那条：期望完成时刻 = **生成时刻 + duration**
          expectedEnd: context.at + duration,
        },
      },
    ],
    source,
  }
}

/**
 * 句柄 → 真实 id。
 *
 * @throws 句柄不在这轮观测里时 —— 那是**瞎编的**（模型指了一个它没看见的东西）。
 *   抛出去让这一轮作废，比"猜一个 id"安全得多。
 */
export function resolve(handle: string, handles: ReadonlyMap<string, string>): string {
  const id = handles.get(handle)
  if (id === undefined) {
    throw new Error(`观测里没有这个句柄：${handle}（她只能指她感知到的东西）`)
  }
  return id
}

/** 没给意图文本时的兜底（她自己的措辞优先）。 */
function defaultIntent(kind: Intent['kind']): string {
  switch (kind) {
    case 'wait':
      return '等一等'
    case 'rest':
      return '歇一会儿'
    default:
      return '做点什么'
  }
}

/** 坏值兜底：非数字 / NaN / 负数 → 0（立即）。 */
function normalizeDuration(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  return 0
}