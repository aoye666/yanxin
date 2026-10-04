/**
 * 初始化向导的**纯逻辑**（T28a，spec §6.11）。
 *
 * ## 这个文件存在的理由
 *
 * 向导的每一步都必须回答同一个问题："**这一步真的做完了吗**"。
 * 而这个问题有两个来源，它们可能不一致：
 *
 *   · **落盘的记录**（`$DSH_HOME/yanxin/setup.json`）—— "我以为我做过了"
 *   · **现场的证据**（文件在不在、世界有没有被创世、账号连上没有）—— "真的做了吗"
 *
 * 只要信前者，就会出现最坏的那种状态：**界面显示"就绪"，而 agent 顶着空人格跑起来
 * 污染记忆**（T30 要拦的正是这件事）。所以判定规则是：
 *
 *   **状态 = 记录 ∩ 证据**（按顺序取最长前缀）
 *
 * 于是这里全是不碰文件系统的纯函数：证据由服务读好喂进来，单测可以直接构造各种
 * "记录与现场不符"的形态 —— 那是这个模块唯一值得测的东西。
 *
 * ## 验收的三条（spec §6.11 + todo T28）
 *
 *   · 中途关闭可续 —— 记录里做过、证据也还成立 → 状态停在原地，不用重做
 *   · `ready` 后可回退任意步骤重跑 —— {@link resetTo} 清掉该步及其后
 *   · **记录与现场不符时退回** —— {@link reconcile}（不许"显示 ready 但其实没人格"）
 */
import type { SetupStatus, SetupStep, StepState } from './types.ts'
import { SETUP_STEPS, stepIndex } from './types.ts'

/** 现场证据 —— 从磁盘与服务读来的**事实**（不是"我以为"）。 */
export interface SetupEvidence {
  /**
   * `$DSH_HOME/yanxin/persona/` 里的源文件 —— **写过真内容**才算有。
   *
   * ⚠️ 空模板不算（公开包出厂就是空模板，一句都不是她）：判据在
   * `install.ts` 的 `hasAuthoredPersona`。按"文件非空"判会让新用户在空模板上一路创世。
   */
  persona: { base: boolean; profile: boolean; world: boolean }
  /** preset 安装情况（三个都装好才算装好）。 */
  presets: { installed: number; total: number }
  /** 世界的现场：事务数（> 0 = 创世过）、`clock.json` 在不在。 */
  world: { transactions: number; clock: boolean }
  /** 账号：注册了哪些 selfId、其中哪些真的连上了。 */
  accounts: { registered: readonly string[]; connected: readonly string[] }
}

/** 落盘记录 —— "我以为我做过了"。 */
export interface SetupRecord {
  schemaVersion: 1
  /** 已完成的步骤（按 {@link SETUP_STEPS} 的顺序规范化存储）。 */
  completed: SetupStep[]
  /** 她的 QQ 号（accounts 步选定；必须在账号注册表里）。 */
  accountId?: string
  /** 上次改动时刻（现实 ms）。 */
  updatedAt: number
}

export function emptyRecord(at: number): SetupRecord {
  return { schemaVersion: 1, completed: [], updatedAt: at }
}

// ── 证据 → 每一步成不成立 ──────────────────────────────────────────────────

/**
 * 判定单步是否成立（"现场现在真的满足这一步"）。
 *
 * `missing` 是**给人看、且可操作**的一句话：控制台与 CLI 直接把这几行原样显示给
 * 运营者（"去 `$DSH_HOME/settings.yaml` 的 `yanxin-onebot.accounts` 注册"），
 * 而不是只说"未就绪"。
 */
