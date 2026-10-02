/**
 * 假 OneBot 端（测试夹具）。
 *
 * 为什么需要：我们的 `onebot` 服务是反向 WS 的**服务端**，而 NapCat 是客户端。
 * 所以测试要模拟一个"NapCat"：带正确的握手头连上来，然后
 *   - 推事件给我们
 *   - 收我们的 API 调用并回响应
 *
 * 这样整条传输链路（握手 / 鉴权 / 账号路由 / 帧分类 / echo 关联 / 串号检测 / 断连清理）
 * 都能在没有 QQ、没有 NapCat 的情况下测到。
 *
 * ⚠️ 只用命名导出（ADR 0004）。
 */
import { WebSocket } from 'ws'
import type { ClientRole } from '../../src/onebot/protocol.ts'

export interface FakeOneBotOptions {
  /** 形如 `ws://127.0.0.1:12345/` */
  url: string
  /** 追加到 url 后面的路径（如 `/onebot/v11`），用于测路径校验。 */
  path?: string
  selfId: string
  role?: ClientRole
  token?: string
  /** 覆写/省略任意握手头，用于测非法握手 */
  overrides?: Record<string, string | undefined>
  /** token 放 query 而非 Authorization 头（部分实现两种都提供）。 */
  tokenInQuery?: boolean
}

export interface ApiCall {
  action: string
  params: Record<string, unknown>
  echo: string
}

export type Responder = (call: ApiCall) => { status: string; retcode: number; data: unknown } | undefined

const DEFAULT_TIMEOUT = 5_000

export class FakeOneBot {
  readonly ws: WebSocket
  /** 收到的全部 API 调用（按到达顺序）。 */
  readonly calls: ApiCall[] = []
  /** 收到的事件之外的原始帧（诊断用）。 */
  readonly rawFrames: unknown[] = []

  /** 响应策略。返回 `undefined` 表示**故意不响应**（用于测调用超时）。 */
  responder: Responder = () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } })

  private readonly waiters: Array<{ action: string; resolve: (call: ApiCall) => void }> = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(data))
      } catch {
        this.rawFrames.push(data)
        return
      }
      this.rawFrames.push(parsed)

      const obj = parsed as Record<string, unknown>
      if (typeof obj.action !== 'string') return // 不是 API 调用（我们不希望服务端推事件给我们）

      const call: ApiCall = {
        action: obj.action,
        params: (obj.params ?? {}) as Record<string, unknown>,
        echo: typeof obj.echo === 'string' ? obj.echo : '',
      }
      this.calls.push(call)

      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i]!.action === call.action) {
          this.waiters.splice(i, 1)[0]!.resolve(call)
        }
      }

      const response = this.responder(call)
      if (response) {
        this.ws.send(JSON.stringify({ ...response, data: response.data, echo: call.echo }))
      }
    })
  }

  /** 连上并握手。失败（服务端回非 101）时把状态码带回来，便于断言拒绝行为。 */
  static async connect(
    options: FakeOneBotOptions,
  ): Promise<{ ok: true; peer: FakeOneBot } | { ok: false; status: number; body: string }> {
    const headers: Record<string, string> = {}
    const put = (name: string, value: string | undefined): void => {
      if (value !== undefined) headers[name] = value
    }
    const o = options.overrides ?? {}
    put('X-Self-ID', 'X-Self-ID' in o ? o['X-Self-ID'] : options.selfId)
    put('X-Client-Role', 'X-Client-Role' in o ? o['X-Client-Role'] : (options.role ?? 'Universal'))
    // tokenInQuery 时不放头，改放 query
    put('Authorization', options.token && !options.tokenInQuery ? `Bearer ${options.token}` : undefined)
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) delete headers[k]
      else headers[k] = v
    }

    // 路径与 query 形式 token 拼到 URL 上
    let target = options.url + (options.path ? options.path.replace(/^\//, '') : '')
    if (options.token && options.tokenInQuery) {
      target += `?access_token=${encodeURIComponent(options.token)}`
    }

    const ws = new WebSocket(target, { headers })

    const outcome = await new Promise<
      { ok: true } | { ok: false; status: number; body: string } | { ok: false; status: 0; body: string }
    >((resolve) => {
      let settled = false
      const done = (v: { ok: true } | { ok: false; status: number; body: string }): void => {
        if (settled) return
        settled = true
        resolve(v)
      }

      ws.on('open', () => done({ ok: true }))
      ws.on('error', (error) => done({ ok: false, status: 0, body: error.message }))
      ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += String(chunk)
        })
        res.on('end', () => done({ ok: false, status: res.statusCode ?? 0, body }))
        // 有些实现不回 body
        setTimeout(() => done({ ok: false, status: res.statusCode ?? 0, body }), 200)
      })
    })

    if (!outcome.ok) {
      try {
        ws.terminate()
      } catch {
        /* 已经关了 */
      }
      return outcome
    }
    return { ok: true, peer: new FakeOneBot(ws) }
  }

  /** 推一个事件给服务端。 */
  push(event: unknown): void {
    this.ws.send(JSON.stringify(event))
  }

  /** 推一个不具备 `post_type`/`status` 的帧（测 unknown 分支）。 */
  pushRaw(payload: string): void {
    this.ws.send(payload)
  }

  /** 等一个特定 action 的 API 调用到达。 */
  waitForCall(action: string, timeoutMs = DEFAULT_TIMEOUT): Promise<ApiCall> {
    const existing = this.calls.find((c) => c.action === action)
    if (existing) return Promise.resolve(existing)

    return new Promise<ApiCall>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === wrapped)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error(`等 ${action} 的 API 调用超时（${timeoutMs}ms）；已收到：[${this.calls.map((c) => c.action).join(', ')}]`))
      }, timeoutMs)

      const wrapped = (call: ApiCall): void => {
        clearTimeout(timer)
        resolve(call)
      }
      this.waiters.push({ action, resolve: wrapped })
    })
  }

  /** 关闭连接。 */
  close(): void {
    try {
      this.ws.close()
    } catch {
      /* 忽略 */
    }
  }

  /** 强制断开（模拟网线被拔，用来测服务端的清理路径）。 */
  terminate(): void {
    try {
      this.ws.terminate()
    } catch {
      /* 忽略 */
    }
  }

  /** 等待本端 socket 关闭。 */
  waitClosed(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等连接关闭超时')), timeoutMs)
      this.ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

/** 造一个规范的群消息事件。 */
export function groupMessageEvent(
  selfId: string,
  options: { groupId?: string; userId?: string; message?: unknown; rawMessage?: string; messageId?: number } = {},
): Record<string, unknown> {
  const message = options.message ?? '你好'
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: Number(selfId),
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: options.messageId ?? 1001,
    group_id: Number(options.groupId ?? '123456'),
    user_id: Number(options.userId ?? '1000000001'),
    message,
    raw_message: options.rawMessage ?? (typeof message === 'string' ? message : ''),
    font: 0,
    sender: { user_id: Number(options.userId ?? '1000000001'), nickname: 'owner', role: 'owner' },
  }
}
