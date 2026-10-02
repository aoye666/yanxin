/**
 * 跨版本读取 session 的事件日志。
 *
 * ## 为什么需要这一层
 *
 * **类型来源与运行时来源是两份不同的 dsh-session。**（ADR 0011）
 *
 * | 来源 | 版本线 | 事件读取 API |
 * |---|---|---|
 * | 运行时：DSH monorepo 的 `packages/core/session` | `0.1.0-rc.x` | `get events()` |
 * | 类型：npm 的 `@deepseek-ai/dsh-session`（本仓 devDependency） | `0.1.5-rc.x` | `snapshotEvents(from, to)` |
 *
 * 从 monorepo 启动 CLI 时（`node --import tsx/esm apps/cli/src/bin.ts --profile …`），
 * profile 的 bundle `@deepseek-ai/dsh-base` 解析到 monorepo 的 `packages/<包>/lib`，
 * 于是 `agent.session` 是 **monorepo 形态**；而本仓 `tsc` 读的是 npm 形态的 `.d.ts`。
 * 两条版本线的这套 API **互斥**：谁都没有对方那个成员 —— 所以类型检查能过而运行时报
 * `snapshotEvents is not a function`。
 *
 * 上游 `packages/bundle/headless/src/index.ts` 用 `agent.session.events`，正因为它
 * 也在 monorepo 里跑（同源）。本仓做不到同源（见 ADR 0011 的取舍记录），于是显式适配。
 *
 * ## 语义等价
 *
 * `events` 是**全量快照**（含 fork 继承的前缀），`snapshotEvents(from)` 是**半开区间**。
 * 调用方 `extractAssistantTurn(events, firstSeq)` 自带 `seq < firstSeq` 过滤，
 * 所以两条路径喂进去结果一致 —— 差别只是 `events` 会多扫一遍前缀事件。
 *
 * ## fail-loud
 *
 * 两者都不存在时**抛错**，而不是返回空数组。返回空数组会让 bridge 把一次 API 漂移
 * 伪装成"模型这轮没说话"，日志上只剩一条温和的 warn —— ADR 0010 记过这类静默失败
 * 有多难查。
 */

/** 只读事件源的**结构化最小接口**：两种形态的公共面。 */
export interface SessionEventSource {
  /** monorepo 形态：全量事件快照（含 fork 继承前缀）。 */
  readonly events?: readonly unknown[]
  /** npm 形态：`[fromSeq, toSeqExclusive)` 半开区间快照。 */
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly unknown[]
}

/**
 * 读取 `fromSeq` 起（含）的事件。
 *
 * 优先 `snapshotEvents`（拿到更窄的区间），回退 `events`（全量，由调用方过滤）。
 *
 * @param session - agent 的 session（任一形态）。
 * @param fromSeq - 起始 seq（含）；`events` 路径下仅作为语义约定，过滤由调用方做。
 * @returns 事件数组，可能含 `fromSeq` 之前的事件（`events` 路径）。
 * @throws 两种形态都不匹配时 —— 说明 dsh-session 的 API 又变了。
 */
export function readSessionEvents(session: SessionEventSource, fromSeq: number): readonly unknown[] {
  const { snapshotEvents } = session
  // `call(session, …)` 而不是 `snapshotEvents(fromSeq)`：服务/代理场景下方法的 receiver
  // 必须仍是 session 本身（ADR 0007 记过 receiver 被换掉导致的私有字段故障）。
  if (typeof snapshotEvents === 'function') return snapshotEvents.call(session, fromSeq)

  if (Array.isArray(session.events)) return session.events

  throw new Error(
    `session 既没有 snapshotEvents() 也没有 events —— dsh-session 的形态又变了（ADR 0011）。实际 prototype：${describeShape(session)}`,
  )
}

/** 安全地列出对象 prototype 上的成员名，用于把"形态变了"这件事写进错误信息。 */
function describeShape(value: object): string {
  try {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype === null || typeof prototype !== 'object') return '(没有 prototype)'
    const names = Object.getOwnPropertyNames(prototype)
    return names.length > 0 ? names.join(', ') : '(prototype 上没有自有成员)'
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `(读取形态时又抛了错：${reason})`
  }
}
