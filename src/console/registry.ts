/**
 * 控制台的**注册表与审计**（T31）—— 从服务里抽出来的小件。
 *
 * 两件事各占一小块，且都与 HTTP 无关：
 *   · **注册表**：页与接口的清单（登记绑调用方 fiber —— 注册它的插件卸载时自动摘掉）
 *   · **审计**：写操作留痕（与 `url-guard` 同一套目录惯例）
 *
 * 抽出来的理由是纯粹的：让 `index.ts` 只讲"路由与三道门"，读起来一条线。
 */
import type { Context } from '@deepseek-ai/cordis'
import { writeAudit } from '../audit/log.ts'
import type { Block } from './logic.ts'

/** 一个页（`GET <path>/<slug>`）。 */
export interface ConsolePage {
  /** URL 片段（`setup`、`world`…）。 */
  slug: string
  /** 页面标题（浏览器端渲染成 `textContent`，不解析标记）。 */
  title: string
  /** 页的内容：返回**区块**（数据，不是 HTML）。 */
  render: (input: PageInput) => Promise<readonly Block[]> | readonly Block[]
}

export interface PageInput {
  /** 查询参数。 */
  query: URLSearchParams
  /** 控制台路径（页内链接与表单 action 用，免得各页硬编码 `/yanxin`）。 */
  base: string
}

/** 一个接口（`<path>/api/<route>`）。 */
export interface ConsoleApi {
  /** 片段（`setup/run` 之类；写接口用 POST）。 */
  route: string
  method: 'GET' | 'POST'
  /**
   * 处理：拿到解析好的 JSON 体与查询，返回可序列化的结果。
   *
   * `base` 是**控制台自己的挂载路径** —— 接口在返回值里拼链接/表单 action 时要用它，
   * 而不是硬编码 `/yanxin`（挂载点可配，硬编码会在换路径时静默拼错）。
   */
  handler: (input: { body: unknown; query: URLSearchParams; base: string }) => Promise<unknown>
}

export interface Registry {
  readonly pages: ConsolePage[]
  readonly apis: ConsoleApi[]
}

/**
 * 登记一个页/接口。
 *
 * ⚠️ 内部包 `ctx.effect`：**登记绑在调用方 fiber 上** —— 注册它的插件卸载时自动摘掉。
 * 调用方不必自己写清理（漏写的代价是"卸了还在"，而那很难查）。
 */
export function registerPage(ctx: Context, registry: Registry, entry: ConsolePage): void {
  ctx.effect(() => {
    registry.pages.push(entry)
    return () => {
      const index = registry.pages.indexOf(entry)
      if (index >= 0) registry.pages.splice(index, 1)
    }
  }, `yanxin-console.page.${entry.slug}`)
}

export function registerApi(ctx: Context, registry: Registry, entry: ConsoleApi): void {
  ctx.effect(() => {
    registry.apis.push(entry)
    return () => {
      const index = registry.apis.indexOf(entry)
      if (index >= 0) registry.apis.splice(index, 1)
    }
  }, `yanxin-console.api.${entry.route}`)
}

/**
 * 写操作留痕（含被拒的）。
 *
 * ⚠️ 落盘走 `src/audit/log.ts`（**唯一出口**）：路径求值、密钥脱敏、"永不抛"三件事
 * 都在那边兑现 —— 控制台只负责把"谁在对哪个路径做了什么"交给它。
 */
export async function auditWrite(
  ctx: Context,
  record: { path: string; method: string; ok: boolean; reason?: string },
): Promise<void> {
  ctx.emit('yanxin/console-write', record)
  await writeAudit('console', record)
}