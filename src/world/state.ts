/**
 * 世界模型 —— 类型与纯函数（spec §6.7，ADR 0015）。
 *
 * 这一层只做两件事：**定义权威状态长什么样**，以及**把一条操作应用到快照上**。
 * 校验逻辑不在这里（在 `kernel.ts`）—— 分开的原因与 `window/logic.ts` 同构：
 * 纯函数要能表驱动单测，不必搭一个文件系统。
 *
 * ## 为什么是"结构化状态"而不是 Markdown
 *
 * 参照框架（YesImBotWorld）2026 年做过一次改造，把"World 先讲述结果、再后台改 Markdown"
 * 整条链路删掉了 —— 理由是模型写文档时无法保证世界自洽（引用不存在的东西、把状态改成
 * 自相矛盾、重试时重复结算）。现在它是**事务日志 + 内核校验**，我们照做（ADR 0015）。
 *
 * 人可读的那部分没丢：她的笔记（`notes/*.md`）仍是一篇一个 Markdown 文件，
 * 另有由快照导出的只读呈现（`world-status.md`）—— 但**它们都不是权威状态**。
 *
 * ## 两条硬纪律
 *
 *   · **只接受 JSON 值**（`assertJson`）—— NaN / undefined / 原型污染键一律拒。
 *     权威状态要能被无损序列化与重放，这是前提。
 *   · **追加型文件永不原地改写** —— 事务日志只 append（见 `kernel.ts`）。
 */
import { KernelError } from './error.ts'

/** JSON 允许的值。权威世界只用这些。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * 属性可见性。
 *
 *   · `public` —— 谁都能看到（家具、街景）
 *   · `owner`  —— 只有 owner 看得到（她包里的东西）
 *   · `hidden` —— 只对内核可见（**不进入任何角色观测**，Phase 5 用它存"世界真相"）
 *
 * ⚠️ 可见性在**观测投影**里生效（T24），不是在这里 —— 这里只是标记。
 */
export type AttributeVisibility = 'public' | 'owner' | 'hidden'

export interface WorldAttribute {
  value: JsonValue
  visibility: AttributeVisibility
}

export type EntityKind = 'actor' | 'place' | 'object'

export interface EntityInput {
  id: string
  kind: EntityKind
  name: string
  /** 所在位置：一个 `place` 的 id；`null` = 最外层（房子里/街道上都是根层级）。 */
  location: string | null
  /** 归属：只对物件有意义，引用一个 `actor`。 */
  owner?: string | null
  attributes?: Record<string, WorldAttribute>
}

export interface WorldEntity extends EntityInput {
  /** 每次被修改 +1（乐观并发的依据）。 */
  revision: number
  attributes: Record<string, WorldAttribute>
}

export interface ActionInput {
  id: string
  actorId: string
  /** 她自己用自然语言写的意图（"去街上走走"）。 */
  intent: string
  /**
   * 动作是**哪一类**（T27b-6 新增，**可选**）。
   *
   * 为什么要它：`wait`/`rest` 这两种"什么都没发生"的动作要能被**打断**
   * （群里来消息了就别干等着）—— 判据不能靠 `intent` 的文本（那是她自由写的，
   * 也会被改写）。**可选**是为了向后兼容：既有世界的日志里没有这个字段，
   * 重放时是 `undefined`，一切照旧（识别不出来就不断它）。
   */
  kind?: 'act' | 'wait' | 'rest'
  targetIds?: string[]
  /** 期望完成时刻（世界时间 TU）；省略 = 立即。 */
  expectedEnd?: number
  /** 这次动作基于哪次观测（可追溯"她当时看到的是什么"）。 */
  basedOnObservationId?: string
  requestFingerprint?: string
}

export type ActionStatus = 'pending' | 'completed' | 'cancelled' | 'failed'

export interface WorldAction extends ActionInput {
  status: ActionStatus
  startedAt: number
  finishedAt?: number
  /** 结束原因（失败时说清为什么 —— 它会被她"感知"到）。 */
  reason?: string
  /** 发起时目标的版本快照。**完成时要复核**：世界可能已经变了。 */
  targetVersions: Record<string, number>
}

