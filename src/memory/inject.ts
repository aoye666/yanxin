/**
 * 召回结果**注入对话上下文**的纯逻辑（T16）。
 *
 * 这里只有两个纯函数（无 IO、无状态），因为"怎么把记忆说给模型听"是一个**措辞问题**，
 * 而措辞错了会以最难查的方式出错 —— 小研会开始**元叙述**记忆机制
 * （"我查到记忆里说…"、"根据我的记忆库…"），而它的人格里明确写着
 * "**禁止系统级描述**：不谈「记忆加载」「系统更新」这类概念，始终以小研本人的视角说话"。
 *
 * ## 三条设计约束
 *
 * 1. **召回为空 → 原样返回，一个字节都不加**（spec §8 T16 的"逐字节一致"）。
 *    绝不能让"没有找到相关记忆"这类噪声进 prompt —— 那既浪费 token，
 *    又是在教模型"你有记忆机制"这件事。
 * 2. **措辞用第一人称、像"想起来了"**，不用"检索/匹配/知识库"这类工程词。
 * 3. **压成单行**：记忆内容是 markdown（可能带标题、列表、多段），直接嵌进消息体
 *    会让模型把它当成"用户写了这些东西"，压平之后才像"背景"。
 */
import type { MemoryHit } from './service.ts'

/**
 * 把召回结果渲染成给模型看的背景片段。
 *
 * @returns 空串（`hits` 为空）或一段以换行结尾的文本 —— **空串是"什么都没加"的信号**，
 *   调用方据此保持原消息不变。
 */
export function renderMemories(hits: readonly MemoryHit[]): string {
  const lines = hits
    .map((hit) => ({ label: describeSource(hit.sessionId), content: flatten(hit.content) }))
    .filter((entry) => entry.content !== '')
    .map((entry) => `- ${entry.label}${entry.content}`)

  if (lines.length === 0) return ''
  return `（你记得这些：\n${lines.join('\n')}\n）`
}

/**
 * 把 `sessionId` 翻译成人话来源标签。
 *
 * ⚠️ **绝不让模型看到 `agent:3000000001:group:3000000003` 这种工程格式** ——
 * 那既没有信息量（模型不需要知道我们的命名规则），又会诱发元叙述。
 * 认不出的形态就**不标**（宁可少一个标签，也不泄漏内部格式）。
 *
 * 解析的是 `session-trigger.ts` 的 `sessionIdFor` 定下的形态；这里只做**只读翻译**，
 * 不反向构造 id —— 方向是 memory → onebot 会引入不该有的耦合，所以这份映射刻意留在此处。
 */
function describeSource(sessionId: string | undefined): string {
  if (sessionId === undefined) return ''
  const parts = sessionId.split(':')
  const [mode, , channel, channelId] = parts

  if (mode === 'agent' && channel === 'group') return channelId === undefined ? '' : `[群 ${channelId}] `
  if (mode === 'agent' && channel === 'private') return '[私聊] '
  if (mode === 'admin') return channel === 'group' ? `[管理员群聊 ${channelId ?? ''}] ` : '[管理员私聊] '
  if (mode === 'world') return '[世界] '
  return ''
}

/**
 * 把背景片段拼到入站消息前面。
 *
 * ⚠️ `memories` 为空串时**原样返回 `text`** —— 这是"召回为空时 prompt 与无记忆时
 * 逐字节一致"那条验收的实现点。
 */
export function withMemories(text: string, memories: string): string {
  return memories === '' ? text : `${memories}\n\n${text}`
}

/**
 * 把一段记忆压成一行。
 *
 * markdown 标题符号、列表符号、多余空白都去掉 —— 我们要的是"内容"，
 * 不是一份要渲染的文档。超长时截断（记忆条目本身不该是长文）。
 */
function flatten(content: string): string {
  const oneLine = content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[-*+]\s+/, '').trim())
    .filter((line) => line !== '')
    .join(' ')

  return oneLine.length > MAX_HIT_CHARS ? `${oneLine.slice(0, MAX_HIT_CHARS - 1)}…` : oneLine
}

/**
 * 单条记忆压平后的上限。
 *
 * 定这个数是为了"一条记忆不该吃掉整个上下文"：召回 limit 默认 5，
 * 5 × 300 = 1500 字符，与人格 prompt（约 2.5k）同量级，可接受。
 */
const MAX_HIT_CHARS = 300
