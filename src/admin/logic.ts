/**
 * 管理员判定的纯逻辑。
 *
 * 单独成文件有两个原因：
 *   1. 这些规则需要**表驱动单测**，而单测不该被迫搭一个真实的 Cordis Context；
 *   2. 装配纪律（ADR 0004）：插件模块要么只用命名导出、要么只 `export default`。
 *      纯函数放这里，插件那边就能保持"只 export default 一个类"，两边都不混。
 */

/**
 * 名单条目的规范化：非字符串、空串、全空白一律视为无效。
 *
 * 刻意**不**假设 QQ 号是纯数字 —— 这条逻辑的职责是"这一项能不能当 id 用"，
 * 而不是"它是不是合法 QQ 号"。后者属于渠道适配层（OneBot 传来的 sender_id）。
 */
export function normalizeAdminId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const id = raw.trim()
  return id.length > 0 ? id : undefined
}

/**
 * 身份判定。**fail-closed**，三条规则：
 *
 *   - `senderId` 非字符串 / 空串 / 全空白 → false
 *   - **名单为空 → 一律 false**（宁可不认，也不可错认；这是 spec §6.10 的门控前提）
 *   - 精确匹配，**不做前缀或包含**（否则 "123" 会命中 "1234"）
 */
export function isAdminIn(admins: readonly string[], senderId: unknown): boolean {
  const id = normalizeAdminId(senderId)
  if (id === undefined) return false
  if (admins.length === 0) return false
  return admins.includes(id)
}

/**
 * 名单的规范化：逐条 trim、丢弃无效项、去重。
 *
 * **为什么需要它**：`isAdminIn` 是一个"输入已规范化"的精确匹配谓词，它只规范化
 * 查询方。如果名单本身带空白（手改 `settings.yaml` 时多打一个空格），
 * 精确匹配就会失配 —— 方向是安全的（fail-closed，不会误放行），
 * 但**会让一个管理员静默失效**，这才是真正的问题。
 *
 * 所以规范化放在**边界**：服务读名单时过一遍这里。纯函数保持简单。
 */
export function normalizeAdminList(raw: readonly unknown[]): string[] {
  const out: string[] = []
  for (const item of raw) {
    const id = normalizeAdminId(item)
    if (id !== undefined && !out.includes(id)) out.push(id)
  }
  return out
}

/** 追加（去重、保持原有顺序）。返回新数组，不改入参。 */
export function withAdmin(admins: readonly string[], raw: unknown): string[] {
  const id = normalizeAdminId(raw)
  if (id === undefined || admins.includes(id)) return [...admins]
  return [...admins, id]
}

/** 移除。返回新数组，不改入参。 */
export function withoutAdmin(admins: readonly string[], raw: unknown): string[] {
  const id = normalizeAdminId(raw)
  if (id === undefined) return [...admins]
  return admins.filter((a) => a !== id)
}
