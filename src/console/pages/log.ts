/**
 * 日志页 —— 实例运行日志的**尾部**（只读）。
 *
 * ## 它读的是哪个文件
 *
 * 实例由 `nohup … > /tmp/yanxin-<轮次>.log` 启动（Git Bash 的 `/tmp` 映射到
 * `os.tmpdir()`，实测与 node 看到的是同一个目录）。轮次后缀没人登记，
 * 所以这里**扫 tmpdir 下最新的 `yanxin*.log`**（按 mtime）—— 重启后自然跟上
 * 新轮次。装配想钉死文件的话给 console 行 config 加 `logFile`，它优先。
 *
 * ## 为什么只有尾部
 *
 * 日志一天几十轮、单轮可以很大；控制台要回答的是"**现在**发生了什么"
 * （世界装载了吗、429 出现没出现、她回话了没有），不是考古。尾部给最后
 * 一段（默认 150 行），考古去终端 `grep`。
 *
 * ## 只读，且只读日志
 *
 * 这一页没有写接口。日志是"已经发生的事"，控制台不提供"改日志"这种动作；
 * 日志内容经 `sendJson` 出口脱敏（密钥形态会被抹掉）+ `plain()` 渲染
 * （`<pre>` 原样文本），日志里出现什么标签都只是文字。
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Block } from '../logic.ts'

/** 装配纪律（ADR 0004）：命名导出 + `inject`，**不写 default**。 */
export const name = 'yanxin-console-log-page'
export const inject = ['console']

/** 默认尾部行数。 */
export const LOG_TAIL_LINES = 150

/** 页面/接口读到的日志现场（纯函数的输入）。 */
export interface LogView {
  /** 日志文件路径（绝对）。找不到时为 `undefined`。 */
  file: string | undefined
  /** 文件最后修改时刻（本地可读）。 */
  mtimeText: string
  /** 尾部文本（已经是纯文本，按行）。 */
  tail: string
  /** 实际给的行数（可能少于上限 —— 整个文件就这么大）。 */
  lines: number
}

/** 候选文件：名字 + mtime（ms）。测试注入用，避免真的去碰文件系统。 */
export interface LogCandidate {
  name: string
  mtimeMs: number
}

/**
 * 从候选里挑"当前轮"的日志：`yanxin*.log` 里 **mtime 最新**的那个 ——
 * 重启实例会开新文件，最新的就是正在写的。没有候选 = 没找到（页面上如实说）。
 */
