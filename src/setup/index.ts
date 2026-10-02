/**
 * 初始化向导服务（`ctx.setup`）—— spec §6.11 的状态机。
 *
 * ## 它管什么
 *
 * 四步（`persona → background → world → accounts → ready`），每步都**真的做出东西**：
 *
 * | 步骤 | 动作 | 判据（现场） |
 * |---|---|---|
 * | `persona` | 装人格基底 + 装三个 preset | `yanxin/persona/base.md` 有内容 **且** preset 装齐 |
 * | `background` | 装背景资料 + 重装 preset | `profile.md` 有内容 **且** preset 装齐 |
 * | `world` | 装世界定义 + **创世** + 重装 preset | `world/clock.json` 在 **且** 事务数 > 0 |
 * | `accounts` | 选定她的 QQ 号 | 选定值在 onebot 的账号注册表里 |
 *
 * 判定规则是 `logic.ts` 那一条：**状态 = 记录 ∩ 证据**。所以本文件只做三件事：
 * 读现场、调动作、落盘 —— 判定一律交给纯函数（那边有表驱动测试）。
 *
 * ## 三条纪律
 *
 *   · **不假装成功**：动作跑完后**重新读一次现场**，那一步仍不成立就抛错
 *     （"我写了文件"不等于"证据成立" —— 比如 preset 装到了别的目录）
 *   · **跳步不行**：前序不成立时 `run()` 直接抛 `STEP_BLOCKED`，并附"先补什么"
 *   · **中途关闭可续**：进度落 `setup.json`，重开服务后从记录继续
 *
 * ## 它不做什么
 *
 * 不写 settings、不动 profile patch（账号注册表在那儿，属于部署配置 —— 向导只**检查**它，
 * 不替运营者写密钥）。也不启动 agent：那是 T30 的守卫与 T27b 的接线。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
// 类型层面：让 `ctx.get('onebot')` 认得服务键（运行时不产生依赖 —— ADR 0010 的同一个坑）
import type {} from '../onebot/service.ts'
import {
  emptyRecord,
  isRunnable,
  markCompleted,
  parseRecord,
  reconcile,
  resetTo,
  withAccountId,
  type ReconcileResult,
  type SetupEvidence,
  type SetupRecord,
} from './logic.ts'
import {
  defaultPackageRoot,
  dshHome,
  installPersonaSource,
  installPresets,
  readEvidence,
  setupFile,
  worldDir,
  writeAtomic,
  type InstallOutcome,
  type InstallPaths,
} from './install.ts'
import { SETUP_STEPS, SetupError, type SetupProgress, type SetupStatus, type SetupStep } from './types.ts'
import { runWorldStep } from './world-step.ts'
import type { CallWorldModel } from '../world/arbiter.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    setup: SetupService
  }
  interface Events {
    /** 向导进度变化（启动、完成一步、回退）。订阅者：控制台、审计、T30 的守卫。 */
    'yanxin/setup-updated'(status: SetupStatus): void
  }
}

/** onebot 服务的**最小面**（只用到这两个成员 —— 不把整个 OneBotService 拖进依赖）。 */
interface OneBotLike {
  readonly accounts: readonly { selfId: string }[]
  connectionsOf(selfId: string): readonly string[]
}

const ConfigSchema = z.object({
  home: z.string().description('$DSH_HOME。缺省取环境变量，再缺省 ~/.dsh（测试请指向临时目录）。'),
  packageRoot: z.string().description('包根（persona/ 与 presets/ 所在）。缺省按本文件位置推导。'),
  selfId: z.string().description('她自己在世界里的实体 id（创世用）。缺省 yanxin。'),
})

/** 行 config（回退见 `dshHome()` / `defaultPackageRoot()` / `SELF_ID_DEFAULT`）。 */
interface SetupConfig {
  home?: string
  packageRoot?: string
  selfId?: string
}

/** 她自己的实体 id 缺省值（与 `persona/world.md` 的设定一致）。 */
export const SELF_ID_DEFAULT = 'yanxin'

