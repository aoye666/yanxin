/**
 * 控制台的**接口层**（T31）—— 请求进、JSON 出。
 *
 * 这个文件里**没有 HTML**：它只处理 `/yanxin/api/*`（读接口与写接口），
 * 响应一律 JSON（`JSON.stringify`，结构上不可能变成标记）。
 * 外壳与客户端脚本在 `client.ts`（那边只有常量写出）。
 *
 * 分家的理由不是洁癖：控制台要把**不可信数据**（QQ 昵称、群消息、日志行）交给浏览器显示，
 * 而"这些数据在哪条路上出去"必须一眼可查 —— 这里的答案是"只会作为 JSON 值出去"，
 * 浏览器端用 `textContent` 渲染（见 `logic.ts` 的客户端渲染器）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { redactValue } from '../audit/redact.ts'
import type { Block } from './logic.ts'
import type { ConsoleApi, ConsolePage, PageInput } from './registry.ts'

/**
 * 写一条 JSON 响应（本文件**唯一**的响应出口）。
 *
 * ⚠️ 出口处过一遍**密钥脱敏**（spec §7.4-D：控制台响应不得包含密钥）。
 * 与 XSS 那条同一个取向：不靠"每个页的作者记得别回显密钥"，而是在唯一出口上机械保证。
 * 代价是"页面若真要显示一个形如 `token=…` 的值也会被抹掉" —— 这是**有意**的取舍：
 * 本控制台没有任何一处需要明示密钥。
 */
export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  // ⚠️ 先构体、后写头：stringify（含脱敏递归）若对某个值抛了，头还没发 ——
  // 外层 catch 还能干净地回一条 500。反过来（先 writeHead 再 stringify）一旦
  // 抛错，第二次 sendJson 会撞 ERR_HTTP_HEADERS_SENT。
  const body = JSON.stringify(redactValue(value) ?? null)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 一页的内容（标题 + 区块 + 导航用的页列表）—— 外壳据此渲染。 */
export async function pagePayload(input: {
  slug: string
  query: URLSearchParams
  base: string
  pages: readonly ConsolePage[]
  indexBlocks: readonly Block[]
}): Promise<unknown> {
  const pages = input.pages.map((page) => ({ slug: page.slug, title: page.title }))

  // `base` 一并给客户端：它是服务端的真相（客户端脚本只用它推导首屏那一次）
  if (input.slug === '/') {
    return { ok: true, data: { base: input.base, title: '研心控制台', pages, blocks: input.indexBlocks } }
  }

  const page = input.pages.find((entry) => `/${entry.slug}` === input.slug)
  if (page === undefined) {
    return { ok: false, error: `没有这一页：${input.slug}`, data: { title: '没有这一页', pages, blocks: [] } }
  }

  const request: PageInput = { query: input.query, base: input.base }
  return {
    ok: true,
    data: { base: input.base, title: page.title, pages, blocks: await page.render(request) },
  }
}

/** 找一个接口（方法与路径都要对上）。 */
export function findApi(apis: readonly ConsoleApi[], route: string, method: string): ConsoleApi | undefined {
  return apis.find((candidate) => candidate.route === route && candidate.method === method)
}

/** 读请求体（限长；坏 JSON 当 `undefined` —— 由接口自己判"没给参数"）。 */
export async function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limitBytes) throw new Error('请求体太大')
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return undefined
  }
}