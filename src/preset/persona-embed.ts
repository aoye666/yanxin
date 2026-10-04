/**
 * 把人格文本**嵌进已安装的 preset**（`$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`）。
 *
 * ## 为什么是"改一行"而不是"重新生成整个文件"
 *
 * 一个 preset 的 yml 里有两类东西：
 *   · **结构**（工具行、SSRF 守卫行、那些"为什么必须这样写"的注释块）—— 由包内的
 *     `scripts/build-presets.mjs` 拥有，控制台**不该知道**它们
 *   · **人格段**（`id: persona` 那行的 `config.prefix`）—— 运营者的东西，控制台要能改
 *
 * 整份重生成会把结构的所有权抢过来（两份生成器必然漂移），所以这里只替换那一行。
 *
 * ## 用的是 Document API，不是 `parse` + `stringify`
 *
 * `parse()` 出来的普通对象再 `stringify()` 会把**注释全丢掉** —— 而这份文件里最值钱的
 * 恰恰是注释（"provider 放 host 平面"、"第二个 preset 会撞服务名"这类实测教训）。
 * `parseDocument()` 保留注释与节点风格，改完 `toString()` 只动被碰过的那一段。
 *
 * ## 失败一律抛，且**不动盘**
 *
 * 写坏一个 preset 的代价是**她所有会话挂载失败**（比"人格没改上"严重一个量级）。
 * 所以解析报错、找不到 persona 行、结构不是预期形态 —— 都抛，调用方因此**不会写文件**。
 */
import { isMap, isSeq, parseDocument, Scalar, type Document } from 'yaml'

/** persona 行的身份（两种写法都认，见 {@link personaIndexOf}）。 */
const PERSONA_ROW_ID = 'persona'
const PERSONA_ROW_NAME = '@deepseek-ai/dsh-persona'

/**
 * 人格文本所在的 config 键。
 *
 * ⚠️ 发布版 `@deepseek-ai/dsh-persona` 的 Config 是 `{prefix 必填, suffix, complete,
 * includeRuntimeContext}` —— 写成 `text` 会让三个 preset 全部挂载失败（人格整段丢弃，
 * 她完全不回话）。`scripts/build-presets.mjs` 的 `personaRow` 必须用同一个键名，
 * 两边不一致时 `persona-write.spec.ts` 的往返用例会红（读不到就抛）。
 */
export const PERSONA_TEXT_KEY = 'prefix'

/** 嵌入失败的原因（调用方把它直接显示出去，不要再包一层"未知错误"）。 */
export class PersonaEmbedError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super(detail)
    this.detail = detail
    this.name = 'PersonaEmbedError'
  }
}

/**
 * 替换 persona 行的人格文本（键名见 {@link PERSONA_TEXT_KEY}），返回新的整份文件。
 *
 * 块标量用 `|-`（literal + strip）—— 与 `scripts/build-presets.mjs` 生成的形态一致，
 * 这样"脚本生成的"与"控制台改过的"两份文件在 DSH 眼里没有区别。
 */
export function embedPersonaText(yml: string, text: string): string {
  const doc = parse(yml)
  const index = personaIndexOf(doc)
  const scalar = new Scalar(text.trim())
  scalar.type = Scalar.BLOCK_LITERAL
  // `|-` 还是 `|` 由**值末尾有没有换行**决定（yaml 的 stringifier 自己判），
  // 而 `composePersona` 交来的文本我们已经 trim 过 —— 于是产物与生成脚本写的一致是 `|-`。
  doc.setIn([index, 'config', PERSONA_TEXT_KEY], scalar)
  return doc.toString()
}

/**
 * 读出已嵌入的人格段。
 *
 * `world-step` 的同源判据要用它 —— 判"她的 preset 与人格源是否一致"必须比着**真正被装载的那份**，
 * 比包内的副本没有意义（装机后包内副本根本不会被 DSH 读到）。
 */
export function readEmbeddedPersona(yml: string): string {
  const doc = parse(yml)
  const index = personaIndexOf(doc)
  const value = doc.getIn([index, 'config', PERSONA_TEXT_KEY])
  if (typeof value !== 'string') {
    throw new PersonaEmbedError(
      `persona 行里没有字符串形态的 config.${PERSONA_TEXT_KEY} —— 这份 preset 不是本仓的产物`,
    )
  }
  return value
}

/** 解析并挡住"文件本身就是坏的"（这里的坏 = 我们连读都读不准，绝不能往下写）。 */
function parse(yml: string): Document {
  const doc = parseDocument(yml, { prettyErrors: true })
  if (doc.errors.length > 0) {
    throw new PersonaEmbedError(`preset 文件本身就不是合法 YAML：${doc.errors[0]?.message ?? '（解析器没给原因）'}`)
  }
  return doc as Document
}

/**
 * persona 行在下标几？
 *
 * 认 `id: persona` **或** `name: '@deepseek-ai/dsh-persona'` —— 前者是我们写的行名，
 * 后者才是 DSH 真正用来装载插件的东西。只认其中一个的话，改名那天会静默找不到行。
 */
function personaIndexOf(doc: Document): number {
  const contents = doc.contents
  if (!isSeq(contents)) throw new PersonaEmbedError('preset 文件的顶层不是列表 —— 形态和预期不符')
  const found = contents.items.findIndex(
    (item) => isMap(item) && (item.get('id') === PERSONA_ROW_ID || item.get('name') === PERSONA_ROW_NAME),
  )
  if (found < 0) {
    throw new PersonaEmbedError(
      `这份 preset 里没有 persona 行（${PERSONA_ROW_ID} / ${PERSONA_ROW_NAME} 都没出现）`,
    )
  }
  return found
}
