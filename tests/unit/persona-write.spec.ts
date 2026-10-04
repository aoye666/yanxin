/**
 * 人格写路径的验收（S2，spec §6.4 的"单一来源"那条）。
 *
 * 盯三件事：
 *   1. **拼装规则只有一份** —— `composePersona` 的形态必须与 `build-presets.mjs` 产物一致，
 *      否则控制台嵌进去的与她说话用的就不是同一段文本
 *   2. **嵌入只动 persona 那一行** —— preset 的结构行与注释是实测教训所在，
 *      丢了它们比丢一次人格更贵（所以断言用解析后比对，不做字符串包含）
 *   3. **坏输入不动盘** —— 认不出的形态一律抛，因为写坏 preset 的代价是**所有会话挂载失败**
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { embedPersonaText, PERSONA_TEXT_KEY, PersonaEmbedError, readEmbeddedPersona } from '../../src/preset/persona-embed.ts'
import {
  composePersona,
  isPersonaDraftTemplate,
  MODE_BY_PRESET_ID,
  PERSONA_IDS,
  PERSONA_SOURCE_NAMES,
  PRESET_MODES,
  WORLD_STANCE,
} from '../../src/preset/render.ts'

const ROOT = join(import.meta.dirname, '../..')
const SOURCES = { base: '基底第一句\n基底第二句', profile: '背景：她是小研', world: '世界：一间小房子' }

/** 包内真实产物（三个 preset 的 yml 都在版本库里，拿来当被改的对象最诚实）。 */
function packagedPreset(id: string): string {
  return readFileSync(join(ROOT, 'presets', id, 'agent.cordis.yml'), 'utf8')
}

describe('人格拼装（单一来源）', () => {
  it('agent 与 admin **文本完全相同** —— 分叉只在工具面', () => {
    expect(composePersona('admin', SOURCES)).toBe(composePersona('agent', SOURCES))
  })

  it('世界模式在基底+背景之后追加姿态说明与世界定义', () => {
    const text = composePersona('world', SOURCES)
    expect(text.startsWith(composePersona('agent', SOURCES))).toBe(true)
    expect(text).toContain(WORLD_STANCE.trim())
    expect(text.endsWith(SOURCES.world)).toBe(true)
  })

  it('三段各自 trim 后再用空行相接（与 build-presets.mjs 的读法一致）', () => {
    const text = composePersona('agent', { base: '  A\n', profile: '\nB  ', world: 'C' })
    expect(text).toBe('A\n\nB')
  })

  it('⭐ 包内三个 preset 里嵌的文本，就是用本函数从包内 persona/ 拼出来的那一段', () => {
    // 这条是"两份规则会漂移"的正解：不是约定，是断言。
    // 谁改了 build-presets.mjs 的拼装或改了 persona/ 忘了重跑，这里就红。
    const packaged = {
      base: readFileSync(join(ROOT, 'persona', 'base.md'), 'utf8').trim(),
      profile: readFileSync(join(ROOT, 'persona', 'profile.md'), 'utf8').trim(),
      world: readFileSync(join(ROOT, 'persona', 'world.md'), 'utf8').trim(),
    }
    for (const mode of PRESET_MODES) {
      const yml = packagedPreset(PERSONA_IDS[mode])
      expect(readEmbeddedPersona(yml).trim(), `${PERSONA_IDS[mode]} 的人格段`).toBe(
        composePersona(mode, packaged).trim(),
      )
    }
  })

  it('preset id 表与模式表一一对应（新增模式忘了登记就会在这里红）', () => {
    expect([...MODE_BY_PRESET_ID.keys()].sort()).toEqual(Object.values(PERSONA_IDS).sort())
    expect(Object.values(PERSONA_SOURCE_NAMES).sort()).toEqual(['base.md', 'profile.md', 'world.md'])
  })
})

describe('出厂空模板的判据（新用户的坑）', () => {
  it('带 `> TODO` 的模板算**没写过**，哪怕它有几百个字符', () => {
    const template = '# 小研 · 人格基底（base）\n\n## 你是谁\n\n> TODO：她的名字与自称。\n'
    expect(template.length).toBeGreaterThan(20) // 关键是"非空"这条判据不够用
    expect(isPersonaDraftTemplate(template)).toBe(true)
  })

  it('写过一句真话就算写过（哪怕别处还留着 TODO —— 判据要宽松得合理）', () => {
    expect(isPersonaDraftTemplate('# 她是小研\n\n安静，不抢话。\n')).toBe(false)
  })

  it('空串与纯空白不算写过', () => {
    for (const text of ['', '   \n\n', '# 只有标题\n']) expect(isPersonaDraftTemplate(text)).toBe(false)
  })

  it('英文写法的 TODO 也认（模板可能被运营者翻译过）', () => {
    expect(isPersonaDraftTemplate('TODO: fill this in\n')).toBe(true)
    expect(isPersonaDraftTemplate('todo：填这里\n')).toBe(true)
  })
})

