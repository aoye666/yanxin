/**
 * 创世 —— 把 `persona/world.md` 变成世界的**第一批实体**（T27，spec §6.7）。
 *
 * ## 流程
 *
 * ```
 * world.md（人格侧的散文） → World-LLM 提取 → 一批 create 操作
 *   → 内核实测校验（引用完整 / 根地点 / 必须有她）→ 提交（唯一一次创世）
 * ```
 *
 * 世界文档是**散文**（"小研在一个小房子里，外面有一条很宽的街道"），不是数据 ——
 * 所以第一次结构化必须由模型做。但模型做的是**提取**，不是**裁定**：它的输出照样
 * 过内核校验，不过就带着机读诊断重来（与 T25 的裁定者同一套纪律）。
 *
 * ## 三条硬规矩
 *
 *   · **只允许 `create`** —— 创世是从零长出世界，没有东西可以"改"。所以这里的提案
 *     由**我们**构造（模型给的是实体清单，不是操作数组）：它想说 `update` 都没门。
 *   · **根地点是 `null`** —— 房子、街道没有"所在位置"，它们是世界的根。只有屋里的
 *     物件与她自己有 `location`。
 *   · **整批校验引用** —— 房子引用街道、手机引用房子……都能在同一批里成立
 *     （内核的校验按"批后的候选世界"算，支持前向引用），但指向批外的一律拒。
 *
 * ## 失败**不覆盖**（这一条是验收里点名的）
 *
 * 创世失败时**一个字节都不写**：不 append 日志、不建空世界、不改旧快照。
 * 世界要么是"创世前的样子"，要么是"刚创世的样子"，不会出现"被清空的世界"——
 * 后者才是最坏的结果（她的家当没了，而且没人报错）。
 *
 * ## 与 T29（初始化向导的创世步骤）的关系
 *
 * 本文件是**可测内核**：`world.md` 的正文与模型调用都由调用方传入。T29 负责把
 * 它接到向导上（读 `persona/world.md`、写 `clock.json`、报错给用户看）。
 */
import { KernelError, type KernelDiagnostic } from './error.ts'
import type { CallWorldModel } from './arbiter.ts'
import type { WorldKernel } from './kernel.ts'
import type { EntityKind, JsonValue, TransactionProposal, WorldAttribute, WorldOperation } from './state.ts'

/** 让创世模型用的工具 —— 它**只能**通过这一个口子给出世界。 */
export const INSTALL_WORLD = {
  name: 'install_world',
  description:
    '把世界文档里描述的世界装进来：一串实体（她、房子、街道、屋里的东西……）。' +
    '这是世界的**第一天**，所以只有"创建"——没有东西可以修改。',
  schema: {
    type: 'object',
    required: ['entities'],
    additionalProperties: false,
    properties: {
      entities: {
        type: 'array',
        description: '世界里的全部实体。引用必须指向这份清单里的 id（同一批里可以互相引用）。',
        items: {
          type: 'object',
          required: ['id', 'kind', 'name', 'location'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: '稳定的英文/拼音 id（如 house、street、yanxin、phone）。' },
            kind: { type: 'string', enum: ['actor', 'place', 'object'] },
            name: { type: 'string', description: '她看到的名字（中文，取自世界文档）。' },
            location: {
              type: ['string', 'null'],
              description: '所在地点的 id；根地点（房子、街道）用 null。',
            },
            owner: { type: ['string', 'null'], description: '物件的主人（actor 的 id）；其余留空。' },
            attributes: {
              type: 'object',
              description: '属性：键 → { value, visibility }。visibility 取 public / owner / hidden。',
              additionalProperties: true,
            },
          },
        },
      },
    },
  } as JsonValue,
} as const

export interface GenesisOptions {
  kernel: WorldKernel
  /** `persona/world.md` 的正文（散文）。 */
  worldDoc: string
  /** 世界模型调用（T27 的接线点；测试注入 mock）。 */
  callModel: CallWorldModel
  /** 她自己的实体 id（必须出现在清单里 —— 世界里没有她，就没人过日子了）。 */
  selfId: string
  /** 最多让模型改几次（默认 2 —— 一次原稿 + 一次带诊断的修正）。 */
  maxAttempts?: number
  warn?: (message: string) => void
}

export interface GenesisResult {
  /** 创世事务的序号（世界从 1 开始计数）。 */
  sequence: number
  entityIds: string[]
  /** 用了几次模型调用才成功（1 = 一次就对）。 */
  attempts: number
}

/** 创世提案的幂等键（固定：世界只有一次第一天）。 */
export const GENESIS_KEY = 'genesis'

const DEFAULT_MAX_ATTEMPTS = 2

