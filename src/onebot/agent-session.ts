/**
 * agent 会话的**解析与复用**（T27b-3 从 bridge 抽出来的共用件）。
 *
 * 两处需要"给一个 sessionId，拿到一个活的 agent"：群聊/私聊（`onebot/bridge.ts`）与
 * 她的日常生活（`world/life.ts`）。两者共用的不是流程，而是**几条踩过坑的纪律**：
 *
 * ① **必须 mount preset**：面向模型的行都在 agent 平面上，不 join 就既没工具也没人格。
 *    而且——`resume` 时**也要** mount（resume 组合的是 fresh scoped world，ADR 0003）。
 * ② **磁盘上有日志就 resume，没有才 create**：会话是持久化的，而同一个群 / 同一个人永远
 *    映射到同一个 session id。对磁盘上已存在的 id 调 `create`，持久化层会拒绝：
 *      session "…" already has a persisted log on disk that does not match this live session
 * ③ **不要"resume 失败就 create"**：那会把 setup / preset 的真实错误误判成"没有日志"，
 *    静默降级成一个新会话（于是她"忘了这个群"却不报错）。
 *
 * 判定方式照抄 DSH 官方的冷会话解析器（`packages/api/remotes/src/agent-lookup.ts`）：
 * 在 `persistence.list()` 里按 id 找。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
// 类型层面：让本文件"看见" agents / agentPresets 对 Context 的增强（ADR 0010 的同一个坑）
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'

/** `ctx.get` 返回 any（cordis reflect 的签名如此）；这里补回我们用到的那一小面。 */
interface SessionPersistenceLike {
  list(signal?: AbortSignal): Promise<readonly { id: string }[]>
}

/** 磁盘上有没有这个会话的日志（冷会话的判据）。 */
export async function hasPersistedLog(ctx: Context, sessionId: string): Promise<boolean> {
  const persistence = ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
  if (persistence === undefined) return false
  const headers = await persistence.list()
  return headers.some((header) => header.id === sessionId)
}

export interface ResolveAgentOptions {
  sessionId: string
  /** agent preset（决定能力集与人格）。 */
  presetId: string
  /** 模型路由（provider/model）。 */
  agentOptions: { provider: string; model: string }
  /** 新建时的 cwd（缺省 `process.cwd()`）。 */
  cwd?: string
}

export interface ResolvedAgent {
  agent: Agent
  /** 这一轮是**恢复**（磁盘上有日志）还是**新建**。 */
  persisted: boolean
  /** 关掉它（装配层在卸载时调用；不调会留下一个还在跑的 agent）。 */
  dispose: () => Promise<void>
}

/**
 * 这个助手需要的两个**调用方已解析好的**服务。
 *
 * ⚠️ 为什么由调用方传进来，而不是在里面写 `ctx.agents`：**cordis 的属性访问要求 inject**。
 * 桥（`onebot/bridge.ts`）声明了 `inject: ['agents', …]`，所以它 `ctx.agents` 合法；
 * 而世界引擎**故意不 inject 任何东西**（它必须能独立裁决 —— 见 `world/engine.ts` 文件头），
 * 于是同一个助手在那边会抛：
 *
 *   cannot get property "agents" without inject
 *
 * 2026-09-27 夜间隔离实例实测到这条：世界循环每一拍都"决策失败（本轮按什么都不做处理）"，
 * 也就是说**她永远不会主动做事**，而单测（假 ctx）全绿。修法就是把依赖显式化：
 * 调用方解析（硬 inject 或软查皆可），助手只负责用它。
 */
export interface AgentServices {
  agents: {
    create(input: unknown): Promise<{ agent: unknown; dispose: () => Promise<void> }>
    resume(input: unknown): Promise<{ agent: unknown; dispose: () => Promise<void> }>
  }
  agentPresets: { mount(agentCtx: Context, id?: string): Promise<unknown> }
}

/**
 * 拿到一个活的 agent（同一 sessionId 由调用方自己缓存复用）。
 *
 * @throws preset 挂载失败 / agent 创建恢复失败时**原样抛出** —— 见文件头 ③
 */
export async function resumeOrCreateAgent(
  ctx: Context,
  services: AgentServices,
  options: ResolveAgentOptions,
): Promise<ResolvedAgent> {
  const { sessionId, presetId } = options

  // 必须 mount：面向模型的行都在 agent 平面上，不 join 就既没工具也没人格。
  // ⚠️ resume 也要 —— resume 组合的是 **fresh scoped world**（ADR 0003）。
  const setup = async (agentCtx: Context): Promise<void> => {
    await services.agentPresets.mount(agentCtx, presetId)
  }

  const persisted = await hasPersistedLog(ctx, sessionId)
  const handle = persisted
    ? await services.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: options.agentOptions, setup })
    : await services.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: options.cwd ?? process.cwd(), agentPreset: presetId },
        agentOptions: options.agentOptions,
        setup,
      })

  return { agent: handle.agent as Agent, persisted, dispose: () => handle.dispose() }
}