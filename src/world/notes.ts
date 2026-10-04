/**
 * 世界的笔记（`notes/*.md`）—— 她自己的本子（T27，spec §6.7）。
 *
 * ## 它为什么**不在**世界里
 *
 * 世界（内核那套）是**结构化权威状态**：实体、动作、事务日志。笔记是**文本**，
 * 而且**人机共用** —— 你也能打开看、也能改。把两种东西混在一起会让世界内核
 * 既要管自洽又要管文件格式（参照框架删掉的那条链路正是这么坏的）。
 *
 * 所以笔记走文件（一篇一个 Markdown），**不产生世界事务**，也不进快照。
 * 它们是"她生活的痕迹"，不是"世界的真相"。
 *
 * ## 三条纪律
 *
 *   · **一篇一个文件、文件名即标题** —— 她翻本子就是列文件名（可读、可手工整理）
 *   · **同名覆盖** —— 不生成 `今天-2.md` 这种垃圾：她想改哪篇就再写一遍同名的那篇。
 *     代价是同名会丢旧内容，所以这一条**写进工具描述**让她知道（宁可如实，不要惊喜）
 *   · **原子落盘**（临时文件 + rename）—— 读者（含她自己、也含你）永远看不到半个文件
 *
 * ## 与 `memory/reme.ts` 的净化规则同源、但兜底不同
 *
 * 那儿的 `session_id` 是**机器的**标识（净化不掉就退回 hash）；这里的标题是**她的**措辞，
 * 退回 hash 会让她找不到自己的本子 —— 所以兜底也尽量保留原样（只截断 + 替换非法字符）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 笔记目录名（在世界目录里）。 */
export const NOTES_DIR = 'notes'

/** 文件名里不允许出现的字符（`reme.ts` 同一张表：Windows 与 POSIX 的交集）。 */
const UNSAFE_NAME_CHARS = /[<>:"/\\|?*\p{Cc}]/gu

/** Windows 设备名 —— 当文件名会被系统劫持。 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 标题截断上限（够读懂，也不会撑爆路径长度限制）。 */
const MAX_TITLE_LENGTH = 60

/** 笔记正文上限（防一次写出一个几十 MB 的文件把磁盘写满）。 */
export const MAX_NOTE_BYTES = 256 * 1024

/**
 * 标题 → 文件名（含 `.md`）。
 *
 * 纯净的标题原样用（她看到的文件名就是她写下的标题）；不纯净的替换非法字符；
 * 实在没法当文件名（空 / 保留设备名 / 只有点）才退回一个**确定性**的短名 ——
 * 确定性是为了保住"同名覆盖"的语义（同一个标题永远落到同一个文件）。
 */
export function noteFileName(title: string): string {
  const cleaned = title
    .replace(UNSAFE_NAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    // 首尾的点 / 空白 / 连字符都去掉：Windows 不允许尾点，`..` 与开头的 `-` 也只会让文件名难认
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_TITLE_LENGTH)
    .trim()

  const usable =
    cleaned !== '' && cleaned !== '.' && cleaned !== '..' && !WINDOWS_RESERVED_NAMES.test(cleaned)

  return `${usable ? cleaned : `note-${shortHash(title)}`}.md`
}

export class WorldNotes {
  private readonly dir: string

  private constructor(dir: string) {
    this.dir = dir
  }

  /** 打开（不存在就建目录 —— 她的本子第一页是空白，不是错误）。 */
  static async open(dir: string): Promise<WorldNotes> {
    const notes = new WorldNotes(join(dir, NOTES_DIR))
    await mkdir(notes.dir, { recursive: true })
    return notes
  }

  /** 本子目录（给人看的绝对路径；测试与工具返回都用它）。 */
  get path(): string {
    return this.dir
  }

  /**
   * 写一篇（**同名覆盖**）。
   *
   * @throws 正文超过 {@link MAX_NOTE_BYTES} 时 —— 静默截断会让"她写下的"与"本子上的"
   *   不一致，那是比报错更坏的失败
   */
  async write(title: string, body: string): Promise<{ path: string }> {
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes > MAX_NOTE_BYTES) {
      throw new Error(`这篇太长了（${bytes} 字节 > ${MAX_NOTE_BYTES}）—— 分几篇写吧`)
    }

    const target = join(this.dir, noteFileName(title))
    // ⚠️ 与 clock/outbox 同款纪律：UUID 临时名 + `wx`（不许覆盖）。固定名在并发写同名
    //    笔记时会互相踩掉对方的临时文件，第二个 rename 直接 ENOENT
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
    return { path: target }
  }

  /**
   * 列出标题（**最近写的在前**）。
   *
   * 排序按文件修改时间倒序 —— 她翻本子时想看的是刚写的那篇；同一毫秒写入的
   * 按名字排（保证顺序稳定可断言）。非 `.md` 文件与临时文件不算笔记。
   */
  async list(): Promise<string[]> {
    const entries = await readdir(this.dir)
    const notes: { title: string; mtimeMs: number }[] = []

    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.md')) continue
      const info = await stat(join(this.dir, entry))
      if (!info.isFile()) continue
      notes.push({ title: entry.slice(0, -3), mtimeMs: info.mtimeMs })
    }

    notes.sort((a, b) => b.mtimeMs - a.mtimeMs || a.title.localeCompare(b.title))
    return notes.map((note) => note.title)
  }
}

/** 短 hash（兜底文件名用；稳定 —— 同标题同文件）。 */
function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)
}