/** 一步的动作跑完后的产物（文件 + 记录层面的产物）。 */
export interface ActionOutcome extends InstallOutcome {
  /** `accounts` 选的 QQ 号 —— 由服务写进记录（动作自己不碰记录）。 */
  accountId?: string
  /** 创世时实际用的她的实体 id（T29）。 */
  selfId?: string
}

/** 一步的动作（T29 会把 `world` 换成真的创世）。 */
export interface SetupActions {
  persona: (context: ActionContext) => Promise<ActionOutcome>
  background: (context: ActionContext) => Promise<ActionOutcome>
  world: (context: ActionContext) => Promise<ActionOutcome>
  accounts: (context: ActionContext) => Promise<ActionOutcome>
}

export interface ActionContext extends InstallPaths {
  /** 她在世界里的实体 id（创世用）。 */
  selfId: string
  /** 世界目录。 */
  worldDir: string
  /** 本步的输入（如 `accounts` 的 `accountId`、`world` 的 `rebuild`）。 */
  input: StepInput
}

export interface StepInput {
  /** `accounts`：她的 QQ 号（selfId）。 */
  accountId?: string
  /** `world`：世界已存在时是否推倒重建（默认 false —— 拒重建）。 */
  rebuild?: boolean
}

export default class SetupService extends Service {
  /**
   * 不需要 inject 任何服务。
   *
   * onebot 用 `ctx.get` **软查**（账号注册表只是 `accounts` 步的证据来源）：把它写进
   * `inject` 会让整个向导 pending 在 OneBot 上 —— 而"OneBot 还没配好"恰恰是向导要
   * 如实报告的状态。记忆模块踩过同一个坑（ADR 0010）。
   */
  static readonly inject: readonly string[] = []

  static readonly Config: z<SetupConfig> = ConfigSchema

  private readonly paths: InstallPaths
  private readonly selfIdValue: string
  private readonly actions: SetupActions
  /** 落盘记录（装载时读一次；之后由本服务维护）。 */
  private record: SetupRecord = emptyRecord(0)
  /** 首次装载的读盘（所有公开方法都先 await 它）。 */
  private readonly loading: Promise<void>
  /** `run()` 的串行队列 —— 见 `run()` 的说明。 */
  private runQueue: Promise<unknown> = Promise.resolve()

  /**
   * 世界模型调用 —— `world` 步的**接缝**（T27b 会把 `ctx.llm` 适配进来）。
   *
   * 做成公开可写的字段而不是构造参数：真实接线要等"模型路由 + agent 会话"就位（装配层
   * 的事），而 `world` 步的机制（创世 + 时钟 + 归档重建 + 失败不留半成品）现在就能测完。
   * 没接线时这一步**明确报 `NOT_WIRED`**，绝不装个空世界冒充成功。
   */
  worldModel?: CallWorldModel

  constructor(ctx: Context, config: SetupConfig = {}) {
    super(ctx, 'setup')

    this.paths = {
      home: config.home ?? dshHome(),
      packageRoot: config.packageRoot ?? defaultPackageRoot(),
    }
    this.selfIdValue = config.selfId ?? SELF_ID_DEFAULT
    this.actions = {
      ...fileActions(),
      // `world` 步在实例上跑（要读 `this.worldModel`）
      world: (context) => this.runWorld(context),
    }

    this.loading = this.load()
    this.ctx.logger.info(`[yanxin-setup] 向导装载：数据目录 ${this.paths.home}/yanxin`)
  }

  /** 她自己在世界里的实体 id（缺省 `yanxin`）。 */
  get selfId(): string {
    return this.selfIdValue
  }

  /** 她的 QQ 号（`accounts` 步选定；没选就是 `undefined`）。 */
  get accountId(): string | undefined {
    return this.record.accountId
  }

  /** 完整进度（含每步的现场判定）。 */
  async progress(): Promise<SetupProgress> {
    await this.loading
    return this.toProgress(await this.reconcileNow())
  }

  /** 一句话状态（`ready` / 某一步 / `init`）。 */
  async status(): Promise<SetupStatus> {
    return (await this.progress()).status
  }

