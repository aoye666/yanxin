/**
 * 世界内核 —— **唯一写入口**（spec §6.7，ADR 0015）。
 *
 * ## 职责
 *
 * 1. **校验**：模型（World-LLM）提交的提案先过四道关 —— 引用完整性 / 类目合法 /
 *    幂等（`idempotencyKey`）/ 乐观并发（`expectedVersions`）；不过则抛 `KernelError`
 *    并附**机读诊断**（`error.ts`），让模型自己改了重提。
 * 2. **原子提交**：通过后构造一条 `CommittedTransaction`，**一次 append** 进
 *    `world-transactions.jsonl`（单行 JSON，永不原地改写）。
 * 3. **重放**：`open()` 时读日志逐条应用，得到快照 —— 权威状态是"日志 + 重放"，
 *    不是某个可被随手编辑的文件。
 *
 * ## 为什么模型不能直接写状态
 *
 * 参照框架的教训（我们照抄的是纪律，不是它的 26.6k 行）：模型写文档时保证不了世界自洽 ——
 * 引用不存在的东西、把状态改成自相矛盾、超时重试时重复结算。这三种错**都不该靠提示词避免**，
 * 该由一个几十行的校验器拒绝。校验的代价是 O(操作数)，收益是"世界永远自洽"。
 *
 * ## 崩溃语义
 *
 *   · **写入中断**：只容忍**最后一行**不完整（append 被截断）—— 重放时丢弃并 warn；
 *     中间出现坏行说明文件被外力损坏，**抛错不掩盖**。
 *   · **先写日志、后应用内存**：日志是权威。若进程在 append 后、应用前崩溃，
 *     重启重放会补上这一次 —— 不会丢。
 *
 * ## 与时钟的接缝
 *
 * 本文件**不自己造世界时间**：`effectiveAt` 由提案给（World-LLM 知道现在几点），
 * 缺省时用 `options.now()`。T21 的 `clock` 就绪后注入它（`now: () => clock.now()`），
 * 在那之前默认是现实时间的毫秒数 —— 只是个代理，不影响本文件的逻辑。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { describeError as describe } from '../describe.ts'
import { KernelError, diagnostic, type KernelDiagnostic } from './error.ts'
import {
  assertJson,
  assertSafeKey,
  applyOperation,
  clone,
  emptyWorld,
  KEEP_UTTERANCES,
  type CommittedTransaction,
  type EntityKind,
  type TransactionProposal,
  type Utterance,
  type WorldEntity,
  type WorldOperation,
  type WorldSnapshot,
} from './state.ts'

/** 操作白名单（类目校验的依据）。 */
const KNOWN_OPS = new Set(['create', 'update', 'move', 'action.start', 'action.finish', 'say'])

/**
 * 一个操作的**形状**问题（缺哪个字段、怎么改）；形状没问题就是 `undefined`。
 *
 * 存在的理由：模型的提案是外部数据，**字段可能整个缺席** —— 而应用阶段会读
 * `changes.name` / `action.id` 这类字段，缺席时抛的是裸 TypeError
 * （`Cannot read properties of undefined (reading 'name')`），模型拿到它无从下手。
 * 把它挡在**校验**这一层，模型就会收到一条能照着改的诊断（内核的反馈重试才有意义）。
 *
 * 只查"不查就会崩"或"不查就会写出坏数据"的字段，不做完整 schema 校验：
 * 类目/引用/版本那几遍已经在别处做了。
 */
