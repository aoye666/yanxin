/**
 * 消息统计（SQLite）—— 控制台首页仪表盘的数据源。
 *
 * ## 为什么是 SQLite、为什么在桥上记
 *
 * 仪表盘要回答"今天收了多少条、回了几条、哪个群最热闹"——这类**事实计数**必须落盘
 * （进程重启不能归零），又没必要动 ReMe（那是记忆，不是计数）。Node 26 内置
 * `node:sqlite`（零依赖），每条消息一行，聚合交给 SQL。
 *
 * 记账点选在**桥**：它是"一条消息被收到 / 一句回复真的发出去了"的唯一事实发生地 ——
 * 收到记 `in`（带"触发了没有"），发送成功才记 `out`（发送失败不是"她说过了"）。
 *
 * ## 三条纪律
 *
 *   · **SQL 全部参数绑定**（`prepare().run/get/all(参数)`）—— 不拼接、不 format，
 *     动态的部分（LIMIT、时间界限）一律作为绑定参数
 *   · **统计失败不影响聊天**：写库失败只 warn（限频 —— 每条消息刷一条 warn 会把
 *     日志淹掉），桥的收发照常
 *   · **这是计数，不是内容**：表里不存消息正文（内容在会话与 ReMe 里），只有
 *     谁、哪、何时、方向、长度 —— 也因此审计脱敏的负担天然不存在
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'

/** 记一条消息事实（桥的记账单元）。 */
export interface StatEntry {
  /** 现实毫秒。 */
  ts: number
  /** `'in'` = 收到；`'out'` = 发出（发送成功才算）。 */
  direction: 'in' | 'out'
  /** `'group' | 'private'`。 */
  channel: 'group' | 'private'
  /** 群号（私聊为 `undefined`）。 */
  groupId?: string
  /** 对端（QQ 号：in 是说话的人，out 是回给谁）。 */
  sender?: string
  /** 是否触发了她的会话（只对 in 有意义：被 @ / 叫到名字）。 */
  responded?: boolean
  /** 文本长度（不存文本本身）。 */
  length?: number
}

/** 首页仪表盘要的聚合结果。 */
export interface StatsOverview {
  /** 今天（本地自然日）收到的消息数。 */
  todayIn: number
  /** 今天发出的回复数。 */
  todayOut: number
  /** 今天收到的消息里触发了她会话的（被 @ / 叫到名字）。 */
  todayTriggered: number
  /** 收到的总数。 */
  totalIn: number
  /** 发出的总数。 */
  totalOut: number
  /** 近 N 天（含今天，旧→新）的按天计数。 */
  days: readonly { day: string; inCount: number; outCount: number }[]
  /** 最热闹的群（按收到的消息数）。 */
  groups: readonly { groupId: string; count: number }[]
}