export function pickLogFile(candidates: readonly LogCandidate[]): LogCandidate | undefined {
  return [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
}

/**
 * 取一段文本的**尾部**：最后 `maxLines` 行（不含结尾空行）。
 *
 * 行按 `\n` 切；末尾的空行（文件通常以换行结尾）不算内容。
 * 超长的单行**不截断** —— 日志行里有价值的信息经常就在长行里（报错原因），
 * 横向滚动比看不到强。
 */
export function tailOf(text: string, maxLines: number): { tail: string; lines: number } {
  const all = text.split('\n')
  while (all.length > 0 && (all[all.length - 1] ?? '').trim() === '') all.pop()
  const kept = all.slice(-maxLines)
  return { tail: kept.join('\n'), lines: kept.length }
}

/** 把一次日志读取摘成区块（纯函数）。流地址由调用方给（挂载路径相关）。 */
export function renderLogBlocks(view: LogView, base: string): readonly Block[] {
  if (view.file === undefined) {
    return [
      {
        kind: 'notice',
        tone: 'warn',
        text:
          '没找到日志文件 —— 实例要用 `nohup … > /tmp/yanxin-<轮次>.log` 这种方式启动才有' +
          '（这一页读的是系统临时目录下最新的 `yanxin*.log`）。前端窗口里跑的实例没有这个文件。',
      },
    ]
  }
  return [
    {
      kind: 'notice',
      tone: 'info',
      text:
        `当前日志：\`${view.file}\`（最后写入 ${view.mtimeText}）。下面是**实时流** —— ` +
        '打开页面时先补一段尾部，之后每一条新日志都自动滚进来。',
    },
    { kind: 'stream', url: `${base}/api/log/stream` },
    {
      kind: 'p',
      text:
        '连接断了会自动重连（浏览器 EventSource 的行为）；往回翻历史用终端 grep。' +
        '**这一路要 token** —— 流里是运行时日志原文（插件诊断、异常消息、守卫打的目标 URL），' +
        '出口只抹得掉认得出的密钥形态。`EventSource` 不能带请求头，所以 token 走查询串。',
    },
  ]
}

/**
 * 定位"当前轮"的日志文件：行 config 指定的优先；否则扫 tmpdir 下 `yanxin*.log`
 * 取 **mtime 最新**（重启开新文件后自然跟上）。返回文件路径与当前大小
 * （SSE 增量流的 offset 依据）。找不到返回 `{ file: undefined }`。
 */
export async function locateLog(configured: string | undefined): Promise<{ file: string | undefined; size: number }> {
  try {
    let file: string | undefined
    if (configured !== undefined && configured !== '') {
      file = configured
    } else {
      const dir = tmpdir()
      const entries = (await readdir(dir)).filter((fileName) => /^yanxin.*\.log$/.test(fileName))
      const candidates: LogCandidate[] = []
      for (const entry of entries) {
        try {
          const info = await stat(join(dir, entry))
          if (info.isFile()) candidates.push({ name: entry, mtimeMs: info.mtimeMs })
        } catch {
          // 文件刚好被清了：跳过（扫描与写入竞争是常态）
        }
      }
      const picked = pickLogFile(candidates)
      file = picked === undefined ? undefined : join(dir, picked.name)
    }
    if (file === undefined) return { file: undefined, size: 0 }
    const info = await stat(file)
    return { file, size: info.size }
  } catch {
    return { file: undefined, size: 0 }
  }
}

/**
 * 读日志文件从 `offset` 字节到当前末尾的一段（SSE 增量）。
 *
 * 返回 `nextOffset` 给下一次调用 —— 单向前进，不回头。UTF-8 多字节字符如果
 * 恰好跨在 offset 上会出现一个替换符（U+FFFD）：日志按整行追加、概率极低，
 * 乱一个字符比每次全文件重读划算。
 */
export async function readIncrement(file: string, offset: number): Promise<{ text: string; nextOffset: number }> {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const length = size - offset
    if (length <= 0) return { text: '', nextOffset: offset }
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, offset)
    return { text: buffer.toString('utf8'), nextOffset: size }
  } finally {
    await handle.close()
  }
}

/** 读一次日志现场（真实 IO；异常都如实变提示，不让页面 500）。 */
async function readLog(configured: string | undefined): Promise<LogView> {
  try {
    const located = await locateLog(configured)
    if (located.file === undefined) return { file: undefined, mtimeText: '', tail: '', lines: 0 }

    const info = await stat(located.file)
    const text = await readFile(located.file, 'utf8')
    // 只读尾部：日志文件可以很大，整读会拖慢页面。取尾部靠"从后面切" —— 先读
    // 整个文件再切太浪费，但 Node 没有"读文件尾 N 行"的现成 API；这里读最后
    // 512KB（对 150 行日志绰绰有余），不够再退化整读。
    const handle = text.slice(-512 * 1024)
    const trimmed = handle.length < text.length ? handle.slice(handle.indexOf('\n') + 1) : handle
    const { tail, lines } = tailOf(trimmed, LOG_TAIL_LINES)
    return { file: located.file, mtimeText: new Date(info.mtimeMs).toLocaleString(), tail, lines }
  } catch (error) {
    // 读不到（权限/被删/编码）就如实说 —— 比一个 500 好查
    return {
      file: undefined,
      mtimeText: error instanceof Error ? error.message : String(error),
      tail: '',
      lines: 0,
    }
  }
}

/** 装页（**只有页，没有写接口** —— 日志是已发生的事）。 */
export function apply(ctx: Context): void {
  ctx.console.page({
    slug: 'log',
    title: '日志',
    async render({ base }) {
      // 行 config 指定的日志文件优先（console 服务上的 `logFilePath`）；
      // 没配就扫系统临时目录下最新的 `yanxin*.log`（readLog 里的默认行为）。
      const console = ctx.get('console') as { logFilePath?: string | undefined } | undefined
      const view = await readLog(console?.logFilePath)
      return renderLogBlocks(view, base)
    },
  })
}
