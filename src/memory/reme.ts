/**
 * ReMe 的 HTTP client —— `MemoryProvider` 的一个实现（T14）。
 *
 * 协议：`POST <endpoint>/<job>`，请求/响应都是 JSON，响应形状
 * `{ success, answer, metadata }`。
 *
 * ## ⚠️ 端点纪律：**只允许回环**
 *
 * ReMe 的 HTTP 接口**没有鉴权**（spec §6.9）。所以端点是回环地址才算配置正确；
 * 配成别的地址时**装载期就拒绝**（不是等第一次召回才失败）——
 * 一个无鉴权的记忆后端暴露到网络上，比"记忆不可用"严重得多。
 *
 * **这与 `url-guard`（spec §7.4-A）的方向相反，但不矛盾** —— 两者约束的对象不同：
 *
 * | | 约束的 URL 来自 | 规则 | 防什么 |
 * |---|---|---|---|
 * | `url-guard` | **用户可控**（`web_fetch` 抓用户给的链接） | 拒绝内网/回环 | SSRF |
 * | 本文件 | **运维配置**（`settings.endpoint`） | 只允许回环 | 无鉴权后端暴露 |
 *
 * 也正因为如此，本 client **不经过** `tools/pre-execute` 那条守卫 —— 它不是工具调用，
 * 是服务间通信（同 `ctx.onebot.call` 发消息一样）。
 *
 * ## 降级在哪
 *
 * **不在本文件**。这里如实抛错（HTTP 非 2xx / `success: false` / 形状不认识），
 * 由 `MemoryService` 统一转成"空结果 + WARN"（见 `service.ts` 的职责分工图）。
 * provider 只管把后端的真实状态说出来。
 */
import { createHash } from 'node:crypto'

import { splitRemeAnswer } from './reme-answer.ts'
import type { MemoryHealth, MemoryHit, MemoryProvider, Trajectory } from './service.ts'

/** ReMe 的响应信封。字段都设为 unknown —— 外部数据先当不可信读。 */
interface RemeEnvelope {
  success?: unknown
  answer?: unknown
  metadata?: unknown
}

export interface RemeProviderOptions {
  /** 已通过回环校验的端点（不带尾部斜杠）。 */
  endpoint: string
  /**
   * **快路径**超时（毫秒）：`search` 与 `health_check`。
   *
   * 这两个在**用户可感路径**上（bridge `await memory.search(...)` 才去问模型），
   * 所以必须短 —— 后端卡住时尽早降级成空召回，而不是让用户多等。
   */
  timeoutMs: number
  /**
   * **慢路径**超时（毫秒）：`auto_memory` 与 `auto_dream`。
   *
   * ⚠️ **为什么不与 `timeoutMs` 共用一个值**（T41 的根因）：ReMe 的写回要在**服务端跑
   * LLM 沉淀**，2026-09-26 实测单次要 **19.0s / 27.1s**，而 `search` 只要 **5–35ms** ——
   * 差 3 个数量级。共用 10s 阈值的结果是慢路径**无条件被误报为“写回失败”**，
   * 而且真故障（如 `success: false`）会先被超时砍掉 —— **整个写回故障通道变成盲区**。
   *
   * 不传则退回 `timeoutMs`（即旧行为）。所以“分档”是**显式选择**，
   * 不会隐式把超时放大 —— 测试里不传就还是原来那个语义。
   */
  writeTimeoutMs?: number
}

/**
 * 需要长阈值的 job —— 服务端要跑 LLM 的那批。
 *
 * 按** job 名**分类而不是按调用方法分类，是因为超时最终作用在 `post()` 上，
 * 而 `post()` 只知道 job 名 —— 在这里建表可以避开把每个方法都传一遍阈值。
 */
const SLOW_JOBS = new Set(['auto_memory', 'auto_dream'])

/**
 * 校验端点是**回环**并返回规范化后的基址。
 *
 * 接受：`127.0.0.0/8`、`::1`、`localhost`（含 `[::1]` 的字面量写法）。
 * 拒绝：其余一切 —— 包括 `0.0.0.0`（"所有接口"作为**目标**语义含糊，宁可让人显式写回环）。
 *
 * @throws 协议不是 http/https、URL 非法、或 host 不是回环时。
 */