/**
 * 创世。
 *
 * @throws `KernelError('GENESIS_ALREADY_EXISTS')` 世界已经有事务时（**不覆盖**）；
 *   `KernelError('GENESIS_FAILED')` 模型始终给不出合法清单时（附最后一批诊断）。
 */
export async function genesis(options: GenesisOptions): Promise<GenesisResult> {
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  // ① 世界已经有东西了 —— 创世是"第一天"的事，拒绝而不是覆盖
  if (!options.kernel.isEmpty) {
    throw new KernelError(
      'GENESIS_ALREADY_EXISTS',
      `世界已经有 ${options.kernel.transactionCount} 条事务了 —— 创世不会覆盖既有世界`,
    )
  }

  const base = renderGenesisPrompt(options.worldDoc, options.selfId)
  let prompt = base
  let lastDiagnostics: KernelDiagnostic[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reply = await options.callModel({ prompt, tool: INSTALL_WORLD })
    const entities = readEntities(reply.arguments)

    if (entities === undefined) {
      lastDiagnostics = [
        {
          code: 'GENESIS_SHAPE',
          reason: 'missing',
          message: `没有用 ${INSTALL_WORLD.name} 给出 entities 数组`,
        },
      ]
      prompt = `${base}${renderFeedback(lastDiagnostics, attempt)}`
      warn(`[world-genesis] 第 ${attempt} 次没给出实体清单`)
      continue
    }

    const proposal = buildProposal(entities)
    const diagnostics = [...checkGenesis(proposal, options.selfId), ...options.kernel.check(proposal)]
    if (diagnostics.length === 0) {
      const result = await options.kernel.submit(proposal)
      return { sequence: result.sequence, entityIds: result.changedEntityIds, attempts: attempt }
    }

    lastDiagnostics = diagnostics
    prompt = `${base}${renderFeedback(diagnostics, attempt)}`
    warn(
      `[world-genesis] 第 ${attempt} 次清单未通过校验（${diagnostics.length} 条）：${diagnostics[0]?.message ?? ''}`,
    )
  }

  // ② 用尽重试：**一个字节都没写**（提案从未提交）
  throw new KernelError('GENESIS_FAILED', `${maxAttempts} 次都没给出合法的世界清单（旧状态未改动）`, lastDiagnostics)
}

// ── 组装 ──────────────────────────────────────────────────────────────────

/**
 * 模型给的实体清单 → 创世提案。
 *
 * ⚠️ 操作**由这里**构造：全是 `create`。模型没有机会写别的操作类型
 * （"只允许 create"于是是**结构性**保证的，不是靠提示词祈祷）。
 */
export function buildProposal(entities: readonly EntityInputLike[]): TransactionProposal {
  const operations: WorldOperation[] = entities.map((entity) => ({
    op: 'create',
    entity: {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      location: entity.location,
      ...(entity.owner === undefined ? {} : { owner: entity.owner }),
      ...(entity.attributes === undefined ? {} : { attributes: entity.attributes }),
    },
  }))

  return {
    idempotencyKey: GENESIS_KEY,
    // 创世的世界时刻是 0 —— 纪元由 T=0 定义（T21 的 clock），不是"提交那一刻"
    effectiveAt: 0,
    operations,
    source: 'bootstrap',
  }
}

/**
 * 创世**专有**的规矩（内核不知道的那些）。
 *
 * 内核管的是"操作合法"；这里管的是"这算不算一个能过日子的世界"：
 * 必须有她、必须至少有一个地点、根地点必须真的是根（`location: null`）。
 */
export function checkGenesis(proposal: TransactionProposal, selfId: string): KernelDiagnostic[] {
  const diagnostics: KernelDiagnostic[] = []
  const creations = proposal.operations.filter(
    (operation): operation is Extract<WorldOperation, { op: 'create' }> => operation.op === 'create',
  )

  for (const [index, operation] of proposal.operations.entries()) {
    if (operation.op === 'create') continue
    diagnostics.push({
      code: 'GENESIS_OP_NOT_ALLOWED',
      opIndex: index,
      op: operation.op,
      reason: 'unknown_op',
      message: `创世只允许 create（收到 ${operation.op}）`,
    })
  }

  const self = creations.find((operation) => operation.entity.id === selfId)
  if (self === undefined) {
    diagnostics.push({
      code: 'GENESIS_NO_SELF',
      entityId: selfId,
      reason: 'missing',
      message: `清单里没有她自己（${selfId}）—— 世界里没有她，就没人过日子`,
    })
  } else if (self.entity.kind !== 'actor') {
    diagnostics.push({
      code: 'GENESIS_SELF_NOT_ACTOR',
      entityId: selfId,
      field: 'id',
      reason: 'wrong_kind',
      expectedKinds: ['actor'],
      actualKind: self.entity.kind,
      message: `她自己必须是 actor（收到 ${self.entity.kind}）`,
    })
  }

  const places = creations.filter((operation) => operation.entity.kind === 'place')
  if (places.length === 0) {
    diagnostics.push({
      code: 'GENESIS_NO_PLACE',
      reason: 'missing',
      message: '一个地点都没有 —— 她总得待在一个地方',
    })
  } else if (!places.some((place) => place.entity.location === null)) {
    // 全是"相对位置"而没有根：内核的成环检测会拒，但那条诊断对模型不够直白 ——
    // 这里先说清楚"至少留一个根地点"
    diagnostics.push({
      code: 'GENESIS_NO_ROOT_PLACE',
      reason: 'cycle',
      message: '地点里一个根都没有（全部有 location）—— 至少有一个地点用 location: null 当世界的根',
    })
  }

  return diagnostics
}