export function describeShapeProblem(
  operation: WorldOperation,
): { field: NonNullable<KernelDiagnostic['field']>; message: string } | undefined {
  const op = (operation as { op?: unknown }).op
  if (typeof op !== 'string' || !KNOWN_OPS.has(op)) return undefined // 类目本身不合法：① 已报

  if (op === 'create') {
    const entity = (operation as { entity?: { id?: unknown; kind?: unknown } }).entity
    if (entity === undefined || entity === null || typeof entity !== 'object') {
      return { field: 'entity', message: 'create 少了 entity（要建什么）' }
    }
    if (typeof entity.id !== 'string' || entity.id === '') {
      return { field: 'entity.id', message: 'create 的 entity 少了 id（稳定标识，别用中文名）' }
    }
    if (typeof entity.kind !== 'string' || entity.kind === '') {
      return { field: 'entity.kind', message: 'create 的 entity 少了 kind（actor / place / object）' }
    }
    return undefined
  }

  if (op === 'update') {
    const changes = (operation as { changes?: unknown }).changes
    if (changes === undefined || changes === null || typeof changes !== 'object') {
      return { field: 'changes', message: 'update 少了 changes（要改成什么）：至少给 { name } 或 { attributes }' }
    }
    return undefined
  }

  if (op === 'action.start') {
    const action = (operation as { action?: { id?: unknown } }).action
    if (action === undefined || action === null || typeof action !== 'object') {
      return { field: 'action', message: 'action.start 少了 action（要开始什么动作）' }
    }
    if (typeof action.id !== 'string' || action.id === '') {
      return { field: 'action.id', message: 'action.start 的 action 少了 id' }
    }
    return undefined
  }

  if (op === 'action.finish') {
    const id = (operation as { id?: unknown }).id
    if (typeof id !== 'string' || id === '') {
      return { field: 'id', message: 'action.finish 少了 id（要结算哪个动作）' }
    }
    // ⚠️ `status` 必须是三选一：2026-09-27 夜间实测，模型给过 `"success"` ——
    //    不查的话它会**原样写进世界状态**，而下游全部按 `status === 'completed'` 判
    //    （"行动完成"的通知就永远不触发，她永远等不到"想起来了"）。
    const status = (operation as { status?: unknown }).status
    if (status !== 'completed' && status !== 'cancelled' && status !== 'failed') {
      return {
        field: 'status',
        message: 'action.finish 的 status 要是 completed / cancelled / failed 之一（收到 '
          + `${typeof status === 'string' ? `"${status}"` : String(status)}）`,
      }
    }
    // 多余字段（模型爱把"顺便改状态"塞进来）**拒掉并教它正确写法** ——
    // 静默忽略会让它以为状态改成功了（实际什么都没发生），那比报错更糟。
    const extras = Object.keys(operation as Record<string, unknown>).filter(
      (key) => key !== 'op' && key !== 'id' && key !== 'status' && key !== 'reason',
    )
    if (extras.length > 0) {
      return {
        field: 'op', // 多余字段没有独立的 field 名；键名在 message 里说清
        message: `action.finish 只认 id / status / reason，多了 ${extras.join('、')} —— 要改实体状态请**单独发一条 update 操作**`,
      }
    }
    return undefined
  }

  if (op === 'move') {
    const id = (operation as { id?: unknown }).id
    if (typeof id !== 'string' || id === '') return { field: 'id', message: 'move 少了 id（移动谁）' }
    return undefined
  }

  // say：说话人与文本都必须在 —— 否则会往世界日志里写一条"没人说的空话"
  const actorId = (operation as { actorId?: unknown }).actorId
  const text = (operation as { text?: unknown }).text
  if (typeof actorId !== 'string' || actorId === '') return { field: 'actorId', message: 'say 少了 actorId（谁在说）' }
  if (typeof text !== 'string' || text.trim() === '') return { field: 'text', message: 'say 少了 text（说什么）' }
  return undefined
}

/** 事务日志文件名（在世界的目录里）。 */
export const TRANSACTION_LOG = 'world-transactions.jsonl'

/** 只读呈现的文件名（给人看的摘要，不是编辑入口）。 */
export const STATUS_EXPORT = 'world-status.md'

export interface KernelOptions {
  /**
   * 世界时间来源。缺省用现实毫秒 —— **只是代理**，T21 的 clock 就绪后注入 TU 时钟。
   */
  now?: () => number
  /**
   * 每次 append **之前**的钩子。测试用它模拟"提交前崩溃"，
   * 确认"日志没写 = 世界没变"。
   */
  beforeAppend?: () => void | Promise<void>
  /** 坏行告警的去处（默认 `console.warn`；测试可注入收集器）。 */
  warn?: (message: string) => void
}

export interface SubmitResult {
  /** 本次提交的序号；**幂等命中时是首次提交的序号**。 */
  sequence: number
  /** 因幂等键重复而被忽略（未产生新事务）。 */
  duplicated: boolean
  changedEntityIds: string[]
  /**
   * 本次提交**产生的说话事件**（`say` 操作的产物）。
   *
   * ⚠️ 真实的发射链路走的是**快照**（`loop.emit()` → `outbox.deliver(snapshot.utterances)`，
   * 回执闸门去重）—— 本字段是"这次提交说了什么"的**测试锚点**（幂等命中时为空、
   * 事件 id 按"当时的长度"编号，这些语义靠它断言）。调用方同样**不该**去数快照的
   * 尾巴：裁剪 `KEEP_UTTERANCES`、同批多条 `say`、串行队列里的后继提交都会让
   * "数尾巴"数错。
   */
  utterances: Utterance[]
}

/**
 * 世界内核。
 *
 * 用 `WorldKernel.open(dir)` 打开（会重放日志）；不要直接 `new`。
 */
export class WorldKernel {
  private snapshotValue: WorldSnapshot = emptyWorld()
  /** 提交串行队列 —— 见 `submit()` 的说明。 */
  private submitQueue: Promise<unknown> = Promise.resolve()
  /** 已提交过的幂等键 → 首次提交的序号。 */
  private readonly committedKeys = new Map<string, number>()
  private readonly dir: string
  private readonly logPath: string
  private readonly options: Required<Pick<KernelOptions, 'now' | 'warn'>> & KernelOptions

