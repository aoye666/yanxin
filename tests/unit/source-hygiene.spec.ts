/**
 * 源码卫生的机械守卫。
 *
 * 这个文件存在的理由：下面两类问题**都不是类型系统或运行时会报的错**，
 * 而症状会出现在离原因很远的地方，靠人眼记不住。所以做成自动化检查。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..')

/** 递归收集 .ts / .mjs 源文件（跳过 node_modules / lib / spike）。 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'spike') continue
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectSources(full, out)
    else if (/\.(ts|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

const SOURCES = [
  ...collectSources(join(ROOT, 'src')),
  ...collectSources(join(ROOT, 'tests')),
  ...collectSources(join(ROOT, 'scripts')),
]

const rel = (p: string): string => p.slice(ROOT.length + 1).replace(/\\/g, '/')

describe('源码卫生 —— 块注释里的 `*/` 会提前闭合注释', () => {
  it('没有块注释行在行中意外包含 */', () => {
    // 实测（2026-09-25）：某注释里写了 `profiles/*/cordis.patch.yml`，
    // 其中的 `*/` 把 `/** ... */` **提前闭合**了。后果是后面 3 行的错误
    // 报在了完全无关的位置（TS1443 "Module declaration names may only use ' or " quoted strings"）。
    // 更糟的是 —— 报的那 4 行里有两行是注释、一行是恰好也用模板串的代码，
    // 极易误判成"模板串语法问题"。根因是一个 `*/`。
    const offenders: string[] = []

    for (const file of SOURCES) {
      const lines = readFileSync(file, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        // 只看"以 * 开头"的续行（块注释内部），且 `*/` 不在行尾
        if (!/^\s*\*/.test(line)) continue
        if (!line.includes('*/')) continue
        if (/\*\/\s*$/.test(line)) continue // 正常的注释结尾
        offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`)
      }
    }

    expect(
      offenders,
      `块注释里出现行中的 */（会提前闭合注释）。改用不含 */ 的写法，例如把 glob 的 * 换成 <name>：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('反证：检测器真的能认出这种写法', () => {
    const badLine = ' * 路径是 profiles/*/cordis.patch.yml（这行会被提前闭合）'
    const isOffender = /^\s*\*/.test(badLine) && badLine.includes('*/') && !/\*\/\s*$/.test(badLine)
    expect(isOffender).toBe(true)
  })
})

describe('源码卫生 —— 不用正则的 .exec()（Mimosa 会误判为命令注入）', () => {
  it('src/ 与 tests/ 里没有 `.exec(`', () => {
    // 实测（ADR 0005 / ADR 0010）：Mimosa 钩子会把 `.exec(` 启发式判为
    // "高危命令注入"并**阻断写入**，已发生两次。改用 `String.prototype.match()`。
    // 把它做成机械检查，比靠记忆可靠。
    //
    // 排除两类命中：
    //   1. 注释行 —— 规则本身的文档里必然会提到 `.exec()`
    //   2. 本文件 —— 检查逻辑里必然包含这个字符串
    const SELF = rel(join(ROOT, 'tests', 'unit', 'source-hygiene.spec.ts'))
    const offenders: string[] = []
    for (const file of SOURCES) {
      if (rel(file) === SELF) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        const trimmed = line.trimStart()
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
        if (line.includes('.exec(')) offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`)
      }
    }
    expect(offenders, `改用 .match()（见 ADR 0005 / 0010）：\n${offenders.join('\n')}`).toEqual([])
  })

  it('反证：检测器能认出真的调用（且会跳过注释）', () => {
    const realCall = 'const m = /x/.exec(text)'
    const commentMention = ' * 不要用 .exec()'
    const isOffender = (line: string): boolean => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return false
      return line.includes('.exec(')
    }
    expect(isOffender(realCall)).toBe(true)
    expect(isOffender(commentMention)).toBe(false)
  })
})

