/**
 * 写回 **outbox** —— 每个 session 攒满 N 轮才交给 provider（T42）。
 *
 * ## 为什么要攒批
 *
 * 两条实测理由（2026-09-26，取证见 `spike/t41-latency.mjs`、结论见 todo T41）：
 *
 * 1. ReMe 的 `auto_memory` 要在**服务端跑 LLM 沉淀**，单次实测 19.0s / 27.1s。
 *    每轮都发 = 每轮都付一次 LLM 往返。
 * 2. 更关键的是第二次比第一次慢 —— ReMe 自己的回复说明了原因：
 *    `Merged the second entry into the note`。每轮都写会让它**反复 merge 同一张卡**，
 *    是纯重复劳动。攒 N 轮一次写正好消掉。
 *
 * 而"每轮都写"对**对话连贯性没有贡献**：短期连贯靠 DSH session（每轮 `followup` 累积在
 * 同一个 session 里），ReMe 只管**跨 session 的长期记忆**。所以节流的是沉淀频率，不是回复能力。
 *
 * ## 为什么落盘而不是内存
 *
 * 攒批把"丢数据"的窗口从一轮放大到 N 轮：进程在攒够之前退出，内存缓冲就没了。
 * 落盘（每 session 一个 append-only `.jsonl`）让这一批在重启后仍然存在。
 *
 * ## 崩溃语义：宁可重复，不可丢
 *
 * `flush` 是"先 send、成功后才删文件"。若在两者之间崩溃，重启会把同一批**再发一次** ——
 * ReMe 侧没有消息 `id` 可去重（我们刻意不给，理由见 `reme.ts` 里 `record` 的注释），
 * 所以会重复沉淀。选它是因为"重复一条记忆"远比"丢掉一整批"便宜。
 *
 * ## 并发
 *
 * 同一 session 的 append 与 flush 走**同一条 promise 链**（照 `bridge.enqueue` 的惯例），
 * 所以 flush 的"读文件 → send → 删文件"之间不会被新 append 插入 —— 不需要两阶段改名。
 *
 * ⚠️ 链上只排**短任务**：达到阈值时的 flush 用 {@link MemoryOutbox.scheduleFlush}
 * 排到链尾但**不被 `append` await** —— 否则 19-27s 的沉淀会接回对话路径；
 * 而它也不能脱离链直接跑，否则与下一次 flush 并发重发同一批。
 *
 * ## 装配纪律
 *
 * 本文件**不依赖 Cordis**：纯 IO + 计数，`send` 与 `warn` 由 `MemoryService` 注入。
 * 这样它能被单测直接驱动（不需要起 Context），也让"攒批策略"与"降级包装"各在一层。
 */
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describeError as describe } from '../describe.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { remeSessionId } from './reme.ts'
import type { Trajectory, TrajectoryMessage } from './service.ts'

/**
 * 默认落盘目录。
 *
 * 路径推导与 `url-guard.ts` 的审计文件同一套惯例（`$DSH_HOME/yanxin/<用途>/`）——
 * 两处往用户目录写文件的代码不该各写一份 `DSH_HOME` 回退逻辑。
 *
 * ⚠️ 是**函数**不是模块级常量：测试必须能把自己关进临时目录，
 * 否则跑一次单测就往真实 `$DSH_HOME` 写文件（`MemoryService` 的默认值在装载时才取）。
 */
export function defaultOutboxDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'yanxin', 'memory-outbox')
}

/** 落盘的一轮对话（一轮 = 一次 `record` 调用）。 */
export interface OutboxRound {
  /** 入队时间（毫秒）。只用于诊断，不参与排序。 */
  ts: number
  /**
   * 调用方给的**原始** session id（未经文件名净化）。
   *
   * ⚠️ 为什么要在记录里存一份、而不是用文件名当它：`MemoryProvider.record` 的契约是
   * “拿到调用方给的 id”。ReMe 幂等所以无所谓，但换一个真需要原始 id 做自己的映射的后端时，
   * 只剩净化值就是契约退化。存在这里也让 `recover()` 重启后仍能把原始值交回去。
   */
  sessionId: string
  messages: TrajectoryMessage[]
}

export interface MemoryOutboxOptions {
  /** 缓冲目录（每 session 一个 `.jsonl`）。 */
  dir: string
  /** 攒满多少轮交给 provider。`1` = 退化为"每轮即写"（留一条不改代码就回退的路）。 */
  rounds: number
  /** 真正把一批交出去。抛错由本类转成 `warn`，**不**冒到调用方。 */
  send(trajectory: Trajectory, sessionId: string): Promise<void>
  /** 失败出口（`MemoryService` 接自己的 logger，保持降级可观测）。 */
  warn(message: string): void
}

/** 一个 session 的 outbox 状态。 */
interface Entry {
  /** 待沉淀的轮数（内存计数，重启由 `recover()` 从盘上恢复）。 */
  rounds: number
  /** 该 session 的串行链尾。 */
  tail: Promise<void>
}