// ── 提示词与解析 ───────────────────────────────────────────────────────────

/** 渲染创世提示词（世界文档 + 交付要求）。 */
export function renderGenesisPrompt(worldDoc: string, selfId: string): string {
  const lines: string[] = []
  lines.push('# 你的任务')
  lines.push('把下面这份世界文档**提取**成结构化实体清单，用 install_world 交上来。')
  lines.push('你不是在润色文档，也不是在续写 —— 只是把文档里已经写明的世界装进来。')
  lines.push('')
  lines.push('## 规矩')
  lines.push(`- 清单里必须有她自己（id 用 \`${selfId}\`，kind 用 actor）—— 其他 id 你自己取（英文/拼音，稳定好读）`)
  lines.push('- 只创建、不修改：这是世界的第一天')
  lines.push('- **根地点**（房子、街道）的 location 用 null；屋里的东西与她自己的 location 指向房子')
  lines.push('- 引用必须指向这份清单里的 id（可以互相引用，但不能指向清单外）')
  lines.push('- 实体要"够过日子"而不是"够完整"：十来条即可（她 + 几处地点 + 屋里的要紧东西）')
  lines.push('- 属性用 `{"键": {"value": …, "visibility": "public" | "owner" | "hidden"}}` 的形状')
  lines.push('')
  lines.push('# 世界文档')
  lines.push(worldDoc.trim())
  return lines.join('\n')
}

/** 把诊断喂回去（让她改对，而不是瞎猜重试）。 */
function renderFeedback(diagnostics: readonly KernelDiagnostic[], attempt: number): string {
  return [
    '',
    '',
    `## 上一次的清单被拒（第 ${attempt} 次）`,
    ...diagnostics.map((diagnostic) => {
      const where = diagnostic.opIndex === undefined ? '' : `第 ${diagnostic.opIndex + 1} 条：`
      const target = diagnostic.targetId === undefined ? '' : `（目标 ${diagnostic.targetId}）`
      return `- ${where}${diagnostic.code}${target} ${diagnostic.message}`
    }),
    '请修正后重新提交完整的清单（不是只交改动的那几条）。',
  ].join('\n')
}

/** 模型给的实体（未校验的形状）。 */
interface EntityInputLike {
  id: string
  kind: EntityKind
  name: string
  location: string | null
  owner?: string | null
  attributes?: Record<string, WorldAttribute>
}

const KINDS = new Set<EntityKind>(['actor', 'place', 'object'])

/**
 * 从模型的工具参数里读出实体清单（**只做形状检查**，语义交给内核）。
 *
 * 坏形状返回 `undefined`（当作"没给出清单"，喂反馈让它重来）——
 * 而不是抛错：模型给错形状是可修正的，抛错就把它一次失误变成整次创世失败。
 */
function readEntities(args: unknown): EntityInputLike[] | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const raw = (args as { entities?: unknown }).entities
  if (!Array.isArray(raw) || raw.length === 0) return undefined

  const entities: EntityInputLike[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return undefined
    const entity = item as Record<string, unknown>
    const { id, kind, name, location } = entity
    if (typeof id !== 'string' || id === '') return undefined
    if (typeof kind !== 'string' || !KINDS.has(kind as EntityKind)) return undefined
    if (typeof name !== 'string' || name === '') return undefined
    if (location !== null && typeof location !== 'string') return undefined

    const owner = entity.owner
    if (owner !== undefined && owner !== null && typeof owner !== 'string') return undefined
    const attributes = entity.attributes
    if (attributes !== undefined && (attributes === null || typeof attributes !== 'object')) return undefined

    entities.push({
      id,
      kind: kind as EntityKind,
      name,
      location,
      ...(owner === undefined ? {} : { owner: owner as string | null }),
      ...(attributes === undefined ? {} : { attributes: attributes as Record<string, WorldAttribute> }),
    })
  }
  return entities
}