/** 建表与索引（逐条执行；SQL 是常量，动态值一律走绑定参数）。 */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  direction TEXT NOT NULL,
  channel TEXT NOT NULL,
  groupId TEXT,
  sender TEXT,
  responded INTEGER NOT NULL DEFAULT 0,
  length INTEGER
)`,
  'CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts)',
  'CREATE INDEX IF NOT EXISTS messages_group ON messages(groupId, direction)',
]

/** 写库失败的告警限频：同一分钟内最多一条（否则每条消息刷一行 warn）。 */
class RateLimitedWarn {
  private lastMinute = -1
  private fired = false
  private readonly warn: (message: string) => void

  constructor(warn: (message: string) => void) {
    this.warn = warn
  }

  hit(error: unknown): void {
    const minute = Math.floor(Date.now() / 60_000)
    if (minute === this.lastMinute && this.fired) return
    this.lastMinute = minute
    this.fired = true
    this.warn(
      `[yanxin-stats] 记账失败（聊天不受影响，这一分钟内不再重复报）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export class MessageStats {
  private readonly db: DatabaseSync
  private readonly limitedWarn: RateLimitedWarn

  private readonly insertStmt: StatementSync
  private readonly todayInStmt: StatementSync
  private readonly todayOutStmt: StatementSync
  private readonly todayTriggeredStmt: StatementSync
  private readonly totalStmt: StatementSync
  private readonly daysStmt: StatementSync
  private readonly groupsStmt: StatementSync

  private constructor(db: DatabaseSync, warn: (message: string) => void) {
    this.db = db
    this.limitedWarn = new RateLimitedWarn(warn)

    this.insertStmt = db.prepare(
      'INSERT INTO messages (ts, direction, channel, groupId, sender, responded, length) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    // ⚠️ "今天"用本地自然日对齐（sqlite 的 'localtime' 按机器时区算，与控制台显示一致）。
    this.todayInStmt = db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE direction = 'in' AND date(ts / 1000, 'unixepoch', 'localtime') = date('now', 'localtime')",
    )
    this.todayOutStmt = db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE direction = 'out' AND date(ts / 1000, 'unixepoch', 'localtime') = date('now', 'localtime')",
    )
    this.todayTriggeredStmt = db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE direction = 'in' AND responded = 1 AND date(ts / 1000, 'unixepoch', 'localtime') = date('now', 'localtime')",
    )
    this.totalStmt = db.prepare("SELECT direction, COUNT(*) AS c FROM messages GROUP BY direction")
    this.daysStmt = db.prepare(
      `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS d,
              SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS inCount,
              SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS outCount
       FROM messages
       WHERE ts >= ?
       GROUP BY d ORDER BY d`,
    )
    this.groupsStmt = db.prepare(
      `SELECT groupId, COUNT(*) AS c FROM messages
       WHERE direction = 'in' AND groupId IS NOT NULL AND ts >= ?
       GROUP BY groupId ORDER BY COUNT(*) DESC LIMIT ?`,
    )
  }

  /** 打开（文件不存在就建表）。`:memory:` 用于测试。 */
  static open(path: string, options: { warn?: (message: string) => void; days?: number } = {}): MessageStats {
    const db = new DatabaseSync(path)
    // WAL：桥每条消息写一次，WAL 让读写不互斥（控制台聚合读时聊天线不等锁）
    db.prepare('PRAGMA journal_mode = WAL').run()
    for (const statement of SCHEMA_STATEMENTS) db.prepare(statement).run()
    return new MessageStats(db, options.warn ?? (() => undefined))
  }

  /** 记一条。**永不抛**（统计是旁路，不能因为它影响收发）。 */
  record(entry: StatEntry): void {
    try {
      this.insertStmt.run(
        entry.ts,
        entry.direction,
        entry.channel,
        entry.groupId ?? null,
        entry.sender ?? null,
        entry.responded === true ? 1 : 0,
        entry.length ?? null,
      )
    } catch (error) {
      this.limitedWarn.hit(error)
    }
  }

  /** 首页仪表盘的聚合（读失败给全零 —— 页面显示"没有数据"比 500 好）。 */
  overview(days = 7): StatsOverview {
    try {
      const todayIn = Number((this.todayInStmt.get() as { c: number } | undefined)?.c ?? 0)
      const todayOut = Number((this.todayOutStmt.get() as { c: number } | undefined)?.c ?? 0)
      const todayTriggered = Number((this.todayTriggeredStmt.get() as { c: number } | undefined)?.c ?? 0)

      const totals = { in: 0, out: 0 }
      for (const row of this.totalStmt.all() as { direction: string; c: number }[]) {
        if (row.direction === 'in') totals.in = Number(row.c)
        if (row.direction === 'out') totals.out = Number(row.c)
      }

      // 近 N 天：按本地自然日补零（没消息的天也要有行，sparkline 才不跳）
      const since = Date.now() - days * 86_400_000
      const byDay = new Map<string, { inCount: number; outCount: number }>()
      for (const row of this.daysStmt.all(since) as { d: string; inCount: number; outCount: number }[]) {
        byDay.set(String(row.d), { inCount: Number(row.inCount), outCount: Number(row.outCount) })
      }
      const daysArray: { day: string; inCount: number; outCount: number }[] = []
      for (let index = days - 1; index >= 0; index -= 1) {
        const d = new Date(Date.now() - index * 86_400_000)
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        const hit = byDay.get(key)
        daysArray.push({ day: key, inCount: hit?.inCount ?? 0, outCount: hit?.outCount ?? 0 })
      }

      const groups = (this.groupsStmt.all(since, days) as { groupId: string; c: number }[]).map((row) => ({
        groupId: String(row.groupId),
        count: Number(row.c),
      }))

      return { todayIn, todayOut, todayTriggered, totalIn: totals.in, totalOut: totals.out, days: daysArray, groups }
    } catch (error) {
      this.limitedWarn.hit(error)
      return { todayIn: 0, todayOut: 0, todayTriggered: 0, totalOut: 0, totalIn: 0, days: [], groups: [] }
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // 关闭失败随进程退出自然收尾
    }
  }
}