describe('源码卫生 —— 服务实例字段不用 `#` 私有字段', () => {
  it('src/ 里没有 `#字段` 声明', () => {
    // ADR 0007：cordis 的追踪 Proxy 会以**替换过的 receiver** 调用服务成员，
    // `#private` 的品牌检查必然失败（"Cannot read private member ... from an object
    // whose class did not declare it"）。必须用 TS 的 `private`。
    const offenders: string[] = []
    for (const file of collectSources(join(ROOT, 'src'))) {
      const lines = readFileSync(file, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        // 声明形态：`#name` 或 `static #name` 后面跟 : 或 = （排除注释与 this.#x 访问）
        if (/^\s*(static\s+)?#[A-Za-z]/.test(line)) offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`)
      }
    }
    expect(offenders, `改用 TS 的 private（见 ADR 0007）：\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('源码卫生 —— 审计落盘只有一个出口（T36）', () => {
  const LOG = 'src/audit/log.ts'

  /** 判定一个源文件"绕过审计出口自己写盘"的判据（抽成函数是为了能对它做反证）。 */
  const looksLikeBypass = (text: string, relative: string): boolean => {
    if (relative === LOG) return false
    // 只看**代码行**：注释里提到 `audit/` 是正常的（`src/setup/install.ts` 的路径惯例说明
    // 就写了 `audit/`，但那里一行都没往审计里写东西）
    const code = text
      .split('\n')
      .filter((line) => {
        const head = line.trimStart()
        return !(head.startsWith('*') || head.startsWith('//') || head.startsWith('/*'))
      })
      .join('\n')
    if (!/audit/i.test(code)) return false // 得在代码里提到审计
    return /(?:appendFile|writeFile|createWriteStream)/.test(code) // 而且得真的在写盘
  }

  it('src/ 里除审计出口外，没有文件同时碰 fs 与 audit', () => {
    // 为什么要机械检查：`src/audit/log.ts` 是**唯一**做了密钥脱敏的落盘处（spec §7.4-D）。
    // 后来者若在自己的模块里直接 `appendFile(join(dshHome,'yanxin','audit',...))`，
    // 一切看起来都正常 —— 只是那条路径没有脱敏，而症状要等到某次审计里出现真密钥才暴露。
    const offenders: string[] = []
    for (const file of collectSources(join(ROOT, 'src'))) {
      const relative = rel(file)
      if (looksLikeBypass(readFileSync(file, 'utf8'), relative)) offenders.push(relative)
    }
    expect(
      offenders,
      `请改用 src/audit/log.ts 的 writeAudit()（它负责脱敏与"永不抛"）：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('src/audit/ 里只有 log.ts 碰 fs（逻辑文件保持纯粹）', () => {
    const offenders: string[] = []
    for (const file of collectSources(join(ROOT, 'src', 'audit'))) {
      const relative = rel(file)
      if (relative === LOG) continue
      if (/node:fs/.test(readFileSync(file, 'utf8'))) offenders.push(relative)
    }
    expect(offenders, `脱敏/危险等级/记录构造都不该碰文件系统：\n${offenders.join('\n')}`).toEqual([])
  })

  it('反证：检测器能认出真的绕道写法（且不误伤注释）', () => {
    const bypass = [
      "import { appendFile } from 'node:fs/promises'",
      "const file = join(process.env.DSH_HOME ?? '', 'yanxin', 'audit', 'shell.jsonl')",
      'await appendFile(file, line)',
    ].join('\n')
    expect(looksLikeBypass(bypass, 'src/world/whatever.ts')).toBe(true)

    // 注释里写 audit/ 但代码不写盘 —— 不该被误判（`src/setup/install.ts` 就是这个形态）
    const commentOnly = [
      ' * 全部落在 `$DSH_HOME/yanxin/` 下（与 `memory-outbox/`、`audit/` 同一套惯例）',
      "import { writeFile } from 'node:fs/promises'",
      "await writeFile(join(home, 'yanxin', 'setup.json'), text)",
    ].join('\n')
    expect(looksLikeBypass(commentOnly, 'src/setup/install.ts')).toBe(false)

    expect(looksLikeBypass('export function classifyCommand() {}', 'src/audit/danger.ts')).toBe(false)
    // 出口文件自身不算绕道
    expect(looksLikeBypass("import { appendFile } from 'node:fs/promises' // audit", LOG)).toBe(false)
  })
})

describe('源码卫生 —— 守卫：spike/ 与 lib/ 不进仓库', () => {
  it('.gitignore 覆盖 spike/ 与 lib/', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    expect(ignore).toMatch(/^spike\/$/m)
    expect(ignore).toMatch(/^lib\/$/m)
  })

  it('源文件里没有直接写死的长数字串（疑似 QQ 号）', () => {
    const offenders: string[] = []
    for (const file of SOURCES) {
      // 测试文件里出现构造用的假 QQ 号是允许的（那是夹具数据）
      if (rel(file).startsWith('tests/')) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue
        if (/\b\d{8,}\b/.test(line)) offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`)
      }
    }
    expect(offenders, `疑似硬编码的账号：\n${offenders.join('\n')}`).toEqual([])
  })
})

// 让 lint 知道 statSync 被用到（这里只用于确认 ROOT 存在）
it('仓库根目录可读', () => {
  expect(statSync(ROOT).isDirectory()).toBe(true)
})

// ── 真实标识不许回流到跟踪文件 ────────────────────────────────────────────
//
// 2026-10-05 的教训：仓里散着真人 QQ 号与真实群号（279 处 / 52 个文件），
// 而这些文件有一个是要推到**公开**仓的。上面那条"长数字串"的守卫只扫非测试的
// 源码，恰好漏掉了数量最多的那两类（测试夹具与 docs/）。这里补一张明确的黑名单。

/**
 * 黑名单的每个值都**拆成两段存**。
 *
 * 这个文件本身就在被扫描范围内：把真值写成整串，守卫就亲手把它请回了仓库。
 * 也别改用字符串相加（`'3855' + '048524'`）—— `no-useless-concat` 会警告你"合并成一条字面量"，
 * 照它说的做就正中我们要防的那件事，所以这里用数组片段，运行时才拼。
 */
const REAL_IDENTIFIERS: ReadonlyArray<{ readonly parts: readonly [string, string]; readonly what: string }> = [
  { parts: ['3855', '048524'], what: '她自己的 QQ 号（测试里曾叫 BOT）' },
  { parts: ['1580', '089687'], what: '主人的 QQ 号（测试里曾叫 ALOYE）' },
  { parts: ['2991', '064865'], what: '测试里曾叫 OTHER 的真人号' },
  { parts: ['3052', '887539'], what: '测试里曾叫 THIRD 的真人号' },
  { parts: ['1054', '390069'], what: '世界群的真实群号' },
  { parts: ['1037', '369836'], what: '从她会话目录里看到的候选群之一' },
  { parts: ['1097', '506987'], what: '同上' },
  { parts: ['3723', '94262'], what: '同上' },
]

/** 要扫的目录（真实标识曾出现在 docs/ 与 tests/ 里，只扫 src 是不够的）。 */
// 只扫会发布出去的那些目录：`spike/` 已在 .gitignore（那是本地草稿场，不该让守卫因它假红）。
const SCANNED_DIRS = ['src', 'tests', 'docs', 'deploy', 'persona', 'presets', 'scripts', 'tasks']

function collectAll(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectAll(full, out)
    else out.push(full)
  }
  return out
}

describe('真实 QQ 号 / 群号不得出现在跟踪文件里', () => {
  const files = SCANNED_DIRS.filter((d) => {
    try {
      statSync(join(ROOT, d)).isDirectory()
      return true
    } catch {
      return false
    }
  }).flatMap((d) => collectAll(join(ROOT, d)))

  it(`扫得到文件（${files.length} 个）—— 守卫自己不能悄悄失效`, () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('一个真实标识都不在（脱敏是一次性的，回流是长期的）', () => {
    const offenders: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue // 二进制或读不动：不是文本就没有 QQ 号可言
      }
      for (const { parts, what } of REAL_IDENTIFIERS) {
        if (text.includes(parts.join(''))) offenders.push(`${rel(file)} <- ${what}`)
      }
    }
    expect(offenders, `这些文件里还有真实标识：\n${offenders.join('\n')}`).toEqual([])
  })
})
