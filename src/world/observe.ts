/**
 * 观测投影 —— **她不是全知的**（T24a，spec §6.7）。
 *
 * 这是"她的世界"与"一张数据库表"的分界线：`observe()` 只返回**她在哪儿、那儿能感知到什么**。
 * 别处的家具、抽屉里的东西、`hidden` 属性里的世界真相 —— 都不进她的上下文。
 *
 * ## 两条设计纪律
 *
 *   ① **句柄而非内部 id**：观测里的每条实体带 `seen:<n>` 句柄。模型用它指目标，
 *      **不能猜数据库 id**（猜 id 意味着它能指到没见过的东西）。句柄→真实 id 的映射
 *      单独留在 `ObservationResult.handles` 里，**只给运行时**，与给模型的观测物理分开放
 *      —— 这样"误把内部 id 发给模型"在结构上就不可能发生。
 *   ② **可见性是投影的一部分，不是查询的一部分**：`hidden` 永远不出现；
 *      `owner` 属性只有主人自己看得见（别人看到的是"有个东西"，不是"他的东西里有什么"）。
 *
 * ## 三种模态
 *
 *   · **周围**（`focus: 'around'`，默认）—— 按位置投影（下面的规则表）
 *   · **手机**（`focus: 'phone'`）—— 看手机里的消息。那些消息是**外部世界**（QQ）来的，
 *     不是世界内部的实体行为 —— 所以它们作为**参数**传入（`phoneMessages`），
 *     而不是假装成"世界里的某个实体说了话"（群里有几百人，没必要为他们建 actor）
 *
 * ## 位置投影的规则（我们规模的"视野"）
 *
 * | 她能看到 | 详细程度 |
 * |---|---|
 * | 她自己 | 完整（含 owner 属性） |
 * | **同地点**的实体 | 完整（public 属性；owner 属性仅当主人是她） |
 * | 她所在的 place | 名字 |
 * | **同级** place（她的位置的兄弟） | **只有名字** —— 这是"窗外有条街"的建模 |
 * | 更深处（别的地点里的东西） | **完全不可见** |
 *
 * ⚠️ 刻意不做：视线遮挡、距离衰减、光照 —— 那是物理引擎的活，我们不把提示词当物理引擎
 * （参照框架文档的原话）。世界很小，位置 + 一层同级视野就够了。
 */
import type { EntityKind, JsonValue, WorldAttribute, WorldSnapshot } from './state.ts'

/** 外部世界（QQ）传来的一条消息 —— 她"在手机里"看到的。 */
export interface PhoneMessage {
  /** 外部消息 id（QQ 的 message_id），用于去重。 */
  id: string
  /** 发送者（昵称，人可读）。 */
  speaker: string
  text: string
  /** 世界时刻（外部时间已换算）。 */
  at: number
}

/** 观测里的一条实体（**句柄而非内部 id**）。 */
export interface ObservedEntity {
  /** 句柄：`seen:<n>`。 */
  handle: string
  kind: EntityKind
  name: string
  /** 是不是她自己。 */
  self: boolean
  /** 可见属性（已按可见性过滤）。 */
  attributes: Record<string, JsonValue>
  /** 它所在位置（句柄）——只在同一次观测内可解析；不在观测内时省略。 */
  locationHandle?: string
  /** 只给了名字的"远景"（同级地点）——她知道"外面有条街"，但看不到街上有什么。 */
  distant?: boolean
}

/** 观测里的一句话。 */
export interface ObservedUtterance {
  id: string
  /** 说话人的句柄（世界内的实体）或昵称（手机里的消息）。 */
  speaker: string
  text: string
  at: number
  /** 来自手机（外部世界）而不是世界内部。 */
  fromPhone?: boolean
}

/** 给模型（或渲染层）的观测 —— 里面**没有任何内部 id**。 */
export interface Observation {
  /** 本次观测 id（`basedOnObservationId` 引用它）。 */
  observationId: string
  at: number
  /** 她所在位置的句柄。 */
  placeHandle?: string
  entities: ObservedEntity[]
  utterances: ObservedUtterance[]
}

/** 观测 + 句柄映射 —— **给运行时**（解析模型给的目标），不进模型上下文。 */
export interface ObservationResult {
  observation: Observation
  /** 句柄 → 内部 id。 */
  handles: ReadonlyMap<string, string>
}

export interface ObserveOptions {
  /** 看哪儿。默认 `around`（周围）。 */
  focus?: 'around' | 'phone'
  /** 「手机里的消息」—— 外部世界（QQ）传来的。只有 `focus: 'phone'` 时用。 */
  phoneMessages?: readonly PhoneMessage[]
  /** 观测 id（运行时给；省略时按世界序号生成）。 */
  observationId?: string
  /** 最多看几条实体（防上下文爆炸；默认 40）。 */
  limit?: number
  /** 最多带几句最近的话（默认 12）。 */
  utteranceLimit?: number
}

const DEFAULT_LIMIT = 40
const DEFAULT_UTTERANCE_LIMIT = 12

/**
 * 投影出"她现在能感知到的"。
 *
 * @throws 她（`actorId`）不在世界里时 —— 这是调用方的错，**不返回空观测掩盖**
 * （空观测会让"她不存在"看起来像"她周围什么都没有"）。
 */