  /**
   * 跑一步。
   *
   * @throws {@link SetupError} `STEP_BLOCKED`（前序没做完 / 该步现在还轮不到）、
   *   `BAD_INPUT`（缺 `accountId` 之类）、`STEP_FAILED`（动作跑完但现场仍不成立）、
   *   `NOT_WIRED`（该步的动作还没接线）
   */
  async run(step: SetupStep, input: StepInput = {}): Promise<{ status: SetupStatus; detail: string; written: string[] }> {
    // 串行化：浏览器端没禁用提交按钮（双击/双开标签会并发）。两路同时进 run
    // 都拿同一份 `before` 快照过 isRunnable，world 步会把第一个刚建的世界再归档一遍。
    // 与 bridge 的会话队列同款纪律：一次只跑一步。
    const execute = () => this.runNow(step, input)
    const result = this.runQueue.then(execute, execute)
    this.runQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async runNow(step: SetupStep, input: StepInput): Promise<{ status: SetupStatus; detail: string; written: string[] }> {
    await this.loading

    // 入口先验名字：`actions[step]` 查不到时给操作者一条能看懂的错
    // （而不是 "this.actions[step] is not a function" 这种内部错误）
    if (!(SETUP_STEPS as readonly string[]).includes(step)) {
      throw new SetupError('BAD_INPUT', `没有这一步：「${String(step)}」`, [`可用的步骤：${SETUP_STEPS.join(' → ')}`])
    }

    const before = await this.reconcileNow()
    if (!isRunnable(step, before)) {
      throw new SetupError(
        'STEP_BLOCKED',
        `还不能做「${step}」——先把它前面的步骤补上`,
        before.steps.filter((state) => !state.satisfied).flatMap((state) => state.missing),
      )
    }

    const outcome = await this.actions[step]({
      ...this.paths,
      selfId: this.selfIdValue,
      worldDir: worldDir(this.paths.home),
      input,
    })

    // 动作可能带来"记录层面"的产物（accounts 选定她是谁）——
    // 先落进记录，因为**后面那一步的现场判定要读它**
    if (outcome.accountId !== undefined) {
      this.record = withAccountId(this.record, outcome.accountId, this.now())
    }

    // ⚠️ **跑完重新读现场**：动作说"写好了"不等于证据成立（装错目录、写空了都可能）。
    // 这一步是"不假装成功"的执行点。
    const after = await this.reconcileNow()
    const state = after.steps.find((candidate) => candidate.step === step)
    if (state === undefined || !state.satisfied) {
      throw new SetupError('STEP_FAILED', `「${step}」跑完了，但现场仍不成立`, state?.missing ?? [])
    }

    this.record = markCompleted(this.record, step, this.now())
    await this.save()

    // 状态要在**记录更新之后**再算一次：否则发出去的会是"上一步"的状态
    const final = await this.reconcileNow()
    this.emitStatus(final.status)
    return { status: final.status, detail: outcome.detail, written: outcome.written }
  }

  /**
   * 回退到某一步重跑（`ready` 之后也能用 —— 换人格、重建世界）。
   *
   * 只清进度，**不删文件**：重跑是"再做一遍并覆盖"，而不是"先把现场拆了"。
   * 于是回退后、重跑前的那段窗口里状态会如实显示"这几步不成立了"。
   */
  async reset(step: SetupStep): Promise<SetupProgress> {
    await this.loading
    this.record = resetTo(this.record, step, this.now())
    await this.save()
    const after = await this.reconcileNow()
    this.emitStatus(after.status)
    return this.toProgress(after)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

/**
  * `world` 步（T29）：写时钟（T=0）+ 从世界定义创世。
  *
  * 机制在 `world-step.ts`（可单测），这里只负责"模型从哪来"：
  *   · 显式设过 `worldModel`（测试注入 / 装配覆盖）→ 用它
  *   · 否则问 `ctx.worldModel`（T27b 的适配器：真实的 `ctx.llm`，走 agent-default-model 路由）
  *   · 两样都没有 → 明确报 `NOT_WIRED`
  */
  private async runWorld(context: ActionContext): Promise<ActionOutcome> {
    const fromService = (this.ctx.get('worldModel') as { call?: CallWorldModel } | undefined)?.call
    const callModel = this.worldModel ?? fromService

    if (callModel === undefined) {
      throw new SetupError(
        'NOT_WIRED',
        '世界模型还没接线 —— 创世要它把 persona/world.md 提取成结构化实体',
        [
          '装配层把 `world-model` 行放进 patch（yanxin/src/world/model.ts，inject llm）即可',
          `世界目录：${context.worldDir}`,
        ],
      )
    }

    return runWorldStep({
      ...context,
      worldDir: context.worldDir,
      selfId: context.selfId,
      callModel,
      ...(context.input.rebuild === undefined ? {} : { rebuild: context.input.rebuild }),
      warn: (message) => this.ctx.logger.warn(message),
    })
  }

  private async load(): Promise<void> {
    const file = setupFile(this.paths.home)

    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      this.record = emptyRecord(this.now()) // 首次运行：从零开始
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      // 文件在、但读不出来 —— **不静默当"全新"**：那是运营者手改坏了，得让他知道
      this.ctx.logger.warn(`[yanxin-setup] ${file} 不是合法 JSON，已按"未初始化"处理`)
      this.record = emptyRecord(this.now())
      return
    }

    const parsed = parseRecord(raw, this.now())
    if (parsed === undefined) {
      this.ctx.logger.warn(`[yanxin-setup] ${file} 形状不对（版本或字段），已按"未初始化"处理`)
      this.record = emptyRecord(this.now())
      return
    }
    this.record = parsed
  }

  /** 读现场 + 判定（每次都重新读：文件可能被运营者手工改过）。 */
  private async reconcileNow(): Promise<ReconcileResult> {
    const evidence: SetupEvidence = await readEvidence(this.paths, this.readAccounts())
    return reconcile(this.record, evidence)
  }

  /** 从 onebot 服务读账号注册表（缺席时如实报"一个都没有"）。 */
  private readAccounts(): { registered: string[]; connected: string[] } {
    const onebot = this.ctx.get('onebot') as OneBotLike | undefined
    if (onebot === undefined) return { registered: [], connected: [] }
    const registered = onebot.accounts.map((account) => account.selfId)
    const connected = registered.filter((selfId) => onebot.connectionsOf(selfId).length > 0)
    return { registered, connected }
  }

  private toProgress(result: ReconcileResult): SetupProgress {
    const completed = new Set(this.record.completed)
    return {
      status: result.status,
      next: result.next,
      steps: result.steps.map((state) => ({
        step: state.step,
        completed: completed.has(state.step),
        satisfied: state.satisfied,
        runnable: isRunnable(state.step, result),
        missing: state.missing,
      })),
      reverted: result.reverted,
      warnings: result.warnings,
    }
  }

  private async save(): Promise<void> {
    await writeAtomic(setupFile(this.paths.home), `${JSON.stringify(this.record, null, 2)}\n`)
  }

  private emitStatus(status: SetupStatus): void {
    this.ctx.logger.info(`[yanxin-setup] 向导状态：${status}`)
    this.ctx.emit('yanxin/setup-updated', status)
  }

  private now(): number {
    return Date.now()
  }
}

/**
 * 纯文件动作（`persona` / `background` / `accounts`）。
 *
 * `world` **不在这里**：它要读实例上的 `worldModel`（T27b 的接缝），由
 * {@link SetupService.runWorld} 执行 —— 一个动作只有一处实现，不留"路过"的副本。
 */
function fileActions(): Omit<SetupActions, 'world'> {
  return {
    async persona(context) {
      const source = await installPersonaSource(context, 'persona')
      const presets = await installPresets(context)
      return { detail: `${source.detail}；${presets.detail}`, written: [...source.written, ...presets.written] }
    },

    async background(context) {
      const source = await installPersonaSource(context, 'background')
      const presets = await installPresets(context)
      return { detail: `${source.detail}；${presets.detail}`, written: [...source.written, ...presets.written] }
    },

    async accounts(context) {
      const accountId = context.input.accountId?.trim()
      if (accountId === undefined || accountId === '') {
        throw new SetupError('BAD_INPUT', 'accounts 步要指定她的 QQ 号', [
          '调用时传 accountId，例如 { accountId: "她的QQ号" }',
        ])
      }
      return { detail: `她的 QQ 号：${accountId}`, written: [], accountId }
    },
  }
}