export function assertLoopbackEndpoint(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`记忆端点不是合法 URL：${endpoint}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`记忆端点只允许 http/https，收到 ${url.protocol}`)
  }

  if (!isLoopbackHost(url.hostname)) {
    throw new Error(
      `记忆端点必须是回环地址（ReMe 的 HTTP 接口没有鉴权，暴露到网络上是危险的）——` +
        `收到 host="${url.hostname}"。回环写法：127.0.0.1 / ::1 / localhost。`,
    )
  }

  // 去掉尾部斜杠，后面拼 job 时统一处理
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** `hostname` 是不是回环。`URL` 已把 `[::1]` 归一成 `::1`。 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  // 127.0.0.0/8 —— 整段都是回环（不只是 127.0.0.1）
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * 文件名里不能出现的字符。
 *
 * 对标 ReMe 的 `_INVALID_CHARS`（`steps/file_io/_path.py`：`[<>:"/\\|?*\x00-\x1f]`），
 * 但用 `\p{Cc}`（Unicode 的 Control 类别）**略严一档**：它除了 `\x00-\x1f`，
 * 还涵盖 DEL（`\u007f`）与 C1 控制符（`\x80-\x9f`）。
 *
 * 这里**宁可多替换**：我们的输出要保证"对任意输入都能过 ReMe 的校验"，
 * 而比后端**严**不产生风险（比后端**松**才会漏掉非法字符）。顺带避开了
 * `no-control-regex` 那条 lint 规则 —— 用属性转义比写裸控制字符范围更清楚。
 */
const UNSAFE_NAME_CHARS = /[<>:"/\\|?*\p{Cc}]/gu

/** ReMe 的 `_RESERVED_NAMES` —— Windows 设备名，当文件名会被系统劫持。 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 把我们的 session id 映射成 ReMe 能接受的 `session_id`。
 *
 * ## 为什么必须映射
 *
 * ReMe **把 `session_id` 当文件名组件用**（它会写 `.../sessions/<session_id>.jsonl`），
 * 所以校验的是文件名合法性（`validate_session_id` → `validate_filename_component`）：
 * 不允许 `< > : " / \ | ? *`、首尾空白、结尾 `.`、Windows 保留设备名。
 *
 * 而 bridge 的 session id 长这样：`agent:3000000001:group:3000000003` —— **一堆冒号**。
 * 于是 ReMe 回 `success: false, answer: "Error: session_id contains invalid characters"`，
 * 表现为**每轮写回静默失败**（召回自然一直是空的，但看起来像"没记住"而不是"没写进去"）。
 * 2026-09-26 实测踩到，见 ADR 0014。
 *
 * ## 为什么不是直接 hash（像官方集成那样）
 *
 * 官方 `integrations/dsh` 用 `dsh-<sha256前24位>`，对任意输入都安全 —— 但也把
 * session 弄成不可读的一串 hex，而 ReMe 的 workspace 是要人去看的
 * （`sessions/*.jsonl`、`digest/*`）。我们的 session id 是**自己生成的受控格式**，
 * 净化后可读且稳定，调试时能一眼看出是哪个群。
 *
 * **兜底用 hash 保证可证明的安全**：净化只解决字符问题，`""` / `.` / `..` /
 * 尾点 / 保留名这些边界它管不了 —— 与其论证"我们的 id 不会长这样"，
 * 不如让不合规的一律落到全安全的 hash 分支。两条路都是确定性的，
 * 所以同一个 session 永远映射到同一个 ReMe id（否则 ReMe 无法累积会话日志）。
 *
 * ⚠️ 映射**不损失召回能力**：ReMe 的 `search` 是**全 workspace 检索**，不按 session
 * 过滤，所以两个模式的记忆照样互通（T16 的验收项）。
 */
export function remeSessionId(sessionId: string): string {
  const safe = sessionId.replace(UNSAFE_NAME_CHARS, '-').trim()
  const usable =
    safe !== '' &&
    safe !== '.' &&
    safe !== '..' &&
    !safe.endsWith('.') &&
    !WINDOWS_RESERVED_NAMES.test(safe.split('.')[0] ?? '')

  if (usable) return safe

  // 落到这里说明净化解决不了（空串 / 点 / 尾点 / 保留名）—— 用 hash 保底
  return `yanxin-${sha256Hex(sessionId).slice(0, 24)}`
}

/** 用 `node:crypto`（Node 内置，不需要新增依赖，也不破坏本文件的"零第三方 import"）。 */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class RemeProvider implements MemoryProvider {
  readonly id = 'reme'

  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly writeTimeoutMs: number

  constructor(options: RemeProviderOptions) {
    this.endpoint = options.endpoint
    this.timeoutMs = options.timeoutMs
    this.writeTimeoutMs = options.writeTimeoutMs ?? options.timeoutMs
  }

  async search(query: string, options: { limit: number }): Promise<readonly MemoryHit[]> {
    const answer = await this.post('search', { query, limit: options.limit })
    return toHits(answer)
  }

  async record(trajectory: Trajectory, sessionId: string): Promise<void> {
    // ReMe 的写回是"把轨迹交给它自动沉淀"（每 session 每天最多一张卡），
    // 所以我们传消息序列 + session 标识，由它决定怎么落盘。
    //
    // ⚠️ 消息形状是被 ReMe 内部的 AgentScope `Msg` **校验**过的
    // （`auto_memory.py` 的 `_to_msg` → `Msg.model_validate`），不是随便的
    // `{role, content}` 就能进：
    //
    //   · `name`  —— **必填**（`Msg.name: str` 无默认值）。缺它直接
    //                pydantic `ValidationError: name Field required`，
    //                而 HTTP 仍是 200（错误在 ReMe 内部被吞成日志）——
    //                症状表现为"召回一直空、写回静默失败"，很难查。
    //                值取 `role`：这正是官方 dsh 集成的做法
    //                （`integrations/dsh/src/messages.ts` 的 `captureMessage`）。
    //   · `content` —— 块数组，不是裸字符串。ReMe 有个把 string 包成
    //                `[{type:'text',text}]` 的兼容分支，但显式给块不依赖它。
    //
    // **刻意不给的字段**（都不是必填，各有取舍）：
    //   · `id` —— 官方给确定性 id（`dsh-<hash>-<session内的 seq>`）是为了让
    //            重发幂等（ReMe 按 id 合并 session 日志）。我们给不出确定性的
    //            唯一值：`record` 是**每轮增量写回**（只有本轮两条消息），
    //            没有全局序号可用，而拿内容去 hash 会让"用户两次说同一句话"
    //            被判成同一条 → 真丢消息。宁可依赖"`MemoryService.record`
    //            不重试"（service.ts 的契约）来保证不重复。
    //   · `created_at` —— provider 只可能填"现在"，与 ReMe 自己的 fallback
    //            （`current.strftime`，归今天的日记）**完全等价**。填一个我们
    //            并不真知道的时间只是伪造精度。真需要补发历史时再加。
    await this.post('auto_memory', {
      // ⚠️ 必须过 `remeSessionId` —— 我们的 id 带冒号，直接发会被 ReMe 当
      // 非法文件名拒掉，而且是 `success: false`（HTTP 200）的静默失败。
      session_id: remeSessionId(sessionId),
      messages: trajectory.messages.map((message) => ({
        name: message.role,
        role: message.role,
        content: [{ type: 'text', text: message.content }],
      })),
    })
  }

  async consolidate(): Promise<void> {
    await this.post('auto_dream', {})
  }

  async health(): Promise<MemoryHealth> {
    try {
      // ⚠️ job 名是 `health_check`（不是 `health`）—— 2026-09-26 对真实 ReMe 0.4.1.13
      // 实测确认：它的 `start` 输出里列出了注册的 job（search / auto_memory / auto_dream /
      // health_check / version / …）。写错 job 名只会得到 404，而 404 会被降级成
      // "健康检查失败"—— 看起来像 ReMe 挂了，其实是我们的名字错了。
      await this.post('health_check', {})
      return { ok: true, detail: `ReMe 可达（${this.endpoint}）` }
    } catch (error) {
      // health 是探测：把它转成结果，而不是让异常穿到调用方（MemoryService 的约定）
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 发一个 job 并拆信封。
   *
   * `answer` 之外的一切（含 `success: false` 的原因）都当作诊断信息抛出去 ——
   * 这一层不该替调用方决定"要不要忽略"。
   *
   * ⚠️ 超时按 job 分档（见 {@link SLOW_JOBS}）：拿同一个阈值管“5ms 的检索”和
   * “20s 的 LLM 沉淀”，前者太宽后者必误报 —— T41 就是这么误报出来的。
   */
  private async post(job: string, body: unknown): Promise<unknown> {
    const url = `${this.endpoint}/${job}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SLOW_JOBS.has(job) ? this.writeTimeoutMs : this.timeoutMs),
    })

    if (!response.ok) {
      throw new Error(`ReMe ${job} 返回 HTTP ${response.status}`)
    }

    const envelope = (await response.json()) as RemeEnvelope
    return unwrap(envelope, job)
  }
}

/** 拆信封：`success: false` 带原因抛出；否则给出 `answer`。 */
function unwrap(envelope: RemeEnvelope, job: string): unknown {
  if (envelope.success === false) {
    const reason = describeFailure(envelope)
    throw new Error(`ReMe ${job} 返回 success=false${reason === '' ? '' : `：${reason}`}`)
  }
  return envelope.answer
}

/**
 * `success: false` 的原因文本。
 *
 * ⚠️ **原因在 `answer` 里，不在 `metadata` 里** —— ReMe 的失败路径统一写
 * `response.answer = f"Error: {err}"`（如 `auto_memory.py:350` 的
 * `invalid session_id`），而 `metadata` 往往只是**无关的统计计数**
 * （实测 `auto_memory` 失败时 metadata 是 `{"auto_tag":{"processed":0,...}}`）。
 *
 * 只读 metadata 的后果很具体：错误消息变成 `success=false：{"auto_tag":{...}}`，
 * 把"session_id 含非法字符"这种**一眼可修**的问题，伪装成"ReMe 内部标签流程异常"
 * —— 查错方向直接被带偏。所以 answer 优先，metadata 只作补充。
 */
function describeFailure(envelope: RemeEnvelope): string {
  const answer = typeof envelope.answer === 'string' ? envelope.answer.trim() : ''
  const meta = describeMetadata(envelope.metadata)
  if (answer !== '' && meta !== '') return `${answer}（metadata=${meta}）`
  return answer === '' ? meta : answer
}

function describeMetadata(metadata: unknown): string {
  if (metadata === undefined || metadata === null) return ''
  if (typeof metadata === 'string') return metadata
  try {
    return JSON.stringify(metadata)
  } catch {
    return String(metadata)
  }
}

/**
 * 把 `answer` 归一成召回结果。
 *
 * ReMe 的 `search` 回答是**给模型看的文本**（markdown），不是结构化条目 —— 所以：
 *   · `undefined` / `null` / 空串 → `[]`（正常形态：没找到）
 *   · 字符串            → 拆**命中头**（`==== 路径:起-止 [score=…] ====`）成多条；
 *                          一行头都认不出时退回"整段一条"（见 `reme-answer.ts`）
 *   · 数组              → 逐条解析成 hit
 *   · 其它形状          → **抛**（形状变了要可见，不能静默当成"没找到"）
 *
 * ⚠️ 最后那条是 spec §7.2 的硬规则：读外部结构时，**不认识就 fail-loud**，
 * 不用默认值掩盖形态变化。这里的"默认值"恰恰最危险 —— 它会表现为"小研记性变差"。
 * （字符串内部的"切不动就整段"是另一回事：形状没变，只是粒度没认出来，
 *   而控制台记忆页的溯源那一栏恰好要靠这层粒度 —— 见 `reme-answer.ts` 的说明。）
 */
function toHits(answer: unknown): MemoryHit[] {
  if (answer === undefined || answer === null) return []

  if (typeof answer === 'string') {
    return splitRemeAnswer(answer)
  }

  if (Array.isArray(answer)) {
    return answer.flatMap((item) => {
      const hit = toHit(item)
      return hit === undefined ? [] : [hit]
    })
  }

  throw new Error(`ReMe search 的 answer 形状不认识：${typeof answer}`)
}

/** 单条：接受字符串，或带 `content`/`text` 的对象。 */
function toHit(item: unknown): MemoryHit | undefined {
  if (typeof item === 'string') {
    return item.trim() === '' ? undefined : { content: item, source: 'reme' }
  }
  if (item === null || typeof item !== 'object') return undefined

  const record = item as { content?: unknown; text?: unknown; source?: unknown; sessionId?: unknown; score?: unknown }
  const content = typeof record.content === 'string' ? record.content : record.text
  if (typeof content !== 'string' || content.trim() === '') return undefined

  return {
    content,
    source: typeof record.source === 'string' ? record.source : 'reme',
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(typeof record.score === 'number' ? { score: record.score } : {}),
  }
}