export class MemoryOutbox {
  private readonly dir: string
  private readonly rounds: number
  private readonly send: (trajectory: Trajectory, sessionId: string) => Promise<void>
  private readonly warn: (message: string) => void

  private readonly entries = new Map<string, Entry>()

  constructor(options: MemoryOutboxOptions) {
    this.dir = options.dir
    // 至少攒 1 轮：配 0 或负数会让"每次 append 都 flush"与"永不 flush"都变得含混
    this.rounds = Math.max(1, options.rounds)
    this.send = options.send
    this.warn = options.warn
  }

  /** 某 session 当前攒了多少轮（供测试与控制台观察）。 */
  pendingRounds(sessionId: string): number {
    return this.entries.get(remeSessionId(sessionId))?.rounds ?? 0
  }

  /**
   * 所有 session 攒着的轮数之和。
   *
   * 为什么要单独这个口径：`flushNow` 是**发成功之后**才把计数清零的，所以沉淀在飞的那段
   * 时间里这里仍然 >0 —— "总数回到 0" 就等于"没有写回还没落地"。而 `pendingRounds` 要先
   * 知道有哪些 session，测试排空时用不起。
   */
  pendingRoundsTotal(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.rounds
    return total
  }

  /**
   * 收下一轮对话：落盘 + 计数，攒够则在**后台**触发 flush。
   *
   * 刻意不 await flush —— 那是要跑 19~27 秒的 LLM 沉淀，把它接回对话路径上
   * 等于让"记东西"拖住"回消息"。本方法自身的失败也只记 warn（写回不阻塞对话）。
   */
  append(sessionId: string, trajectory: Trajectory): Promise<void> {
    const key = remeSessionId(sessionId)
    let reached = false
    return this
      .enqueue(
        key,
        async () => {
          const round: OutboxRound = { ts: Date.now(), sessionId, messages: [...trajectory.messages] }
          await mkdir(this.dir, { recursive: true })
          await appendFile(this.fileFor(key), `${JSON.stringify(round)}\n`, 'utf8')

          const entry = this.touch(key)
          entry.rounds += 1
          reached = entry.rounds >= this.rounds
        },
        '写回入队失败（忽略，不阻塞对话）',
      )
      .then(() => {
        // ⚠️ 触发点必须在**链任务之外**：在任务内直接 `void flushNow()` 会绕过串行链，
        // 与后续的 flush 并发跑 —— 两边读到同一批、各发一次（单测抓到过）。
        if (reached) this.scheduleFlush(key)
      })
  }

  /** 显式 flush 一个 session（未满批也发）。供优雅退出与控制台手动沉淀用。 */
  flush(sessionId: string): Promise<void> {
    const key = remeSessionId(sessionId)
    return this.enqueue(key, () => this.flushNow(key), '写回沉淀失败（保留缓冲，下轮再试）')
  }

  /**
   * 把一次 flush **排到链尾**（不 await 它）。
   *
   * 为什么不能直接调：沉淀要跑 19-27s，把它接在 append 的 await 链上等于让
   * "记东西"拖住"回消息"；但也不能完全脱离链跑 —— 那样会与下一次 flush 并发重发同一批。
   * 排队 + 不等 = 既不阻塞，又不交错。
   */
  private scheduleFlush(key: string): void {
    const entry = this.touch(key)
    entry.tail = entry.tail.then(() => this.flushNow(key)).catch((error: unknown) => {
      this.warn(`写回沉淀失败（保留缓冲，下轮再试）：${describe(error)}`)
    })
  }

  /**
   * 把所有已知 session 的缓冲 flush 掉（**不**并发，逐个走各自的链）。
   *
   * 用于实例优雅退出：攒了 3 轮就重启的话，不落这次就永远等不到第 10 轮。
   */
  async flushAll(): Promise<void> {
    for (const sessionId of [...this.entries.keys()]) await this.flush(sessionId)
  }

