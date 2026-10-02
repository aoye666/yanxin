/**
 * 研心 (YanXin) bundle 的根插件。
 *
 * **当前是占位。** 我们目前唯一的插件 `url-guard` 由 `cordis.patch.yml`
 * 按子路径（`yanxin/src/net/url-guard.ts`）单独插入，不经过这里。
 *
 * 本入口的用途是承载 **root 级共享服务** —— 按 spec §6.1 的分层，这些必须在
 * root 挂载、被所有 preset 共享（而不是写进某个 preset）：
 *   - `memory`  MemoryService（两模式共享同一套长期记忆，§6.9）
 *   - `persona` 人格基底（两模式共享同一份人格，§6.4）
 *   - `window`  窗口调度（必须 root 级常驻，否则世界被禁用时调度器自己也停了，§6.6）
 *
 * 服务就位后，patch 里加一行 `- id: yanxin  name: 'yanxin'` 即可整组挂载。
 *
 * ⚠️ 装配纪律（ADR 0004）：本模块只用命名导出，**不用 `export default`** ——
 *    两者混用会让 `default` 导出优先，从而静默丢弃 `inject` / `Config`。
 */

export const name = 'yanxin'

/**
 * 根插件暂不依赖任何服务。服务就位后会变成如
 * `['timer', 'settings']` 这样的列表。
 */
export const inject: readonly string[] = []

/**
 * 有意为空实现：本入口的存在意义是让 `yanxin` 这个包名解析到主模块，
 * 并为 root 级共享服务预留位置。不抛错是为了让 patch 可以先挂上它
 * 而不影响装配（spec §7.3 的反例清单里就有"注册了却不返回反注册闭包"，
 * 空实现比假实现安全）。
 */
export function apply(): void {
  // 未来：ctx.set('persona', ...) / ctx.set('memory', ...) / 窗口服务的挂载点
}
