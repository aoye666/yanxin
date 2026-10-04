/**
 * 群里最近的话（环形缓冲）—— 让她在被叫到名字时**看得见场面**。
 *
 * ## 为什么需要它
 *
 * 桥的闸门默认只放行"被 @"的消息，其余**整条丢掉**：agent 会话里根本没有它们，
 * 所以她被 @ 时其实不知道前面在聊什么。这个缓冲补的就是那一段 —— 而且必须喂在
 * **决策之前**，否则被略过的消息进不来，缓冲里就只剩她说过的话。
 *
 * ## 三条纪律
 *
 *   · **内存，不落盘**：它是"刚才"，不是"历史"。重启即空是设计，不是缺陷 ——
 *     真要长期记住东西的机制是记忆（`src/memory`），不是这里。
 *   · **空缓冲时一个字节都不加**（`withContext(text, '') === text`）：与
 *     `inject.ts` 的"召回为空则原样返回"同一条理由，不给 prompt 塞空标题。
 *   · **措辞像"她刚才听见了"**，不用"上下文/历史消息/窗口"这类工程词。
 */

/** 一句别人的话。 */
export interface SpokenLine {
  senderName: string
  text: string
}

/**
 * 按会话分桶的环形缓冲。
 *
 * 桶的 key 由调用方给（桥用的是群号）—— 这里刻意不认识 OneBot 的形状，
 * 这样它同时是个可单测的纯数据结构。
 */
export class RecentChat {
  private readonly buckets = new Map<string, SpokenLine[]>()
  private readonly limit: number

  /** @param limit 每个桶留几条（<= 0 视为不记） */
  constructor(limit: number) {
    this.limit = limit
  }

  push(key: string, line: SpokenLine): void {
    if (this.limit <= 0) return
    const bucket = this.buckets.get(key) ?? []
    bucket.push(line)
    // 只裁头部：追加永远是最新的，超出就丢最旧的
    while (bucket.length > this.limit) bucket.shift()
    this.buckets.set(key, bucket)
  }

  /** 这个桶里现有的话（**副本** —— 调用方改不动内部状态）。 */
  recent(key: string): SpokenLine[] {
    return [...(this.buckets.get(key) ?? [])]
  }

  /** 除最后一条之外的全部 —— 桥把"当前这条"先入缓冲，取上下文时要排除它自己。 */
  beforeLast(key: string): SpokenLine[] {
    return this.recent(key).slice(0, -1)
  }

  clear(key?: string): void {
    if (key === undefined) this.buckets.clear()
    else this.buckets.delete(key)
  }
}

/**
 * 把几句听见的话渲染成给模型看的背景。
 *
 * @returns 空串 = "什么都没加"的信号（与 `renderMemories` 同一个约定）。
 */
export function renderRecent(lines: readonly SpokenLine[]): string {
  const usable = lines.filter((line) => line.text.trim() !== '')
  if (usable.length === 0) return ''
  const body = usable.map((line) => `- ${line.senderName}：${line.text.trim()}`).join('\n')
  return `（你刚才听见群里说：\n${body}\n）`
}

/**
 * 把听见的话拼到当前这条消息前面。
 *
 * ⚠️ `context` 为空串时**原样返回** `text` —— 没有上下文时 prompt 必须与从前逐字节一致。
 */
export function withContext(text: string, context: string): string {
  return context === '' ? text : `${context}\n\n${text}`
}