  /**
   * 启动扫描：从盘上恢复计数，并把**已达阈值**的残留补发出去。
   *
   * 为什么需要：上次进程可能在"send 成功之前"崩掉，那批还在文件里。
   * 未满阈值的只恢复计数（继续攒），不打扰 provider。
   */
  async recover(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return // 目录还不存在 = 一条都没攒过，正常形态
    }

    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      // ⚙️ 文件名的 stem **就是** entries 的 key：公开方法都在入口过一道 `remeSessionId`，
      // 而它是确定且幂等的（见 `reme.ts`）。重启前用 `admin:1`、重启后用 `admin-1`
      // 不会分裂成两个 entry —— 因为两边归一到同一个 key。
      const key = name.slice(0, -'.jsonl'.length)
      const rounds = await this.countRounds(key)
      if (rounds === 0) continue
      this.touch(key).rounds = rounds
      if (rounds >= this.rounds) await this.flush(key)
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /** 实际的沉淀动作：读文件 → send → 成功才删。只在链内调用（key 已净化）。 */
  private async flushNow(key: string): Promise<void> {
    const rounds = await this.readRounds(key)
    if (rounds.length === 0) {
      this.touch(key).rounds = 0
      return
    }

    const trajectory: Trajectory = { messages: rounds.flatMap((round) => round.messages) }
    // ⚙️ 用**原始** session id 交给 provider（文件名只是存储键）。
    // 同一份缓冲里的轮同属一个 session，取第一条即可；旧文件没这个字段时退回净化值。
    const sessionId = rounds[0]?.sessionId ?? key
    try {
      await this.send(trajectory, sessionId)
    } catch (error) {
      // 文件**原样留着**：下轮攒够会连这批一起再发（宁可重复，不可丢）
      this.warn(`沉淀 ${rounds.length} 轮失败，缓冲已保留：${describe(error)}`)
      return
    }

    try {
      await unlink(this.fileFor(key))
    } catch (error) {
      // 发成功了但没删掉 —— 只可能让下次重复发一次，不影响正确性
      this.warn(`缓冲已沉淀但清理失败（下次可能重复发一次）：${describe(error)}`)
    }
    this.touch(key).rounds = 0
  }

  /** 把任务排到该 session 的链尾；链**永不 reject**（失败已转 warn）。 */
  private enqueue(
    sessionId: string,
    task: () => Promise<void>,
    failMessage: string,
  ): Promise<void> {
    const entry = this.touch(sessionId)
    const next = entry.tail.then(task).catch((error: unknown) => {
      this.warn(`${failMessage}：${describe(error)}`)
    })
    entry.tail = next
    return next
  }

  private touch(sessionId: string): Entry {
    let entry = this.entries.get(sessionId)
    if (entry === undefined) {
      entry = { rounds: 0, tail: Promise.resolve() }
      this.entries.set(sessionId, entry)
    }
    return entry
  }

  private fileFor(key: string): string {
    // ⚙️ key 已经过 `remeSessionId` 净化（公开方法入口做的），这里不再二次净化。
    // 复用那一套而不是另写一份：我们的 session id 带冒号，而 ReMe 把它当文件名组件校验
    // （`reme.ts` 记过那个坑）—— 两套规则一旦漂移，症状是"缓冲在但找不到"。
    return join(this.dir, `${key}.jsonl`)
  }

  private async readRounds(key: string): Promise<OutboxRound[]> {
    let raw: string
    try {
      raw = await readFile(this.fileFor(key), 'utf8')
    } catch {
      return []
    }
    raw = await this.truncateResidual(key, raw)
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as OutboxRound
          return Array.isArray(parsed?.messages) ? [parsed] : []
        } catch {
          // 坏行跳过：它不该让整批都发不出去（残片已由 truncateResidual 截掉，
          // 这里剩的是"中间被外力改坏"的行 —— 缓冲的语义是宁可丢一行不可炸整批）
          this.warn('缓冲里有一行不是合法 JSON，已跳过')
          return []
        }
      })
  }

  /**
   * 截掉末尾的**崩溃残片**（append 被中断留下的、没有换行的半行）。
   *
   * 合法文件必以 `\n` 结尾（`append` 每行带换行）—— 不以 `\n` 结尾就是残片。
   * 只在内存里"跳过"是不够的：下一次 `appendFile` 会把新行**直接粘在残片后面**
   * （追加到末字节），两行物理合并成一条坏行 —— 那一轮也进不了沉淀。
   * 一次撕裂写实际丢两轮。截断走 tmp + rename（与内核日志同款纪律）。
   */
  private async truncateResidual(key: string, raw: string): Promise<string> {
    if (raw === '' || raw.endsWith('\n')) return raw
    const cut = raw.lastIndexOf('\n')
    const kept = cut === -1 ? '' : raw.slice(0, cut + 1)
    const path = this.fileFor(key)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, kept, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, path)
      this.warn('缓冲末尾有不完整的残片（写入中断的痕迹），已截断')
    } catch (error) {
      // 截断失败不挡读（内存里这批照样按行解析）；下一拍 recover 会再试
      this.warn(`截断缓冲残片失败（下次再试）：${describe(error)}`)
    }
    return kept
  }

  private async countRounds(key: string): Promise<number> {
    return (await this.readRounds(key)).length
  }
}

/** 写一批到磁盘文件（测试辅助：造"重启后仍有残留"的场景）。 */
export async function writeOutboxFile(dir: string, sessionId: string, rounds: OutboxRound[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  const body = rounds.map((round) => JSON.stringify(round)).join('\n')
  await writeFile(outboxFileOf(dir, sessionId), body === '' ? '' : `${body}\n`, 'utf8')
}

/** 供测试断言缓冲文件位置（与实现走同一条路径推导）。 */
export const outboxFileOf = (dir: string, sessionId: string): string =>
  join(dir, `${remeSessionId(sessionId)}.jsonl`)
