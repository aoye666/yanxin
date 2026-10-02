/**
 * 发射闸门 —— output commit + 回执纪律（T23，spec §6.8）。
 *
 * ## 为什么世界说话必须过它
 *
 * DSH 的 `ctx.effect` 与 Cordis 论文 §6.1 同源：**不负责回滚"发射型"副作用**。
 * 能被系统独占修改并复原的位置在边界内（可追踪、可回滚）；否则在边界外 ——
 * 操作等同 `id`，**既不追踪也不回滚**。
 *
 * 发 QQ 消息正是 emission（跨出进程边界、第三方可见）。所以顺序必须是：
 *
 * ```
 * World-LLM 提案 say ──▶ 内核校验 + 原子提交（落盘）──▶ 闸门发出（不可回滚）
 *                                        ↑
 *                            到这里之前失败：什么都没发生，丢弃即可
 * ```
 *
 * **先把"这件事发生了"钉在日志里，再让它离开进程** —— 这就是 output commit。
 *
 * ## 它不存"待发内容"
 *
 * 待发内容**已经在内核的事务日志里**（`say` 操作的权威记录）——本文件只记**回执**
 * （哪些 id 发成功过、哪些失败过）。这也是 spec §6.8 说的"outbox 条目 + 事务日志的
 * `say` 记录够用"，不建独立收件箱（参照框架的 `bot-receipts/` 是为多进程设计的）。
 *
 * ## 三条回执纪律
 *
 *   · **恰好一次**：按 utterance id 幂等 —— 已发过的跳过（跨重启也成立，回执落盘）
 *   · **失败不当作成功**：失败记 `failed` 回执 + 告警，**不重试**。
 *     重试可能让群里看到两遍 —— 那比漏发更糟（对外可见的重复无法收回）。
 *     她下一次感知会从回执里知道"那句话没说出去"。
 *   · **延迟回执只导入一次**：发出后进程崩溃、回执才回来 —— 按 id 去重（回执表就是去重依据）
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeError as describe } from '../describe.ts'
import type { Utterance } from './state.ts'

/** 回执文件名（在世界目录里）。 */
export const OUTBOX_FILE = 'outbox.json'

/** 回执表保留条数（够她回顾最近说过什么；历史在事务日志里）。 */
export const KEEP_RECEIPTS = 500

export interface OutboxItem {
  /** utterance id（`<sequence>:<index>`）——**幂等键**。 */
  id: string
  speakerId: string
  text: string
  audience?: string[]
  at: number
}

export interface OutboxReceipt {
  id: string
  status: 'delivered' | 'failed'
  /** 结果落定的现实时刻（ms）。 */
  at: number
  /** 失败原因（只有 `failed` 有）。 */
  reason?: string
}

export interface OutboxOptions {
  /**
   * 真正的发射通道。生产里注入 `(item) => ctx.onebot.call(selfId, action, params)`；
   * 测试注入收集器 —— 本文件**不依赖 onebot**，闸门的纪律与通道无关。
   */
  deliver: (item: OutboxItem) => Promise<void>
  /** 告警去处（默认 `console.warn`）。 */
  warn?: (message: string) => void
  /** 现实时钟（测试注入）。 */
  now?: () => number
}

/**
 * 发射闸门。
 *
 * 用 `WorldOutbox.open(dir, options)`；`deliver()` 只在**内核提交之后**调用
 * （接线见 T27 的闭环）。
 */
export class WorldOutbox {
  /** 回执表（按 id 去重）。 */
  private receiptsValue: OutboxReceipt[] = []
  /**
   * 已"落定"的 id（**成功或失败**）—— 幂等判定的依据。
   *
   * ⚠️ 判据是"**有没有回执**"，不是"成没成功"：失败也要落定，否则每次 `deliver`
   * 都会重投一次 —— 那正是"不重试"承诺的反面（T23 实测踩到）。
   * 语义：**一次发言只投递一次**；成功了就是发出去了，失败了就是放弃了。
   */
  private readonly settledIds = new Set<string>()
  /** 成功发出的 id（计数与观测用）。 */
  private readonly deliveredIds = new Set<string>()
  private saveQueue: Promise<void> = Promise.resolve()
  private readonly file: string
  private readonly options: Required<Pick<OutboxOptions, 'warn' | 'now'>> & Pick<OutboxOptions, 'deliver'>

