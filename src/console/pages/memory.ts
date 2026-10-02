/**
 * 记忆页（T33）—— 检索她的长期记忆，并**把溯源显示出来**。
 *
 * ## 检索为什么要 token（这一页不是只读就能随便看）
 *
 * 记忆里是她全部的对话痕迹（含私聊）。控制台的三道门里，写操作强制 token、
 * 读操作默认放行；而"检索记忆"这条读**故意走 POST**（`/api/memory/search`），
 * 于是它落在"要 token"的那一侧。这是**取舍**而不是疏漏：内容敏感，宁可贵一点。
 *
 * ## 溯源字段的限度
 *
 * `MemoryHit.sessionId` 与 `source` / `lines` 是**记录**（这条记忆从哪来），不是授权依据
 * （spec §6.5/§6.10：能力边界只由 preset 决定）。页面上照实显示，不据此做任何判定。
 *
 * ## 后端挂了会怎样
 *
 * 记忆是增强不是依赖：`health()` 说不可用时，页面上如实显示原因，检索返回空并由
 * `MemoryService` 那层降级（T13 的 19 条用例覆盖）。这一页不自己重试、不自己兜底。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Block } from '../logic.ts'
import { brief, missingService } from './support.ts'

/** 装配纪律（ADR 0004）：命名导出 + `inject`，**不写 default**。 */
export const name = 'yanxin-console-memory-page'
export const inject = ['console']

/** 一条召回结果在本页用到的最小面（`src/memory/service.ts` 的 `MemoryHit`）。 */
export interface HitLike {
  content: string
  source: string
  lines?: readonly [number, number]
  links?: readonly string[]
  score?: number
  sessionId?: string
}

/** 记忆服务在本页用到的最小面。 */
interface MemoryLike {
  readonly providerId?: string
  health(): Promise<{ ok: boolean; detail?: string }>
  search(query: string, options?: { limit?: number }): Promise<readonly HitLike[]>
}

/** 页面的区块（纯函数）。 */
export function renderMemoryBlocks(
  state: {
    providerId?: string
    health: { ok: boolean; detail?: string }
    query?: string
    hits?: readonly HitLike[]
  },
  base: string,
): readonly Block[] {
  const blocks: Block[] = []

  blocks.push(
    state.health.ok
      ? { kind: 'p', text: `后端：${state.providerId ?? '（未配置 provider）'}，可用。` }
      : {
          kind: 'notice',
          tone: 'warn',
          text: `后端不可用：${state.health.detail ?? '（没给原因）'} —— 记忆是增强不是依赖：她照常回话，只是召回为空。`,
        },
  )

  blocks.push({
    kind: 'form',
    action: `${base}/api/memory/search`,
    submit: '检索',
    fields: [
      {
        name: 'query',
        label: '检索词',
        value: state.query ?? '',
        hint: '按语义检索；结果里的"来源/行/会话"就是溯源',
      },
    ],
  })

  if (state.query === undefined || state.query === '') {
    blocks.push({ kind: 'p', text: '填一个词再点检索 —— 这一页不发空查询（空查询在后端那里没有意义）。' })
    return blocks
  }

  const hits = state.hits ?? []
  blocks.push({
    kind: 'table',
    caption: `「${state.query}」的结果（${hits.length} 条）`,
    head: ['记忆', '来源', '行', '会话（溯源）', '分'],
    rows:
      hits.length === 0
        ? [['（没有命中）', '—', '—', '—', '—']]
        : hits.map((hit) => [
            brief(hit.content, 200),
            brief(hit.source, 80),
            hit.lines === undefined ? '—' : `${hit.lines[0]}–${hit.lines[1]}`,
            hit.sessionId ?? '—',
            hit.score === undefined ? '—' : `${hit.score}`,
          ]),
  })
  const linked = hits.filter((hit) => (hit.links?.length ?? 0) > 0)
  if (linked.length > 0) {
    blocks.push({
      kind: 'ul',
      items: linked.map((hit) => `${brief(hit.source, 60)} → 关联：${(hit.links ?? []).join('、')}`),
    })
  }
  blocks.push({
    kind: 'p',
    text: '溯源只说明"这条记忆从哪来"，不参与任何权限判定（能力边界由 preset 决定）。',
  })
  return blocks
}

/** 装页与接口。 */
export function apply(ctx: Context): void {
  ctx.console.page({
    slug: 'memory',
    title: '记忆',
    async render({ base, query }) {
      const memory = ctx.get('memory') as MemoryLike | undefined
      if (memory === undefined) return missingService('记忆')

      const health = await memory.health().catch((error: unknown) => ({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      }))
      // 首次进页面只显示健康状态：检索走 POST（见文件头，读记忆也要 token）
      void query
      return renderMemoryBlocks({ providerId: memory.providerId, health }, base)
    },
  })

  ctx.console.api({
    route: 'memory/search',
    method: 'POST',
    async handler({ body, base }) {
      const memory = ctx.get('memory') as MemoryLike | undefined
      if (memory === undefined) return { error: '记忆服务不在（`memory` 行没装载）' }

      const query = (body as { query?: unknown } | undefined)?.query
      const text = typeof query === 'string' ? query.trim() : ''
      if (text === '') return { error: '没给检索词' }

      const health = await memory.health().catch((error: unknown) => ({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      }))
      try {
        const hits = await memory.search(text, { limit: 10 })
        return {
          detail: `「${text}」命中 ${hits.length} 条`,
          // 区块随响应回给浏览器端渲染（客户端会把它追加在页尾）——
          // 于是"检索"不必让页面重新拉一遍（也就不必把查询塞进 URL）
          blocks: renderMemoryBlocks({ providerId: memory.providerId, health, query: text, hits }, base),
        }
      } catch (error) {
        return { error: `检索失败：${brief(error instanceof Error ? error.message : error, 200)}` }
      }
    },
  })
}