describe('把人格嵌进已安装的 preset', () => {
  it('⭐ 只动 persona 那一行：其余行的内容一字不变', () => {
    const before = parse(packagedPreset('xiaoyan-admin')) as Array<Record<string, unknown>>
    const after = parse(embedPersonaText(packagedPreset('xiaoyan-admin'), '新的人格文本')) as Array<
      Record<string, unknown>
    >

    expect(after.length).toBe(before.length)
    expect(before.some((row) => row.id === 'persona'), '被测文件里得有 persona 行').toBe(true)
    for (let i = 0; i < before.length; i += 1) {
      const source = before[i] ?? {}
      const target = after[i] ?? {}
      if (source.id === 'persona') {
        const config = (target.config ?? {}) as Record<string, unknown>
        const original = (source.config ?? {}) as Record<string, unknown>
        expect(config[PERSONA_TEXT_KEY]).toBe('新的人格文本')
        // 同一行里别的键（complete / includeRuntimeContext）必须原样 —— 它们决定这段是不是完整 prompt
        expect(config.complete).toBe(original.complete)
        expect(config.includeRuntimeContext).toBe(original.includeRuntimeContext)
      } else {
        expect(target, `第 ${i} 行（${String(source.id)}）不该被动`).toEqual(source)
      }
    }
  })

  it('注释留着（那些实测教训只活在这一份文件里）', () => {
    const out = embedPersonaText(packagedPreset('xiaoyan-agent'), '文本')
    expect(out).toContain('由 scripts/build-presets.mjs 生成')
    expect(out).toContain('能力裁剪取证方法')
    expect(out).toContain('a web provider with id "http" is already registered')
  })

  it('块标量写法与生成脚本一致（`prefix: |-`），读回来正是写进去的那段', () => {
    const out = embedPersonaText(packagedPreset('xiaoyan-world'), '  多行\n第二行\n')
    expect(out).toMatch(/prefix: \|-\n {6}多行/)
    // 前后空白被 trim：块标量里首尾空行会变成歧义，而人格文本的首尾空白本就没有意义
    expect(readEmbeddedPersona(out)).toBe('多行\n第二行')
  })

  it('人格里带 YAML 形状的东西也不会破（`# 标题`、`key: value`、缩进行、引号）', () => {
    const tricky = '# 标题\n\n- 列表项\n  缩进的续行\nkey: value\n"引号" 与 \'单引号\'\n冒号后面有空格: 是的\n'
    const out = embedPersonaText(packagedPreset('xiaoyan-agent'), tricky)
    expect(readEmbeddedPersona(out)).toBe(tricky.trim())
    // 结构仍是合法 YAML，行数没变
    expect((parse(out) as unknown[]).length).toBe((parse(packagedPreset('xiaoyan-agent')) as unknown[]).length)
  })

  it('⭐ 坏 YAML 不动盘：抛，而不是返回一份"看起来改好了"的文本', () => {
    const broken = '- id: persona\n  config:\n   bad indent: [unclosed\n'
    expect(() => embedPersonaText(broken, '文本')).toThrow(PersonaEmbedError)
    expect(() => readEmbeddedPersona(broken)).toThrow(PersonaEmbedError)
  })

  it('没有 persona 行的 preset 直接抛（静默"什么都没改"是最难查的失败）', () => {
    expect(() => embedPersonaText('- id: tool-web\n  name: x\n', '文本')).toThrow(/没有 persona 行/)
  })

  it('只写 name 不写 id 的行也认（DSH 按 name 装载，行名不是判据）', () => {
    const yml = "- id: whatever\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: 旧的\n"
    expect(readEmbeddedPersona(yml)).toBe('旧的')
    expect(readEmbeddedPersona(embedPersonaText(yml, '新的'))).toBe('新的')
  })

  it('顶层不是列表 → 抛（那已经不是我们的 preset 形态）', () => {
    expect(() => embedPersonaText('id: persona\nconfig: {}\n', '文本')).toThrow(/顶层不是列表/)
  })
})