  private constructor(
    dir: string,
    options: OutboxOptions,
  ) {
    this.file = join(dir, OUTBOX_FILE)
    this.options = {
      deliver: options.deliver,
      warn: options.warn ?? ((message) => console.warn(message)),
      now: options.now ?? (() => Date.now()),
    }
  }

  /** 打开闸门：读回执表（跨重启的幂等依据）。 */
  static async open(dir: string, options: OutboxOptions): Promise<WorldOutbox> {
    await mkdir(dirname(join(dir, OUTBOX_FILE)), { recursive: true })
    const outbox = new WorldOutbox(dir, options)
    try {
      const raw = JSON.parse(await readFile(outbox.file, 'utf8')) as { receipts?: OutboxReceipt[] }
      outbox.receiptsValue = Array.isArray(raw.receipts) ? raw.receipts : []
    } catch {
      outbox.receiptsValue = [] // 首次运行
    }
    for (const receipt of outbox.receiptsValue) {
      outbox.settledIds.add(receipt.id)
      if (receipt.status === 'delivered') outbox.deliveredIds.add(receipt.id)
    }
    return outbox
  }

  /** 回执表（只读）。 */
  get receipts(): readonly OutboxReceipt[] {
    return this.receiptsValue
  }

  /** 已经发出去过多少条。 */
  get deliveredCount(): number {
    return this.deliveredIds.size
  }

  /**
   * 把一批 utterances 发出去（**只该在内核提交之后调用**）。
   *
   * 逐条独立：一条失败不影响后面的（她是"说了几句"，不是"一个原子事务"）。
   */
  async deliver(utterances: readonly Utterance[]): Promise<OutboxReceipt[]> {
    const produced: OutboxReceipt[] = []

    for (const utterance of utterances) {
      if (this.settledIds.has(utterance.id)) continue // 恰好一次：**有回执**（成功或失败）就跳过

      const item: OutboxItem = {
        id: utterance.id,
        speakerId: utterance.speakerId,
        text: utterance.text,
        at: utterance.at,
        ...(utterance.audience === undefined ? {} : { audience: [...utterance.audience] }),
      }

      try {
        await this.options.deliver(item)
        produced.push({ id: item.id, status: 'delivered', at: this.options.now() })
        this.deliveredIds.add(item.id)
      } catch (error) {
        // 失败**不当作成功**，也**不重试**：重试可能让群里看到两遍 ——
        // 对外可见的重复无法收回，比漏发更糟。她下次感知会读到这条 failed 回执。
        produced.push({
          id: item.id,
          status: 'failed',
          at: this.options.now(),
          reason: describe(error),
        })
        this.options.warn(`[world-outbox] 发射失败（不重试，已记回执）：${describe(error)}`)
      }
      // 不论成败都**落定**：这条发言的投递机会已经用完
      this.settledIds.add(item.id)
    }

    if (produced.length > 0) {
      this.receiptsValue.push(...produced)
      if (this.receiptsValue.length > KEEP_RECEIPTS) {
        this.receiptsValue = this.receiptsValue.slice(-KEEP_RECEIPTS)
      }
      await this.enqueueSave()
    }
    return produced
  }

  /** 最近 `count` 条回执（给观测投影用：她"知道"自己刚才说了什么、有没有说出去）。 */
  recent(count = 10): readonly OutboxReceipt[] {
    return this.receiptsValue.slice(-count)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private enqueueSave(): Promise<void> {
    const run = this.saveQueue.then(() => this.saveNow())
    this.saveQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 原子落盘（临时文件 + rename）—— 与 clock/kernel 同一纪律。 */
  private async saveNow(): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ receipts: this.receiptsValue }, null, 2), { flag: 'wx' })
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
