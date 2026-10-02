/**
 * 拆 ReMe `search` 的回答（实测格式，2026-09-27）。
 *
 * ## 为什么需要它
 *
 * ReMe 的 `search` 返回的是**给模型看的 markdown 文本**，不是结构化条目。
 * 但它的每条命中其实**自带一行头**（实测形态）：
 *
 * ```
 * ========== daily/2026-09-26/xiaoyan-memory-recall-group-chat.md:54-140 [score=0.3065] ==========
 * # 小研的记忆召回（群聊 3000000003）
 * ...
 * ```
 *
 * 不拆的后果很具体（控制台记忆页实测）：一条命中的 `source` 只能写死成 `'reme'`、
 * **行号永远是"—"**、正文是**一整块两万字**的拼接 —— 溯源那一栏等于没有。
 * 拆开之后"来源 / 行 / 分"三个格子才真的能用。
 *
 * ## 切不动时的姿态：**退回整段一条**
 *
 * 这不是契约结构（上游随时可以换措辞），所以判据不是"必须切开"，而是"切开更好"：
 * 一行头都认不出来时返回"整段一条"——与这个函数存在之前的行为一致。
 * 反过来（认不出就返回空）会把**上游改格式**伪装成"她记性变差"，那正是
 * `src/memory/reme.ts` 里反复提醒的那类静默失败。
 *
 * ⚠️ 只用命名导出（ADR 0004）。
 */
import type { MemoryHit } from './service.ts'

/**
 * 命中头：`==== <来源>:<起>-<止> [score=<分>] ====`
 *
 * 用命名捕获组（可读性比位置参数强得多），且**不用 `g` 标志** ——
 * 按行 `match` 就行（源码卫生测试禁用 `.exec()`）。
 */
const HIT_HEADER = /^={4,}\s*(?<source>.+?):(?<start>\d+)-(?<end>\d+)\s*\[score=(?<score>[\d.]+)\]\s*={4,}\s*$/

/** 一行头都没认出时的退回形态。 */
function whole(answer: string): MemoryHit[] {
  const text = answer.trim()
  return text === '' ? [] : [{ content: text, source: 'reme' }]
}

/**
 * 把 `answer` 切成多条命中。
 *
 * @param answer - ReMe 的 `answer`（字符串形态；数组形态由调用方处理）。
 * @returns 逐条命中；认不出任何命中头时是"整段一条"。
 */
export function splitRemeAnswer(answer: string): MemoryHit[] {
  const hits: MemoryHit[] = []
  let current:
    | { content: string[]; source: string; lines: [number, number]; score?: number }
    | undefined

  const flush = (): void => {
    if (current === undefined) return
    const content = current.content.join('\n').trim()
    if (content !== '') {
      hits.push({
        content,
        source: current.source,
        lines: current.lines,
        ...(current.score === undefined ? {} : { score: current.score }),
      })
    }
    current = undefined
  }

  for (const line of answer.split('\n')) {
    const matched = line.match(HIT_HEADER)
    const groups = matched?.groups
    if (groups !== undefined && groups.source !== undefined) {
      flush()
      const start = Number(groups.start)
      const end = Number(groups.end)
      const score = Number(groups.score)
      current = {
        content: [],
        source: groups.source.trim(),
        lines: [start, end],
        ...(Number.isFinite(score) ? { score } : {}),
      }
      continue
    }
    if (current !== undefined) current.content.push(line)
  }
  flush()

  return hits.length === 0 ? whole(answer) : hits
}