export function evaluateStep(step: SetupStep, evidence: SetupEvidence, record: SetupRecord): StepState {
  const wanted = evidence.presets.total
  const missing: string[] = []

  switch (step) {
    case 'persona': {
      if (!evidence.persona.base) missing.push('人格基底还没写（yanxin/persona/base.md 不在，或还是出厂空模板）—— 去控制台的 /yanxin/persona 页写她')
      // ⚠️ `total = 0` 是**打包损坏**（presets/ 目录缺失），不是"装齐了"——
      //    0/0 的除法直觉会让这一步恒真，守卫的降级路径随之放行，报错指向错误方向
      if (wanted === 0 || evidence.presets.installed < wanted) {
        missing.push(`agent preset 还没装齐（${evidence.presets.installed}/${wanted}）`)
      }
      return { step, satisfied: missing.length === 0, missing }
    }
    case 'background': {
      if (!evidence.persona.profile) missing.push('背景资料还没写（yanxin/persona/profile.md 不在，或还是出厂空模板）—— 去控制台的 /yanxin/persona 页写她')
      if (wanted === 0 || evidence.presets.installed < wanted) {
        missing.push(`agent preset 还没装齐（${evidence.presets.installed}/${wanted}）`)
      }
      return { step, satisfied: missing.length === 0, missing }
    }
    case 'world': {
      if (!evidence.world.clock) missing.push('世界时钟还没建立（缺 world/clock.json，T=0 纪元没写）')
      if (evidence.world.transactions <= 0) missing.push('世界还没创世（事务日志里一条事务都没有）')
      return { step, satisfied: missing.length === 0, missing }
    }
    case 'accounts': {
      if (record.accountId === undefined) {
        missing.push('还没指定她的 QQ 号（accounts 步要选定一个 selfId）')
      } else if (!evidence.accounts.registered.includes(record.accountId)) {
        missing.push(`选定的 QQ（${record.accountId}）不在账号注册表里（见 onebot 行的 accounts 配置）`)
      }
      // ⚠️ "还没连上"**不算未完成**：协议端可能只是没启动，而这不是"没初始化"。
      // 它是一条**告警**（见 missing 之外的 warnings），不该拦住 ready。
      return { step, satisfied: missing.length === 0, missing }
    }
  }
  /* c8 ignore next */ throw new Error(`未知步骤：${String(step)}`)
}

/** 值得提醒但不拦 ready 的事（如"协议端还没连上"）。 */
export function warnings(evidence: SetupEvidence, record: SetupRecord): string[] {
  const lines: string[] = []
  if (record.accountId !== undefined && !evidence.accounts.connected.includes(record.accountId)) {
    lines.push('她还没上线：协议端（NapCat/SnowLuma）还没有反连过来')
  }
  if (evidence.accounts.registered.length === 0) {
    lines.push('一个 QQ 账号都没注册（onebot 行的 accounts 配置为空），她收不到任何消息')
  }
  return lines
}

// ── 状态推导 ───────────────────────────────────────────────────────────────

export interface ReconcileResult {
  /** 记录 ∩ 证据（按顺序取最长前缀）——唯一对外可信的状态。 */
  status: SetupStatus
  /** 每一步的成立情况（控制台渲染用）。 */
  steps: StepState[]
  /** 记录里已完成的步骤（原样带出来，便于调用方判断"能不能重跑"）。 */
  completed: SetupStep[]
  /** 记录里说做过、现在却不成立的步骤（"需要重做"）。 */
  reverted: SetupStep[]
  /** 下一步该做的（`ready` 时是 `null`）。 */
  next: SetupStep | null
  /** 提醒（不拦 ready）。 */
  warnings: string[]
}

/**
 * 记录 + 现状 → 校正后的状态。
 *
 * 前缀语义：状态只认"从头到这里都**既做过、又成立**"的最长前缀。所以
 * 中间任何一步证据消失（人格文件被删）都会让状态**退回**到它之前 —— 这正是
 * "不许显示 ready 但其实没人格"的执行点。
 */