/**
 * 一次事务里的操作。**白名单** —— 内核只认这六种（`kernel.ts` 会校验）。
 *
 * 注意没有"删除"：世界里的事物可以被移动、改名、改属性，但不能凭空消失
 * （她的世界不该有"东西突然没了"这种操作；真需要下线就移到别处或改属性）。
 */
export type WorldOperation =
  | { op: 'create'; entity: EntityInput }
  | {
      op: 'update'
      id: string
      changes: { name?: string; attributes?: Record<string, WorldAttribute | null> }
    }
  | { op: 'move'; id: string; location: string | null; owner?: string | null }
  | { op: 'action.start'; action: ActionInput }
  | { op: 'action.finish'; id: string; status: Exclude<ActionStatus, 'pending'>; reason?: string }
  | { op: 'say'; actorId: string; text: string; audience?: string[] }

/** 提交前的请求：**World-LLM 产出的是这个，不是文件写入**。 */
export interface TransactionProposal {
  /**
   * 幂等键。同键的提案只生效一次 —— 防"超时重试造成重复结算"。
   * World-LLM 每次提案都必须给一个（建议用 `correlationId` + 序号构造）。
   */
  idempotencyKey: string
  actorId?: string
  /**
   * 乐观并发：提案所依据的实体版本。
   * `null` 表示"该实体应当不存在"（创建语义）；省略表示不检查。
   * 不符则整批拒绝 —— 防"基于旧感知改新状态"。
   */
  expectedVersions?: Record<string, number | null>
  /** 生效时刻（世界时间 TU）；省略 = 提交时刻。 */
  effectiveAt?: number
  operations: WorldOperation[]
  /** 来源标记（`world-llm` / `bootstrap` / `admin`…），进日志便于审计。 */
  source?: string
  correlationId?: string
}

/** 她说的一句话（`say` 操作的结果）—— 观测投影会用它。 */
export interface Utterance {
  /** 事件 id：`<sequence>:<index>`，稳定且可去重。 */
  id: string
  speakerId: string
  text: string
  at: number
  audience?: string[]
  /**
   * 说话时说话人在哪儿（`place` 的 id）。
   *
   * 观测投影要按地点过滤（"在屋里听得到屋里的话，听不到街上的"）——
   * 而话语的**位置**不写在文本里，只能记在这里。老日志可能没有这个字段（视为"地点不明"，
   * 投影时按"到处都能听到"处理，避免历史话语突然消失）。
   */
  location?: string
}

export interface WorldSnapshot {
  schemaVersion: 1
  /** 已提交的事务数（从 1 开始；0 = 空世界）。 */
  sequence: number
  effectiveAt: number
  entities: Record<string, WorldEntity>
  actions: Record<string, WorldAction>
  /** 只追加的说话记录（可裁剪，见 `KEEP_UTTERANCES`）。 */
  utterances: Utterance[]
}

/** 日志里的一行：一个已提交的事务。 */
export interface CommittedTransaction {
  sequence: number
  committedAt: number
  proposal: TransactionProposal
  changedEntityIds: string[]
  /** 这条事务产生的说话事件 id（`say` 操作的产物）。 */
  utteranceIds: string[]
}

/** 空世界（`sequence: 0` = 尚未创世）。 */
export function emptyWorld(): WorldSnapshot {
  return { schemaVersion: 1, sequence: 0, effectiveAt: 0, entities: {}, actions: {}, utterances: [] }
}

/** 说话记录保留上限（重放时只留尾部；世界不用它当历史档案，档案在事务日志里）。 */
export const KEEP_UTTERANCES = 200

/**
 * 拒绝 JSON 会**静默改写或丢弃**的值，以及不安全的键。
 *
 * 这不是防御性编程的洁癖：权威状态要能被 `JSON.stringify` 无损往返、能被重放。
 * `NaN` 会被写成 `null`、`undefined` 会消失、`__proto__` 会污染原型 —— 每一种都会让
 * "重放得到的快照"与"当时的内存快照"不同，而那正是内核存在的意义。
 */
