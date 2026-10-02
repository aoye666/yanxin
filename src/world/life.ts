/**
 * 她的**生活** —— Bot-LLM 的决策函数（T27b-3，spec §6.7）。
 *
 * ## 一轮"想起来"里发生什么
 *
 * ```
 * Tingle 到点（每 30 TU = 30 秒；她若发 wait/rest 则被推到 10 分钟之后）
 *   → 把"她现在能感知到的" + "刚想起来的事"写成一段话
 *   → 交给她自己的 agent 会话（`world:<她的QQ号>`，preset `xiaoyan-world`）
 *   → 她在那一轮里**用世界工具**做事：看看、去做点什么、说句话、写两行
 *   → 工具那条路把动作登记进世界（`WorldLoop.submit` → 内核）
 * ```
 *
 * ## 为什么是"驱动 agent 会话"而不是"直接问模型要一个意图"
 *
 * 因为**那才是同一个她**：群聊里的小研与过日子的小研是同一个 session、同一份人格、
 * 同一套记忆（spec §6.5 的 `world:<selfId>` 命名）。如果这里另起一次裸模型调用，
 * 她的人格就得在这里重写一遍，而且她在群里记住的事不会影响她的生活。
 *
 * 于是这个函数的返回值**永远是 `null`** —— 动作已经由工具登记进世界了，
 * 没有"额外的一个意图"要翻译（`Intent`/`translateIntent` 那条路给工具用，
 * 见 `tools.ts` 与 `intent.ts` 的说明）。这一句写在这里免得下次有人以为它漏了。
 *
 * ## 三件不做事
 *
 *   · **不重试**：会话/模型出错就让这一轮作废（下一拍 Tingle 会再来）——
 *     在这里重试只会把 30 分钟一次的节拍变成一串并发调用
 *   · **不追问**：她这轮什么都没做（没调工具）是合法结果，不是失败
 *   · **不写记忆**：记忆由桥那条路与 ReMe 自己管（世界这一侧只写世界与笔记）
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resumeOrCreateAgent } from '../onebot/agent-session.ts'
import { sessionIdFor } from '../onebot/session-trigger.ts'
import { describeError } from '../describe.ts'
import type { Decide, TurnContext } from './bot-loop.ts'
import type { Observation } from './observe.ts'
import { renderObservation } from './tools.ts'
// 类型层面：`ctx.get('agents')` / `agentPresets` / `sessions` 需要它们（ADR 0010 的同一个坑）
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'

export interface LifeOptions {
  ctx: Context
  /** 她的 QQ 号（会话 id 用它：`world:<QQ>` —— 与群聊共用同一个会话命名空间）。 */
  account: string
  /** agent preset（默认 `xiaoyan-world`：世界姿态人格 + 世界工具）。 */
  presetId?: string
  /** 覆盖模型（缺省走 `agentDefaultModel` 的当前选择）。 */
  model?: string
  /**
   * 她的会话工作目录 —— **该和桥配的一样**。
   *
   * 缺省会落到 `process.cwd()`（内核检出目录），而 agent 会把 cwd 往上的工作区
   * `AGENTS.md` 注入 prompt：她的内心独白里就会出现内核的工程指令。
   * 聊天线不会有这个问题，因为它的 root 是 `~/.dsh/yanxin/workspace`（空的）。
   */
  cwd?: string
  /**
   * 世界时钟（惰性读：引擎开着世界之后才有）。
   *
   * 用它把"醒来多久"与**墙上时间**一起给出来 —— 1 TU = 1 现实秒，且 T=0 就是创世那一刻，
   * 所以她世界里的"现在"就是真实的本地时间（不需要另造一套历法）。
   */
  clock?: () => { genesisMs: number; now(): number } | undefined
  warn?: (message: string) => void
}

/** preset 缺省值（世界姿态）。 */
export const LIFE_PRESET = 'xiaoyan-world'

/**
 * 一段"生活"的句柄：`decide` 交给循环，`dispose` 在这段生活结束时调
 * （引擎随窗口启停 —— 每天开窗建一次，关窗必须收掉，否则 agent 会话句柄
 * 每天泄一份直到进程退出）。
 */
export interface LifeHandle {
  decide: Decide
  /** 释放她这段生活占用的 agent 会话句柄；还没建过会话时是空操作。幂等。 */
  dispose(): Promise<void>
}

/**
 * 造一个"过日子"的决策函数。
 *
 * 服务缺席（`agents` / `agentPresets` / `sessions` 任一不在）时**不抛**：
 * 返回一个什么都不做的决策，并且只告警一次 —— 环境不全时她过不了日子，
 * 但那不该让世界引擎整个起不来（它还有别的活：到点结算、把说过的话发出去）。
 */