export function reconcile(record: SetupRecord, evidence: SetupEvidence): ReconcileResult {
  const steps = SETUP_STEPS.map((step) => evaluateStep(step, evidence, record))
  const completed = new Set(record.completed)

  let prefix = 0
  for (const state of steps) {
    if (!completed.has(state.step) || !state.satisfied) break
    prefix += 1
  }

  const status: SetupStatus = prefix === 0 ? 'init' : prefix === SETUP_STEPS.length ? 'ready' : SETUP_STEPS[prefix - 1]!
  return {
    status,
    steps,
    completed: [...record.completed],
    // "做过但现在不成立"（证据消失）—— 注意与"被前序挡住"不同：后者本身仍然成立
    reverted: steps.filter((state) => completed.has(state.step) && !state.satisfied).map((state) => state.step),
    next: prefix === SETUP_STEPS.length ? null : SETUP_STEPS[prefix]!,
    warnings: warnings(evidence, record),
  }
}

/** 下一步该做哪一步（`ready` 时 `null`）。 */
export function nextStep(status: SetupStatus): SetupStep | null {
  if (status === 'ready') return null
  const index = status === 'init' ? -1 : stepIndex(status)
  return SETUP_STEPS[index + 1] ?? null
}

/**
 * 这一步现在能不能跑。
 *
 * **判据只有现场（`satisfied`），不看记录**。理由是实测暴露出来的：人格源是**手工**装进去的
 * 时候（或记录文件丢了的时候），"记录里没做过"会拦住后面的步骤，而后面的步骤其实完全跑得了 ——
 * 那时 `STEP_BLOCKED` 还会把"缺什么"报成全世界缺的东西（时钟、创世、QQ 号），
 * 而真正的拦路虎只是账本上少了一笔。
 *
 * 于是分工清楚：**记录是账本（用于显示进度与"需要重做"），现场是判据（决定能不能跑）**。
 * 该拦的仍然拦得住：世界没创世就去绑账号，`world.satisfied` 是 false → 拦。
 */
export function isRunnable(step: SetupStep, result: ReconcileResult): boolean {
  const index = stepIndex(step)
  for (let earlier = 0; earlier < index; earlier += 1) {
    const state = result.steps[earlier]
    if (state === undefined || !state.satisfied) return false
  }
  return true
}

// ── 记录的改写 ─────────────────────────────────────────────────────────────

/** 标记一步完成（按顺序规范化存储；重复标记不产生第二份记录）。 */
export function markCompleted(record: SetupRecord, step: SetupStep, at: number): SetupRecord {
  const completed = [...new Set([...record.completed, step])].sort((a, b) => stepIndex(a) - stepIndex(b))
  return { ...record, completed, updatedAt: at }
}

/**
 * 回退到某一步重跑：清掉**该步及其后**的完成记录。
 *
 * ⚠️ 它**只改记录**，不删文件：重跑的语义是"再做一遍并覆盖"，而不是"先把现场拆了"。
 * 于是回退之后、重跑之前的这段窗口里，状态会如实显示"这两步不成立了"——
 * 这正是我们想要的（她此刻的处境是真的没准备好，而不是"看起来还好"）。
 */
export function resetTo(record: SetupRecord, step: SetupStep, at: number): SetupRecord {
  const index = stepIndex(step)
  const next: SetupRecord = {
    ...record,
    completed: record.completed.filter((done) => stepIndex(done) < index),
    updatedAt: at,
  }
  // accounts 的输入（她是谁）随该步一起作废
  if (index <= stepIndex('accounts')) delete next.accountId
  return next
}

/** 记下她的 QQ 号。 */
export function withAccountId(record: SetupRecord, accountId: string, at: number): SetupRecord {
  return { ...record, accountId, updatedAt: at }
}

/** 从落盘的 JSON 还原（坏值一律当"全新"—— 但**不掩盖**：服务会 warn）。 */
export function parseRecord(raw: unknown, at: number): SetupRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const candidate = raw as Partial<SetupRecord>
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.completed)) return undefined

  const completed = candidate.completed.filter(
    (step): step is SetupStep => typeof step === 'string' && (SETUP_STEPS as readonly string[]).includes(step),
  )
  return {
    schemaVersion: 1,
    completed: [...new Set(completed)].sort((a, b) => stepIndex(a) - stepIndex(b)),
    ...(typeof candidate.accountId === 'string' ? { accountId: candidate.accountId } : {}),
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : at,
  }
}