export function assertJson(value: unknown, path = 'value'): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJson(item, `${path}[${index}]`)
    })
    return
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      assertSafeKey(key)
      assertJson(item, `${path}.${key}`)
    }
    return
  }
  throw new KernelError('INVALID_JSON', `${path} 只能包含有限 JSON 值（收到 ${describe(value)}）`)
}

/** 拒绝不安全的键名（原型污染与空键）。 */
export function assertSafeKey(key: string): void {
  if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new KernelError('INVALID_ID', `非法标识符：${JSON.stringify(key)}`)
  }
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function describe(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return 'function'
  return typeof value
}

/**
 * 把一条操作应用到快照（**纯函数**：返回新快照，不改入参）。
 *
 * ⚠️ 它假定**已经过校验**（`kernel.ts` 先整批校验、再逐条应用）——
 * 内部只做防御性断言。校验与应用分离是刻意的：
 * "整批校验"才能支持前向引用（同批创建 A 与引用 A 的 B），
 * 而"逐条应用"让重放逻辑保持线性可读。
 */
export function applyOperation(snapshot: WorldSnapshot, operation: WorldOperation, at: number): WorldSnapshot {
  const next = clone(snapshot)
  next.effectiveAt = at

  switch (operation.op) {
    case 'create': {
      const { entity } = operation
      assertSafeKey(entity.id)
      if (next.entities[entity.id] !== undefined) {
        throw new KernelError('DUPLICATE_ENTITY', `实体已存在：${entity.id}`)
      }
      next.entities[entity.id] = {
        ...clone(entity),
        attributes: clone(entity.attributes ?? {}),
        revision: 1,
      }
      break
    }

    case 'update': {
      const target = requireEntity(next, operation.id)
      const patch = operation.changes
      if (patch.name !== undefined) target.name = patch.name
      if (patch.attributes !== undefined) {
        for (const [key, attribute] of Object.entries(patch.attributes)) {
          assertSafeKey(key)
          if (attribute === null) delete target.attributes[key]
          else target.attributes[key] = clone(attribute)
        }
      }
      target.revision += 1
      break
    }

    case 'move': {
      const target = requireEntity(next, operation.id)
      target.location = operation.location
      if (operation.owner !== undefined) target.owner = operation.owner
      target.revision += 1
      break
    }

    case 'action.start': {
      const { action } = operation
      assertSafeKey(action.id)
      if (next.actions[action.id] !== undefined) {
        throw new KernelError('DUPLICATE_ACTION', `动作已存在：${action.id}`)
      }
      const targetVersions: Record<string, number> = {}
      for (const id of action.targetIds ?? []) {
        const target = next.entities[id]
        if (target !== undefined) targetVersions[id] = target.revision
      }
      next.actions[action.id] = {
        ...clone(action),
        status: 'pending',
        startedAt: at,
        targetVersions,
      }
      break
    }

    case 'action.finish': {
      const action = next.actions[operation.id]
      if (action === undefined) throw new KernelError('UNKNOWN_ACTION', `动作不存在：${operation.id}`)
      action.status = operation.status
      action.finishedAt = at
      if (operation.reason !== undefined) action.reason = operation.reason
      break
    }

    case 'say': {
      const speaker = next.entities[operation.actorId]
      const index = next.utterances.length
      next.utterances.push({
        id: `${next.sequence + 1}:${index}`,
        speakerId: operation.actorId,
        text: operation.text,
        at,
        ...(operation.audience === undefined ? {} : { audience: [...operation.audience] }),
        // 位置从说话人**当前**所在地取（观测投影按地点过滤要用；见 `Utterance.location`）
        ...(speaker?.location === undefined || speaker.location === null
          ? {}
          : { location: speaker.location }),
      })
      if (next.utterances.length > KEEP_UTTERANCES) {
        next.utterances = next.utterances.slice(-KEEP_UTTERANCES)
      }
      break
    }
  }

  return next
}

/** 取实体，不在就抛（`applyOperation` 的防御性断言用）。 */
function requireEntity(snapshot: WorldSnapshot, id: string): WorldEntity {
  const entity = snapshot.entities[id]
  if (entity === undefined) throw new KernelError('UNKNOWN_ENTITY', `实体不存在：${id}`)
  return entity
}