export function createLifeDecide(options: LifeOptions): LifeHandle {
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const presetId = options.presetId ?? LIFE_PRESET
  // ⚠️ 走 `sessionIdFor` 而不是手拼字符串：会话命名是记忆写回的隔离单位（spec §6.5），
  //    形状只该有一个来源。world 模式不按频道切，所以频道参数只是占位。
  const sessionId = sessionIdFor('world', options.account, { kind: 'private', userId: options.account })

  let handle: { agent: AgentLike; dispose: () => Promise<void> } | undefined
  let warnedMissing = false
  let warnedNoCwd = false

  const decide: Decide = async (context: TurnContext) => {
    const ctx = options.ctx

    // 软查：缺服务只说一次（每 30 分钟刷一条告警没有意义）
    const agents = ctx.get('agents') as AgentsLike | undefined
    const presets = ctx.get('agentPresets') as { mount: (agentCtx: Context, id?: string) => Promise<unknown> } | undefined
    const sessions = ctx.get('sessions') as { flush: (session: unknown) => Promise<void> } | undefined
    const defaultModel = ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined

    if (agents === undefined || presets === undefined || sessions === undefined || defaultModel === undefined) {
      if (!warnedMissing) {
        warnedMissing = true
        warn('[yanxin-world] 她过不了日子：agent 相关服务不全（agents / agentPresets / sessions / agentDefaultModel）')
      }
      return null
    }

    if (handle === undefined) {
      const selection = defaultModel.currentSelection()
      // cwd 缺失只说一次：这一拍之后每次都会重建会话句柄的话，刷告警没有意义
      if (options.cwd === undefined && !warnedNoCwd) {
        warnedNoCwd = true
        warn('[yanxin-world] 她的世界会话没有配 cwd —— 会话落在内核检出目录，那里的 AGENTS.md 会被注入她的 prompt')
      }
      // ⚠️ 这两个服务**由这里传进去**（而不是让助手自己 `ctx.agents`）：本引擎不 inject
      //    任何东西（文件头写了理由），而 cordis 的属性访问要求 inject ——
      //    少了这个显式传递，每一拍都会 "cannot get property \"agents\" without inject"，
      //    症状是"她永远不主动做事"，而且单测（假 ctx）看不出来（2026-09-27 夜间实测）。
      const resolved = await resumeOrCreateAgent(
        ctx,
        { agents, agentPresets: presets },
        {
          sessionId,
          presetId,
          agentOptions: { provider: selection.provider, model: options.model ?? selection.model },
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        },
      )
      handle = { agent: resolved.agent as unknown as AgentLike, dispose: resolved.dispose }
      warn(`[yanxin-world] 她的会话${resolved.persisted ? '已恢复' : '已新建'}：${sessionId}（preset=${presetId}）`)
    }

    const wall = wallTime(options.clock?.())
    handle.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: renderLifePrompt({ at: context.at, notices: context.notices, observation: context.observation, wall }) }],
        // 来源标记走 `plugin`：这不是谁给她发的消息，是她自己的时间到了
        source: { kind: 'plugin', plugin: 'yanxin-world-tickle' },
      }),
    )

    // 等她这一轮忙完（工具调用在那一轮里发生；动作已经登记进世界）
    await handle.agent.whenIdle()
    await sessions.flush(handle.agent.session)

    // ⚠️ 永远 null：动作走的是**工具那条路**（见文件头）
    return null
  }

  return {
    decide,
    dispose: async () => {
      const held = handle
      handle = undefined
      if (held === undefined) return
      try {
        await held.dispose()
      } catch (error) {
        warn(`[yanxin-world] 她的会话收尾失败（${sessionId}）：${describeError(error)}`)
      }
    },
  }
}

/**
 * 渲染"提醒她过日子"的那段话（纯函数，有单测）。
 *
 * 只写**处境**，不写人设：她是谁、说话什么调子都在 preset 的提示词里
 * （`persona/*.md`，单一来源）。这里重复一遍只会让两处打架。
 */
export function renderLifePrompt(input: {
  at: number
  notices: readonly string[]
  observation: Observation
  /** 墙上时间（`HH:mm`；拿不到就不写） */
  wall?: string
}): string {
  const lines: string[] = []

  lines.push('# 你的处境')
  lines.push(
    `你不是在回谁的话 —— 你在过自己的日子。世界时间：醒来已经过了 ${formatElapsed(input.at)}` +
      (input.wall === undefined ? '' : `，此刻是 ${input.wall}`) +
      '。',
  )
  lines.push('')
  lines.push('# 你现在能感知到的')
  lines.push(renderObservation(input.observation))

  if (input.notices.length > 0) {
    lines.push('')
    lines.push('# 你刚想起来的事')
    for (const notice of input.notices) lines.push(`- ${notice}`)
  }

  lines.push('')
  lines.push('# 该怎么过')
  lines.push('照你的性子来。想做什么就用工具去做：要花时间的事它会登记下来，做完会想起来的；')
  lines.push('想说句话就说（发出去收不回来），想写两行就写。')
  lines.push('**什么都不做也可以** —— 不是每一轮都得有点动静。')

  return lines.join('\n')
}

/** TU（秒）→ 人话（"3 小时 12 分钟"）。 */
export function formatElapsed(tu: number): string {
  const seconds = Math.max(0, Math.floor(tu))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}

/** 本地墙上时间（`HH:mm`）—— 世界时间与真实时间 1:1，所以直接读现实时钟。 */
function wallTime(clock: { genesisMs: number; now(): number } | undefined): string | undefined {
  if (clock === undefined) return undefined
  const ms = clock.genesisMs + clock.now() * 1000
  const date = new Date(ms)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

// ── 结构化最小面（不把 dsh-agent 的整个类型拖进来）────────────────────────

interface AgentLike {
  readonly session: unknown
  followup(message: unknown): void
  whenIdle(): Promise<void>
}

interface AgentsLike {
  create(input: unknown): Promise<{ agent: unknown; dispose: () => Promise<void> }>
  resume(input: unknown): Promise<{ agent: unknown; dispose: () => Promise<void> }>
}