  private constructor(
    dir: string,
    options: KernelOptions,
  ) {
    this.dir = dir
    this.logPath = join(dir, TRANSACTION_LOG)
    this.options = {
      now: options.now ?? (() => Date.now()),
      warn: options.warn ?? ((message) => console.warn(message)),
      ...(options.beforeAppend === undefined ? {} : { beforeAppend: options.beforeAppend }),
    }
  }

  /**
   * 打开世界：读事务日志并重放。
   *
   * 目录不存在时会创建（首次创世前调用也安全 —— 得到空世界）。
   */
  static async open(dir: string, options: KernelOptions = {}): Promise<WorldKernel> {
    const kernel = new WorldKernel(dir, options)
    await kernel.replay()
    return kernel
  }

  /** 当前快照（只读语义：调用方**不要**改它，要改就走 `submit`）。 */
  get snapshot(): WorldSnapshot {
    return this.snapshotValue
  }

  /** 已提交的事务数（= 快照的 sequence）。 */
  get transactionCount(): number {
    return this.snapshotValue.sequence
  }

  /** 日志里一行事务都没有（尚未创世）。 */
  get isEmpty(): boolean {
    return this.snapshotValue.sequence === 0
  }

  /**
   * **只校验，不提交** —— 返回诊断列表（空 = 合法）。
   *
   * 给裁定者（T25 的 World-LLM 适配层）做"预校验 + 反馈重试"用：
   * 模型给的提案不合法时，把**机读诊断**喂回给它改（spec §6.7 的"最多 N 轮"），
   * 而不是提交失败后才知道。这里不产生任何副作用（不写日志、不动快照）。
   */
  check(proposal: TransactionProposal): KernelDiagnostic[] {
    assertJson(proposal, 'proposal')
    return this.validate(proposal)
  }

