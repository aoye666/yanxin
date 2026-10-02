/**
 * 会话 id → 会话主体（审计里的"账号"字段从哪来）。
 *
 * **为什么不能直接问"是谁发起的"**：DSH 的工具接缝**没有发起者（人类）身份**
 * （spec §9 Never：`ToolExecution` 只有 `callId` / `name` / `arguments` / `agent` / `signal`）。
 * 我们在审计里能如实写下来的，只有**会话**（`exec.agent.id`），
 * 而"这个会话属于谁"是**本项目的命名约定**给的信息（`src/onebot/session-trigger.ts`）。
 *
 * 所以这里解析出来的 `account` 是**取证线索，不是权威身份** ——
 * 审计里同时写 `session` 原文，读的人可以自己核对。这条限定必须留着：
 * 一旦有人把它当成权限判定的输入，就违反了 spec §6.10 "能力在声明期裁掉"的取向。
 *
 * ⚠️ 只用命名导出（ADR 0004）。
 */
import type { Channel, Mode } from '../onebot/session-trigger.ts'
import { sessionIdFor } from '../onebot/session-trigger.ts'

export interface SessionSubject {
  /** 运行模式；解析不出来是 `unknown`（不猜）。 */
  mode: Mode | 'unknown'
  /** 会话主体（人）：管理员私聊 = 那位管理员，agent 私聊 = 对方。群聊形态下没有单一个人。 */
  account?: string
  /** 频道形态。 */
  channel?: 'group' | 'private'
  /** 群号（群聊形态才有）。 */
  groupId?: string
  /** bot 自己的账号（`agent:` / `world:` 形态带，`admin:` 形态不带 —— 管理员记忆不按账号切）。 */
  selfId?: string
}

/** 解析会话 id。形状不认识时返回 `{ mode: 'unknown' }`，绝不抛。 */
export function parseSessionId(sessionId: string): SessionSubject {
  const parts = sessionId.split(':')
  const head = parts[0]

  if (head === 'admin') {
    // admin:<uid> | admin:group:<gid>
    if (parts.length === 2 && parts[1]) return { mode: 'admin', account: parts[1], channel: 'private' }
    if (parts.length === 3 && parts[1] === 'group' && parts[2]) {
      return { mode: 'admin', channel: 'group', groupId: parts[2] }
    }
    return { mode: 'unknown' }
  }

  if (head === 'world') {
    // world:<selfId>
    if (parts.length === 2 && parts[1]) return { mode: 'world', selfId: parts[1] }
    return { mode: 'unknown' }
  }

  if (head === 'agent') {
    // agent:<selfId>:group:<gid> | agent:<selfId>:private:<uid>
    if (parts.length !== 4) return { mode: 'unknown' }
    const selfId = parts[1]
    const kind = parts[2]
    const target = parts[3]
    if (!selfId || !target) return { mode: 'unknown' }
    if (kind === 'group') return { mode: 'agent', selfId, channel: 'group', groupId: target }
    if (kind === 'private') return { mode: 'agent', selfId, channel: 'private', account: target }
    return { mode: 'unknown' }
  }

  return { mode: 'unknown' }
}

/**
 * 反向核验用的构造器：把 `parseSessionId` 与 `sessionIdFor` 锁在一起。
 *
 * 存在的意义是**让"约定改了但解析没跟上"这件事有测试可失败** ——
 * 命名约定是记忆写回的隔离单位（spec §6.5），审计的账号字段只是它的副产品。
 */
export function sessionIdRoundTrip(mode: Mode, selfId: string, channel: Channel): SessionSubject {
  return parseSessionId(sessionIdFor(mode, selfId, channel))
}