export function observe(snapshot: WorldSnapshot, actorId: string, options: ObserveOptions = {}): ObservationResult {
  const self = snapshot.entities[actorId]
  if (self === undefined) throw new Error(`观测失败：世界里没有「${actorId}」（她必须先是世界的实体）`)

  const limit = options.limit ?? DEFAULT_LIMIT
  const handles = new Map<string, string>()
  const entities: ObservedEntity[] = []

  /** 登记一条实体并分配句柄。 */
  const push = (id: string, entity: (typeof snapshot.entities)[string], distant: boolean): void => {
    const handle = `seen:${entities.length}`
    handles.set(handle, id)
    entities.push({
      handle,
      kind: entity.kind,
      name: entity.name,
      self: id === actorId,
      attributes: visibleAttributes(entity.attributes, entity, id, actorId),
      // 位置句柄只在"那个地点也在本次观测里"时可解析
      ...(entity.location === null ? {} : { locationHandle: handleOf(entity.location) }),
      ...(distant ? { distant: true } : {}),
    })
  }
  /** 某个地点在本次观测里的句柄（还没登记就返回 undefined）。 */
  const handleOf = (id: string): string | undefined => {
    for (const [handle, target] of handles) {
      if (target === id) return handle
    }
    return undefined
  }

  // ── 手机模态：她看到的是"手机里的消息"，而不是周围有什么 ──────────────
  if (options.focus === 'phone') {
    const phoneInHand = snapshot.entities['phone']
    if (phoneInHand !== undefined && phoneInHand.location === self.location) push('phone', phoneInHand, false)

    const messages = (options.phoneMessages ?? []).slice(-(options.utteranceLimit ?? DEFAULT_UTTERANCE_LIMIT))
    return {
      observation: {
        observationId: options.observationId ?? `obs:${snapshot.sequence}`,
        at: snapshot.effectiveAt,
        entities,
        utterances: messages.map((message) => ({
          id: message.id,
          speaker: message.speaker,
          text: message.text,
          at: message.at,
          fromPhone: true,
        })),
      },
      handles,
    }
  }

  // ── 周围模态：位置投影 ────────────────────────────────────────────────
  const here = self.location

  // ① 她自己
  push(actorId, self, false)

  // ② 同地点的实体（她在哪儿，就看到那儿的全部）
  if (here !== null) {
    const place = snapshot.entities[here]
    if (place !== undefined) push(here, place, false) // 她所在的房间/街道本身
  }
  for (const [id, entity] of Object.entries(snapshot.entities)) {
    if (id === actorId) continue
    if (entity.location !== here) continue
    if (entities.length >= limit) break
    push(id, entity, false)
  }

  // ③ 同级 place —— **只有名字**（"窗外有一条很宽的街道"）
  const current = here === null ? undefined : snapshot.entities[here]
  const siblingLocation = current?.location ?? null
  for (const [id, entity] of Object.entries(snapshot.entities)) {
    if (entity.kind !== 'place') continue
    if (id === here) continue
    if (entity.location !== siblingLocation) continue
    if (entities.length >= limit) break
    push(id, entity, true)
  }

  // ── 她听得到的话：同地点 + 地点不明（老日志）的话 ──────────────────────
  const utteranceLimit = options.utteranceLimit ?? DEFAULT_UTTERANCE_LIMIT
  const utterances: ObservedUtterance[] = []
  for (const utterance of snapshot.utterances) {
    if (utterance.location !== undefined && utterance.location !== here) continue // 别处的话听不到
    const speakerHandle = handleOf(utterance.speakerId)
    utterances.push({
      id: utterance.id,
      // 说话人不在视野内 → 只给"有人说过话"，不给句柄（她听得到声音，看不见人）
      speaker: speakerHandle ?? '看不见的人',
      text: utterance.text,
      at: utterance.at,
    })
  }

  return {
    observation: {
      observationId: options.observationId ?? `obs:${snapshot.sequence}`,
      at: snapshot.effectiveAt,
      ...(here === null ? {} : { placeHandle: handleOf(here) }),
      entities,
      utterances: utterances.slice(-utteranceLimit),
    },
    handles,
  }
}

/**
 * 按可见性过滤属性。
 *
 *   · `hidden` —— **永不出现**（谁都不该从观测里读到世界真相）
 *   · `owner`  —— 只有"主人是她自己"时可见。别人的东西里有什么，她看不到（只能看到
 *                 "有这个物件"——物件的存在本身是 public 事实）
 *   · `public` —— 同观测内可见
 */
function visibleAttributes(
  attributes: Record<string, WorldAttribute>,
  entity: { owner?: string | null },
  entityId: string,
  actorId: string,
): Record<string, JsonValue> {
  const visible: Record<string, JsonValue> = {}
  for (const [key, attribute] of Object.entries(attributes)) {
    if (attribute.visibility === 'hidden') continue
    if (attribute.visibility === 'owner') {
      // 主人是谁？优先实体自己的 owner；没有 owner 的实体，只有她自己的属性对她可见
      const owner = entity.owner ?? (entityId === actorId ? actorId : null)
      if (owner !== actorId) continue
    }
    visible[key] = attribute.value
  }
  return visible
}