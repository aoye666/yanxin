/**
 * 假的 ReMe HTTP server —— 测试用的可编程后端。
 *
 * 为什么需要它：真实 ReMe 不会常驻在开发机/CI 上，而**协议契约必须可回归**。
 * 把 server 握在自己手里，才能既断言"我们发出去的请求形状"，又断言"各种响应形状
 * 解析成什么"——这两件事在真实后端上是看不见的。
 *
 * ⚠️ 只监听 `127.0.0.1` 的**临时端口**（`listen(0)`）：与 `assertLoopbackEndpoint`
 * 的纪律一致，也绝不碰真实 ReMe（默认 2333）。
 */
import { createServer, type Server } from 'node:http'

/** 假 ReMe 收到的请求。 */
export interface ReceivedRequest {
  job: string
  body: Record<string, unknown>
}

export interface FakeReme {
  /** `http://127.0.0.1:<临时端口>` */
  endpoint: string
  /** 收到的请求，按到达顺序。 */
  requests: ReceivedRequest[]
  stop(): Promise<void>
}

/**
 * 起一个假 ReMe。
 *
 * @param reply - 按 job 决定回什么（返回值会被 JSON 序列化）。可以是 `{ success, answer, metadata }`
 *   的任意组合 —— 测试就是靠它来构造"正常 / success:false / 畸形"这些情形。
 */
export async function startFakeReme(
  reply: (job: string, body: Record<string, unknown>) => unknown | Promise<unknown>,
): Promise<FakeReme> {
  const requests: ReceivedRequest[] = []

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      void (async () => {
        const job = (req.url ?? '/').replace(/^\/+/, '')
        const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
        requests.push({ job, body })

        const answer = await reply(job, body)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(answer))
      })()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { ...locate(server), requests, stop: () => close(server) }
}

/**
 * 起一个**永不回应**的 server —— 用来测超时。
 *
 * 刻意不调用 `res.end()`：客户端只能靠自己的超时脱身，与"后端卡住"的真实情形一致。
 */
export async function startBlackHole(): Promise<FakeReme> {
  const server = createServer(() => {
    // 故意什么都不做
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { ...locate(server), requests: [], stop: () => close(server, true) }
}

/** 总回指定状态码的 server —— 用来测 HTTP 层的失败路径。 */
export async function startFailingReme(status: number): Promise<FakeReme> {
  const server = createServer((_req, res) => {
    res.statusCode = status
    res.end('boom')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { ...locate(server), requests: [], stop: () => close(server) }
}

/** 正常回应的便捷工厂。 */
export const okReply =
  (answer: unknown) =>
  (): { success: boolean; answer: unknown } => ({ success: true, answer })

function locate(server: Server): { endpoint: string } {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { endpoint: `http://127.0.0.1:${port}` }
}

function close(server: Server, force = false): Promise<void> {
  return new Promise<void>((resolve) => {
    if (force) server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })
}