  /**
   * 校验并提交一次提案。
   *
   * ⚠️ **串行化**：三条入口不共享 `WorldLoop.queue`（turn 队列只串 turn）——
   * 工具路提交、`interruptWaiting`、结算定时器都可能**并发**进来。而
   * "校验（同步、读当前快照）→ `await appendFile`"之间存在真实异步窗口：
   * 并发会让两条日志带**同一个 sequence**，更糟的是后者基于过期快照通过校验后
   * append 出应用不了的毒行（日志投毒）。这里用与 clock/outbox 相同的
   * 队列模式把提交变成一次一个。
   */
  async submit(proposal: TransactionProposal): Promise<SubmitResult> {
    const run = () => this.submitNow(proposal)
    const result = this.submitQueue.then(run, run)
    this.submitQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async submitNow(proposal: TransactionProposal): Promise<SubmitResult> {
    // 数据形态先过关：非 JSON 值（NaN/undefined/原型污染键）在这里就被拦下
    assertJson(proposal, 'proposal')

    // 幂等：同键只生效一次。**在完整校验之前判** —— 重试的提案可能带着
    // "已经过时的 expectedVersions"，那不该让它失败（它本来就不该再执行一次）。
    const seen = this.committedKeys.get(proposal.idempotencyKey)
    if (seen !== undefined) {
      // 幂等命中：那次发言在首次提交时已经交付过（回执在 T23 的 outbox 里），
      // 这里不回任何 utterances —— 否则重试提交会让同一句话被投两次
      return { sequence: seen, duplicated: true, changedEntityIds: [], utterances: [] }
    }

    const diagnostics = this.validate(proposal)
    if (diagnostics.length > 0) {
      throw new KernelError(
        'VALIDATION_FAILED',
        `提案未通过校验（${diagnostics.length} 条问题）`,
        diagnostics,
      )
    }

    const sequence = this.snapshotValue.sequence + 1
    // ⚠️ 时钟只读**一次**，两个字段共用：提案没带 `effectiveAt` 时它的缺省是"此刻"，
    //    而重放路径拿的是 `proposal.effectiveAt ?? committedAt`（见 replay 里那行）——
    //    分两次 `now()` 就让同一个事务"当场"和"重放后"差出 1 毫秒，
    //    "日志是权威、重放得到逐位等价快照"这条承诺就只在毫秒边界内成立（T20 断言会随机红）。
    const at = this.options.now()
    const effectiveAt = proposal.effectiveAt ?? at
    const changedEntityIds = collectChanged(proposal.operations)
    // ⚠️ 事件 id 要在 **append 之前**算出来：日志行里的 `utteranceIds` 是"这次说了什么"
    // 的权威记录，事后补写就得原地改文件（append-only 的纪律不允许）
    const utteranceIds = this.predictUtteranceIds(proposal.operations, sequence)
    const transaction: CommittedTransaction = {
      sequence,
      committedAt: at,
      proposal: clone(proposal),
      changedEntityIds,
      utteranceIds,
    }

    // ⚠️ 顺序是刻意的：**先写日志，后应用内存**。日志是权威 ——
    // 若在两者之间崩溃，重启重放会补上这一次（不丢）。
    //
    // ⚠️⚠️ 但这个顺序有个前提：**应用阶段不许失败**。它一旦抛错，日志里就留下一条
    // "写进去了、却应用不了"的**毒行**，重放时那条毒行会让整个世界装载失败
    // （`LOG_CORRUPTED` —— 2026-09-27 夜间隔离实例实测到：agnes 给过一条少 `changes`
    //  的 update，apply 阶段抛裸 TypeError，日志就此带毒）。
    // 形状校验（①·5）本该覆盖所有能失败的情形；这里是**那之后的一道兜底**：
    // 先在一份克隆上整批试应用，真漏了也宁可在这里失败，而不是污染权威日志。
    try {
      let probe = clone(this.snapshotValue)
      for (const operation of transaction.proposal.operations) {
        probe = applyOperation(probe, operation, effectiveAt)
      }
    } catch (error) {
      throw new KernelError(
        'APPLY_FAILED',
        `提案在"试应用"阶段就失败了（校验漏了形状，不该发生）：${describe(error)}`,
      )
    }

    await this.options.beforeAppend?.()
    await appendFile(this.logPath, `${JSON.stringify(transaction)}\n`, 'utf8')

    this.applyTransaction(transaction, effectiveAt)
    return { sequence, duplicated: false, changedEntityIds, utterances: this.collectUtterances(utteranceIds) }
  }

  /**
   * 导出**只读呈现**（`world-status.md`）—— 给人看的摘要。
   *
   * ⚠️ 它**不是**状态编辑入口：想改世界只能走提案 + 校验。
   * 用临时文件 + rename 原子替换（读者永远看不到半个文件）。
   */
  async exportStatus(): Promise<string> {
    const markdown = renderStatus(this.snapshotValue)
    const target = join(this.dir, STATUS_EXPORT)
    const temporary = `${target}.tmp`
    await writeFile(temporary, markdown, 'utf8')
    await rename(temporary, target)
    return markdown
  }

  // ── 校验 ────────────────────────────────────────────────────────────────

  /**
   * 四类校验。返回**全部**问题（不是遇到第一个就停）——
   * 一次把话说清楚，模型能一轮改完，而不是挤牙膏式重试。
   */
  private validate(proposal: TransactionProposal): KernelDiagnostic[] {
    const diagnostics: KernelDiagnostic[] = []

    if (typeof proposal.idempotencyKey !== 'string' || proposal.idempotencyKey === '') {
      diagnostics.push(
        diagnostic({
          code: 'MISSING_IDEMPOTENCY_KEY',
          field: 'idempotencyKey',
          reason: 'missing_key',
          message: 'idempotencyKey 必填 —— 内核靠它防"超时重试造成重复结算"',
        }),
      )
    }

    // ① 类目合法
    proposal.operations.forEach((operation, index) => {
      if (!KNOWN_OPS.has(operation.op)) {
        diagnostics.push(
          diagnostic({
            code: 'UNKNOWN_OPERATION',
            opIndex: index,
            op: String((operation as { op?: unknown }).op),
            field: 'op',
            reason: 'unknown_op',
            message: `未知操作：${String((operation as { op?: unknown }).op)}（只允许 ${[...KNOWN_OPS].join(' / ')}）`,
          }),
        )
      }
    })

    // ①·5 **形状**：模型偶尔漏字段（`{op:'update', id}` 忘了 changes、`{op:'action.start'}` 忘了 action…）。
    // 少了这一遍，应用阶段会抛**裸 TypeError**（"Cannot read properties of undefined (reading 'name')"），
    // 模型拿到的是一个看不懂的报错而不是可修正的诊断 —— 2026-09-27 夜间隔离实例实测到 agnes 这样做过。
    // 形状不对的操作**不参与后面的引用校验**（否则那些 pass 自己就会踩空）。
    const malformed = new Set<number>()
    proposal.operations.forEach((operation, index) => {
      const problem = describeShapeProblem(operation)
      if (problem === undefined) return
      malformed.add(index)
      diagnostics.push(
        diagnostic({
          code: 'BAD_FIELD',
          opIndex: index,
          op: operation.op,
          field: problem.field,
          reason: 'missing',
          message: problem.message,
        }),
      )
    })

    // ② 乐观并发
    for (const [id, expected] of Object.entries(proposal.expectedVersions ?? {})) {
      const actual = this.snapshotValue.entities[id]?.revision ?? null
      if (expected === null) {
        if (actual !== null) {
          diagnostics.push(
            diagnostic({
              code: 'VERSION_MISMATCH',
              entityId: id,
              field: 'version',
              reason: 'version_mismatch',
              message: `期望「${id}」尚不存在，但它已在世界裡（revision=${actual}）`,
            }),
          )
        }
        continue
      }
      if (actual !== expected) {
        diagnostics.push(
          diagnostic({
            code: 'VERSION_MISMATCH',
            entityId: id,
            field: 'version',
            reason: 'version_mismatch',
            message: `「${id}」的版本不符：提案基于 ${expected}，当前 ${actual ?? '不存在'}`,
          }),
        )
      }
    }

    // ③ 引用完整性（**整批候选世界**：同批 create 的实体也算存在 —— 支持前向引用）
    const candidate = this.candidateEntities(proposal.operations)
    // 同批 `action.start` 的动作也算"已存在"：**立即完成的动作**就是
    // "开始与结算在同一事务"（参照框架的原话："最终变更与动作完成标记在同一事务提交"）——
    // 逐条查快照会把这类提案全拦掉。
    const startedHere = new Set<string>()
    proposal.operations.forEach((operation, index) => {
      // 形状不对的已经在 ①·5 报过 —— 这里不再碰它（碰了就是踩空）
      if (malformed.has(index)) return
      if (operation.op === 'action.start') startedHere.add(operation.action.id)
    })
    proposal.operations.forEach((operation, index) => {
      if (malformed.has(index)) return
      this.validateReferences(operation, index, candidate, startedHere, diagnostics)
    })

    // ④ 容纳关系不成环
    diagnostics.push(...detectCycles(candidate))

    return diagnostics
  }

  /**
   * 候选世界：现有实体 + 本批 `create` 的实体（后写覆盖先写）。
   *
   * 只要 id/kind/location 三个字段 —— 引用校验与环检测只需要这些。
   */
  private candidateEntities(operations: readonly WorldOperation[]): Map<string, Pick<WorldEntity, 'id' | 'kind' | 'location'>> {
    const map = new Map<string, Pick<WorldEntity, 'id' | 'kind' | 'location'>>()
    for (const [id, entity] of Object.entries(this.snapshotValue.entities)) {
      map.set(id, { id, kind: entity.kind, location: entity.location })
    }
    for (const operation of operations) {
      if (operation.op === 'create') {
        // 形状不对的 create（少了 entity）跳过 —— 它已在 ①·5 报过诊断
        const entity = operation.entity as { id?: unknown; kind?: unknown; location?: unknown } | undefined
        if (entity === undefined || entity === null || typeof entity !== 'object') continue
        map.set(String(entity.id), {
          id: String(entity.id),
          kind: entity.kind as WorldEntity['kind'],
          location: (entity.location ?? null) as WorldEntity['location'],
        })
      }
      if (operation.op === 'move') {
        const existing = map.get(operation.id)
        if (existing !== undefined) map.set(operation.id, { ...existing, location: operation.location })
      }
    }
    return map
  }

  private validateReferences(
    operation: WorldOperation,
    opIndex: number,
    candidate: Map<string, Pick<WorldEntity, 'id' | 'kind' | 'location'>>,
    startedHere: ReadonlySet<string>,
    diagnostics: KernelDiagnostic[],
  ): void {
    switch (operation.op) {
      case 'create': {
        const { entity } = operation
        if (candidate.has(entity.id) && this.snapshotValue.entities[entity.id] !== undefined) {
          diagnostics.push(
            diagnostic({
              code: 'DUPLICATE_ENTITY',
              opIndex,
              op: 'create',
              entityId: entity.id,
              field: 'id',
              reason: 'wrong_kind',
              message: `实体已存在：${entity.id}（改建用 update / 移动用 move）`,
            }),
          )
        }
        this.checkLocation(opIndex, entity.id, entity.location, candidate, diagnostics)
        this.checkOwner(opIndex, entity.kind, entity.id, entity.owner, candidate, diagnostics)
        for (const key of Object.keys(entity.attributes ?? {})) assertSafeKey(key)
        break
      }

      case 'update': {
        if (this.snapshotValue.entities[operation.id] === undefined) {
          diagnostics.push(
            diagnostic({
              code: 'UNKNOWN_ENTITY',
              opIndex,
              op: 'update',
              entityId: operation.id,
              field: 'id',
              reason: 'missing',
              message: `要更新的实体不存在：${operation.id}`,
            }),
          )
        }
        break
      }

      case 'move': {
        if (this.snapshotValue.entities[operation.id] === undefined) {
          diagnostics.push(
            diagnostic({
              code: 'UNKNOWN_ENTITY',
              opIndex,
              op: 'move',
              entityId: operation.id,
              field: 'id',
              reason: 'missing',
              message: `要移动的实体不存在：${operation.id}`,
            }),
          )
          break
        }
        const kind = this.snapshotValue.entities[operation.id]?.kind ?? 'object'
        this.checkLocation(opIndex, operation.id, operation.location, candidate, diagnostics)
        this.checkOwner(opIndex, kind, operation.id, operation.owner, candidate, diagnostics)
        break
      }

      case 'action.start': {
        const { action } = operation
        this.checkActor(opIndex, action.actorId, candidate, diagnostics)
        if (this.snapshotValue.actions[action.id] !== undefined) {
          diagnostics.push(
            diagnostic({
              code: 'DUPLICATE_ACTION',
              opIndex,
              op: 'action.start',
              entityId: action.id,
              field: 'id',
              reason: 'wrong_kind',
              message: `动作 id 已存在：${action.id}`,
            }),
          )
        }
        for (const targetId of action.targetIds ?? []) {
          if (!candidate.has(targetId)) {
            diagnostics.push(
              diagnostic({
                code: 'UNKNOWN_ENTITY',
                opIndex,
                op: 'action.start',
                entityId: action.id,
                field: 'id',
                targetId,
                reason: 'missing',
                message: `动作目标不存在：${targetId}`,
              }),
            )
          }
        }
        break
      }

      case 'action.finish': {
        // 同批 start → finish（立即完成的动作）是合法形态，`startedHere` 里算存在
        if (startedHere.has(operation.id)) break
        const action = this.snapshotValue.actions[operation.id]
        if (action === undefined) {
          diagnostics.push(
            diagnostic({
              code: 'UNKNOWN_ACTION',
              opIndex,
              op: 'action.finish',
              entityId: operation.id,
              field: 'id',
              reason: 'missing',
              message: `要结算的动作不存在：${operation.id}`,
            }),
          )
        } else if (action.status !== 'pending') {
          diagnostics.push(
            diagnostic({
              code: 'ACTION_ALREADY_SETTLED',
              opIndex,
              op: 'action.finish',
              entityId: operation.id,
              field: 'id',
              reason: 'version_mismatch',
              message: `动作已结算过（status=${action.status}）—— 重复结算会被拒`,
            }),
          )
        }
        break
      }

      case 'say': {
        this.checkActor(opIndex, operation.actorId, candidate, diagnostics)
        break
      }
    }
  }

  private checkLocation(
    opIndex: number,
    entityId: string,
    location: string | null,
    candidate: Map<string, Pick<WorldEntity, 'id' | 'kind' | 'location'>>,
    diagnostics: KernelDiagnostic[],
  ): void {
    if (location === null) return
    const target = candidate.get(location)
    if (target === undefined) {
      diagnostics.push(
        diagnostic({
          code: 'DANGLING_LOCATION',
          opIndex,
          entityId,
          field: 'location',
          targetId: location,
          reason: 'missing',
          expectedKinds: ['place'],
          message: `位置不存在：${location}（location 必须引用一个已存在的 place，或写 null 表示最外层）`,
        }),
      )
      return
    }
    if (target.kind !== 'place') {
      diagnostics.push(
        diagnostic({
          code: 'WRONG_LOCATION_KIND',
          opIndex,
          entityId,
          field: 'location',
          targetId: location,
          reason: 'wrong_kind',
          expectedKinds: ['place'],
          actualKind: target.kind,
          message: `location 必须指向 place，${location} 是 ${target.kind}`,
        }),
      )
    }
  }

  private checkOwner(
    opIndex: number,
    kind: EntityKind,
    entityId: string,
    owner: string | null | undefined,
    candidate: Map<string, Pick<WorldEntity, 'id' | 'kind' | 'location'>>,
    diagnostics: KernelDiagnostic[],
  ): void {
    if (owner === null || owner === undefined) return
    if (kind !== 'object') {
      diagnostics.push(
        diagnostic({
          code: 'OWNER_NOT_ALLOWED',
          opIndex,
          entityId,
          field: 'owner',
          targetId: owner,
          reason: 'owner_not_allowed',
          actualKind: kind,
          message: `只有 object 可以有 owner，${entityId} 是 ${kind}`,
        }),
      )
      return
    }
    const target = candidate.get(owner)
    if (target === undefined) {
      diagnostics.push(
        diagnostic({
          code: 'DANGLING_OWNER',
          opIndex,
          entityId,
          field: 'owner',
          targetId: owner,
          reason: 'missing',
          expectedKinds: ['actor'],
          message: `主人不存在：${owner}（owner 必须引用一个已存在的 actor）`,
        }),
      )
      return
    }
    if (target.kind !== 'actor') {
      diagnostics.push(
        diagnostic({
          code: 'WRONG_OWNER_KIND',
          opIndex,
          entityId,
          field: 'owner',
          targetId: owner,
          reason: 'wrong_kind',
          expectedKinds: ['actor'],
          actualKind: target.kind,
          message: `owner 必须指向 actor，${owner} 是 ${target.kind}`,
        }),
      )
    }
  }

  private checkActor(
    opIndex: number,
    actorId: string,
    candidate: Map<string, Pick<WorldEntity, 'id' | 'kind' | 'location'>>,
    diagnostics: KernelDiagnostic[],
  ): void {
    const target = candidate.get(actorId)
    if (target === undefined) {
      diagnostics.push(
        diagnostic({
          code: 'UNKNOWN_ENTITY',
          opIndex,
          entityId: actorId,
          field: 'id',
          targetId: actorId,
          reason: 'missing',
          expectedKinds: ['actor'],
          message: `行动者不存在：${actorId}`,
        }),
      )
      return
    }
    if (target.kind !== 'actor') {
      diagnostics.push(
        diagnostic({
          code: 'WRONG_ACTOR_KIND',
          opIndex,
          entityId: actorId,
          field: 'id',
          targetId: actorId,
          reason: 'wrong_kind',
          expectedKinds: ['actor'],
          actualKind: target.kind,
          message: `行动者必须是 actor，${actorId} 是 ${target.kind}`,
        }),
      )
    }
  }

  // ── 重放与提交 ──────────────────────────────────────────────────────────

  /** 读日志 → 逐行应用。目录不存在 = 空世界（还没创世）。 */
  private async replay(): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true })

    let text: string
    try {
      text = await readFile(this.logPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    const lines = text.split('\n')
    const lastNonEmpty = lastNonEmptyIndex(lines)
    let droppedResidual = false

    lines.forEach((line, index) => {
      if (line.trim() === '') return
      try {
        const transaction = JSON.parse(line) as CommittedTransaction
        this.applyTransaction(transaction, transaction.proposal.effectiveAt ?? transaction.committedAt)
      } catch (error) {
        // ⚠️ **只容忍最后一行**：append 被截断是正常的崩溃形态（进程在写中途死掉）。
        // 中间出现坏行说明文件被外力改坏了 —— 抛错，不掩盖。
        if (index === lastNonEmpty) {
          this.options.warn(
            `[world-kernel] 事务日志最后一行不完整，已丢弃（写入中断的痕迹）：${describe(error)}`,
          )
          droppedResidual = true
          return
        }
        throw new KernelError(
          'LOG_CORRUPTED',
          `事务日志第 ${index + 1} 行损坏（不是最后一行）：${describe(error)}\n` +
            '两种可能：① 文件被外力改过（手改/别的进程写过）；' +
            '② 某次提交在"已 append、未 apply"之间抛了错 —— 那条事务在本次重放时应用不了。' +
            '处置：备份该文件后检查这一行；确认是废事务就删掉它，或从归档重建世界。',
        )
      }
    })

    // ⚠️ 丢弃残行必须**物理截断文件**：只在内存里丢、文件尾还是"没有换行的半个 JSON"，
    // 下一次 `appendFile` 会把新事务**直接拼接在残行后面**（追加到末字节）——
    // 两行物理合并。再下次重放：这行成了中间行 → `LOG_CORRUPTED` 世界打不开；
    // 或仍是最后一行 → 那条合法事务被当残行静默丢弃。一次撕裂写经两次崩溃周期后
    // 要么毒化日志、要么吞事务。截断走与 exportStatus 相同的 tmp + rename 纪律。
    if (droppedResidual) {
      const kept = lines.slice(0, lastNonEmpty).join('\n')
      const temporary = `${this.logPath}.${randomUUID()}.tmp`
      await writeFile(temporary, kept === '' ? '' : `${kept}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.logPath)
    }
  }

  /**
   * 预测本次提交会产生哪些说话事件 id。
   *
   * 事件 id 的形状（`state.ts` 的 `say` 分支）：`<事务序号>:<当时的 utterances 长度>`。
   * 同一批里第 n 条 `say` 用"已经被前面几条撑大的长度"，所以这里要**跟着数**；
   * 超过保留上限时长度会被裁回 `KEEP_UTTERANCES`（`applyOperation` 的裁剪语义）——
   * 这条也照数，否则同批多条 `say` 的 id 会算错。
   *
   * 为什么不"提交后数快照尾巴"：裁剪会让"多出来的那几条"根本不在快照里，
   * 数尾巴就漏了它们（而那几句恰恰是要发出去的）。
   */
  private predictUtteranceIds(operations: readonly WorldOperation[], sequence: number): string[] {
    let length = this.snapshotValue.utterances.length
    const ids: string[] = []
    for (const operation of operations) {
      if (operation.op !== 'say') continue
      ids.push(`${sequence}:${length}`)
      length = Math.min(length + 1, KEEP_UTTERANCES)
    }
    return ids
  }

  /** 按 id 从快照里取回说话事件（保持 `utteranceIds` 的顺序）。 */
  private collectUtterances(ids: readonly string[]): Utterance[] {
    if (ids.length === 0) return []
    const wanted = new Set(ids)
    return this.snapshotValue.utterances.filter((utterance) => wanted.has(utterance.id))
  }

  /** 把一条已提交事务应用到内存快照（重放与提交共用同一条路径）。 */
  private applyTransaction(transaction: CommittedTransaction, effectiveAt: number): void {
    let next = this.snapshotValue
    for (const operation of transaction.proposal.operations) {
      next = applyOperation(next, operation, effectiveAt)
    }
    next.sequence = transaction.sequence
    this.snapshotValue = next
    this.committedKeys.set(transaction.proposal.idempotencyKey, transaction.sequence)
  }
}

/** 最后一个非空行的下标（没有则 -1）。 */
function lastNonEmptyIndex(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? '').trim() !== '') return index
  }
  return -1
}

/** 一条提案里所有会被改动的实体 id（去重、保序）。 */
function collectChanged(operations: readonly WorldOperation[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  for (const operation of operations) {
    switch (operation.op) {
      case 'create':
        push(operation.entity.id)
        break
      case 'update':
      case 'move':
        push(operation.id)
        break
      case 'action.start':
        for (const id of operation.action.targetIds ?? []) push(id)
        break
      default:
        break
    }
  }
  return ids
}

/**
 * 容纳关系成环检测（DFS 三色）。
 *
 * 只在 `place` 之间成立：`location` 指向另一个 place 表示嵌套（房里的房间、街边的店）。
 * 成环会让"她在哪儿"的查询永不终止，所以拒。返回**闭合路径**便于模型修正。
 */
function detectCycles(candidate: Map<string, Pick<WorldEntity, 'id' | 'kind' | 'location'>>): KernelDiagnostic[] {
  const diagnostics: KernelDiagnostic[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const walk = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      const from = path.indexOf(id)
      diagnostics.push(
        diagnostic({
          code: 'CONTAINMENT_CYCLE',
          entityId: id,
          field: 'location',
          reason: 'cycle',
          path: [...path.slice(from), id],
          message: `容纳关系成环：${[...path.slice(from), id].join(' → ')}`,
        }),
      )
      return
    }
    state.set(id, 'visiting')
    const entity = candidate.get(id)
    const parentId = entity?.location ?? null
    if (parentId !== null && candidate.has(parentId)) walk(parentId, [...path, id])
    state.set(id, 'done')
  }

  for (const [id, entity] of candidate) {
    if (entity.kind === 'place') walk(id, [])
  }
  return diagnostics
}

/** 只读呈现：把快照渲染成给人看的 Markdown。 */
function renderStatus(snapshot: WorldSnapshot): string {
  const lines: string[] = ['# 世界现状（只读呈现）', '']

  lines.push(`- 世界时间：${snapshot.effectiveAt}`)
  lines.push(`- 已提交事务：${snapshot.sequence}`)
  lines.push(`- 实体：${Object.keys(snapshot.entities).length} 个｜动作：${Object.keys(snapshot.actions).length} 个`)
  lines.push('')

  const renderChildren = (parent: string | null, depth: number): void => {
    for (const entity of Object.values(snapshot.entities)) {
      if (entity.location !== parent) continue
      const indent = '  '.repeat(depth)
      const owner = entity.owner === undefined || entity.owner === null ? '' : `（属于 ${entity.owner}）`
      lines.push(`${indent}- ${entity.name} \`${entity.id}\`｜${entity.kind}${owner}｜rev ${entity.revision}`)
      renderChildren(entity.id, depth + 1)
    }
  }
  renderChildren(null, 0)

  const pending = Object.values(snapshot.actions).filter((action) => action.status === 'pending')
  if (pending.length > 0) {
    lines.push('', '## 进行中的动作', '')
    for (const action of pending) {
      lines.push(`- \`${action.id}\`：${action.intent}（期望 ${action.expectedEnd ?? '—'} 完成）`)
    }
  }

  if (snapshot.utterances.length > 0) {
    lines.push('', '## 最近说话', '')
    for (const utterance of snapshot.utterances.slice(-10)) {
      lines.push(`- [${utterance.at}] ${utterance.speakerId}：${utterance.text}`)
    }
  }

  lines.push('', '<!-- 本文件由内核导出，只读。想改世界请走提案 + 校验（spec §6.7）。 -->', '')
  return lines.join('\n')
}
