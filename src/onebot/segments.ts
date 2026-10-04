/**
 * 把一长串回复切成**多条** QQ 消息（分段发送）。
 *
 * ## 为什么不是"按字数硬切"
 *
 * 她要的是"说出来的每句单独一条"，而不是"每 200 字断一次"。所以边界由**她自己标**：
 * 一行 = 一句，整行用直引号包住：
 *
 * ```
 * "笨蛋爸爸，大半夜的还在跟代码打架啊。"
 * "这样吧，先停一下，别急着改。"
 * ```
 *
 * 一个引号行 = 一条消息。引号本身只是**边界标记**，默认发出去时去掉
 * （{@link REPLY_STRIP_QUOTES_DEFAULT}）。
 *
 * ## 三条不能违反的纪律
 *
 *   · **回退是一等公民**：persona 里那套引号风格是后加的，她今天还不会这么写。
 *     一个引号行都没有时必须整条发出（再按长度切），否则"忘加引号"会变成
 *     **完全不回话** —— 而那是静默失败，比切得难看严重一个量级。
 *   · **不丢内容**：引号行与裸行混在一起时，默认把裸行也发（排在引号行之后）。
 *     只发引号行确实更符合"独白不外发"，但它的失败模式是**吞掉她真正想说的话**，
 *     而吞内容是不可逆的、多吐一句是可恢复的。要严格用 `replyMixedLines: 'quoted-only'`。
 *   · **不切坏 CQ 段**：`[CQ:image,file=…]` / `[CQ:at,qq=…]` 这类段被从中间切断就废了，
 *     所以按长度切时把它们当**原子**（见 {@link packAtoms}）。
 *
 * 纯函数、无 IO：投递、间隔、失败处理都在桥那边，这里只回答"该发几条、各是什么"。
 */

/** 外层引号默认去掉（它只是分段边界，不是她想说的话的一部分）。 */
export const REPLY_STRIP_QUOTES_DEFAULT = true

/** 引号行与裸行混合时的两种政策；默认不丢内容。 */
export type MixedLinePolicy = 'keep-all' | 'quoted-only'

export interface ReplyPlanOptions {
  /** 最多拆成几条；超出的**并进最后一条**（不是丢掉） */
  maxSegments: number
  /** 单条长度上限（QQ 实收约 500，留余量） */
  maxCharsPerSegment: number
  /** 外层引号去留 */
  stripQuotes: boolean
  /** 混合行政策 */
  mixed: MixedLinePolicy
}

export interface ReplyPlan {
  /** 要发出去的消息，顺序即发送顺序 */
  readonly messages: readonly string[]
  /** 一个引号行都没有（走了整条回退） */
  readonly fellBack: boolean
  /** 超出条数上限、把尾部并进了最后一条 */
  readonly mergedOverflow: boolean
}

const QUOTE = '"'
/** CQ 段的起止（`[CQ:` … `]`）—— 按长度切时整块对待。 */
const CQ_OPEN = '[CQ:'

/** 一行是不是"整行被直引号包住"。 */
function isQuotedLine(line: string): boolean {
  const t = line.trim()
  return t.length >= 2 && t.startsWith(QUOTE) && t.endsWith(QUOTE)
}

/** 去掉外层引号（只去最外一对，内部的引号是她说的话）。 */
function unwrap(line: string, strip: boolean): string {
  const t = line.trim()
  if (!strip || !isQuotedLine(t)) return t
  return t.slice(1, -1).trim()
}

/**
 * 把文本切成原子序列：CQ 段是单个原子，其余按字符。
 *
 * 未闭合的 `[CQ:` 当普通文本（与 `message.ts` 的"不丢内容"同一取向）。
 */
function toAtoms(text: string): string[] {
  const atoms: string[] = []
  let i = 0
  while (i < text.length) {
    const at = text.indexOf(CQ_OPEN, i)
    if (at === -1) {
      atoms.push(...Array.from(text.slice(i)))
      break
    }
    atoms.push(...Array.from(text.slice(i, at)))
    const end = text.indexOf(']', at + CQ_OPEN.length)
    if (end === -1) {
      atoms.push(...Array.from(text.slice(at)))
      break
    }
    atoms.push(text.slice(at, end + 1))
    i = end + 1
  }
  return atoms
}

/** 按长度切一条消息，保证不切断 CQ 段。 */
function packAtoms(text: string, limit: number): string[] {
  if (limit <= 0 || text.length <= limit) return [text]
  const out: string[] = []
  let current = ''
  for (const atom of toAtoms(text)) {
    // 单个原子比上限还长（一张图的 CQ 码就可能）：只能自己吞下，切了会坏段
    if (current !== '' && current.length + atom.length > limit) {
      out.push(current)
      current = atom
    } else {
      current += atom
    }
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * 按**总长**裁剪，且不把 CQ 段从中间切断。
 *
 * 和 `packAtoms` 同一条口径：装不下的段就整段留在外面，
 * 但**开头**那个超长段仍然发（切了会坏段，超一条是更可恢复的错）。
 */
export function clipTotal(text: string, limit: number): string {
  if (text.length <= limit) return text
  let out = ''
  for (const atom of toAtoms(text)) {
    if (out !== '' && out.length + atom.length > limit) break
    out += atom
  }
  return out
}

/**
 * 规划一条回复要发几条。
 *
 * @param text 已经过总长裁剪的回复文本
 */
export function planReply(text: string, options: ReplyPlanOptions): ReplyPlan {
  const lines = text.split('\n')
  const quoted = lines.filter(isQuotedLine).map((line) => unwrap(line, options.stripQuotes))
  const bare = lines.filter((line) => !isQuotedLine(line) && line.trim() !== '')

  const fellBack = quoted.length === 0
  const picked = fellBack
    ? [text.trim()]
    : options.mixed === 'quoted-only'
      ? quoted
      : [...quoted, ...bare]

  const nonEmpty = picked.filter((entry) => entry !== '')
  // 上限至少 1 条：配成 0 会变成"她一个字都不发"，那是静默失败而不是"少发"
  const cap = Math.max(1, options.maxSegments)
  let capped: string[]
  let mergedOverflow = false
  if (nonEmpty.length <= cap) {
    capped = nonEmpty
  } else {
    // 前 cap-1 条各占一条，其余全并进最后一条（用换行保留她的分行，不糊成一坨）
    capped = [...nonEmpty.slice(0, cap - 1), nonEmpty.slice(cap - 1).join('\n')]
    mergedOverflow = true
  }

  const messages = capped.flatMap((entry) => packAtoms(entry, options.maxCharsPerSegment))
  return { messages, fellBack, mergedOverflow }
}
