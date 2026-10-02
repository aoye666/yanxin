/**
 * 控制台纯逻辑的验收（T31，spec §6.12）。
 *
 * 三组判定各对应一道门（都能被测试证伪，这正是它们被抽成纯函数的原因）：
 *
 *   · **回环**：谁在敲门 —— 与"webServer 只绑 127.0.0.1"是两道独立的门
 *   · **token**：能不能写 —— 含"没配 token 时一律拒写"（fail-closed）
 *   · **定时安全比较**：比对方式本身（长度不同不抛、内容不同为假、相同为真）
 *
 * 外加两条"外壳是字面量"的断言：这是 XSS 那条链能被证明断开的依据 ——
 * 外壳与客户端脚本里**没有服务端插值**，客户端渲染只用 `createElement` / `textContent`
 * 建行内标记（见下面那一组：`**粗体**` 与 `` `代码` `` 只产出 `strong` / `code` 与文本节点）。
 */
import { describe, expect, it } from 'vitest'
import {
  authorize,
  isLoopbackAddress,
  normalizePath,
  readToken,
  requiresToken,
  tokenEquals,
  TOKEN_ENV,
} from '../../src/console/logic.ts'
import { CONSOLE_CLIENT_SCRIPT, CONSOLE_MARKDOWN_FILL, CONSOLE_SHELL } from '../../src/console/client.ts'

describe('T31 —— 门一：只服务回环', () => {
  const cases: { address: string | undefined; loopback: boolean; why: string }[] = [
    { address: '127.0.0.1', loopback: true, why: '标准回环' },
    { address: '127.5.6.7', loopback: true, why: '整个 127/8 都是回环' },
    { address: '::1', loopback: true, why: 'IPv6 回环' },
    { address: '::ffff:127.0.0.1', loopback: true, why: '双栈 socket 上的 IPv4-mapped' },
    { address: ' 127.0.0.1 ', loopback: true, why: '两端空白不该影响判定' },
    { address: '192.168.1.5', loopback: false, why: '私网地址不是回环' },
    { address: '10.0.0.1', loopback: false, why: '同上' },
    { address: '8.8.8.8', loopback: false, why: '公网' },
    { address: '::ffff:192.168.1.5', loopback: false, why: 'mapped 之后也不是回环' },
    { address: '127.0.0.1.5', loopback: false, why: '五段不是 IPv4' },
    { address: '127.0.0.256', loopback: false, why: '越界的段不算' },
    { address: 'localhost', loopback: false, why: '主机名不做解析（拿不到地址就拒）' },
    { address: '', loopback: false, why: '空值 fail-closed' },
    { address: undefined, loopback: false, why: '拿不到地址 fail-closed' },
  ]

  for (const testCase of cases) {
    it(`${JSON.stringify(testCase.address)} → ${testCase.loopback ? '放行' : '拒绝'}（${testCase.why}）`, () => {
      expect(isLoopbackAddress(testCase.address)).toBe(testCase.loopback)
    })
  }
})

describe('T31 —— 门二：写操作与日志流要 token', () => {
  it('读操作不需要（GET / HEAD / OPTIONS）', () => {
    expect(requiresToken('GET')).toBe(false)
    expect(requiresToken('get')).toBe(false)
    expect(requiresToken('HEAD')).toBe(false)
    expect(requiresToken('OPTIONS')).toBe(false)
    expect(requiresToken(undefined)).toBe(false) // 缺省当 GET
  })

  it('写操作需要（POST / PUT / DELETE / PATCH）', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect(requiresToken(method)).toBe(true)
  })

  it('⭐ 有两类读操作也要 token：日志流；其余页面仍然免凭据', () => {
    // 流里是运行时日志原文 —— 出口的脱敏只抹得掉"认得出的密钥形态"，所以按凭据请求对待
    expect(requiresToken('GET', '/api/log/stream')).toBe(true)
    expect(requiresToken('GET', '/api/log/anything-else')).toBe(true)
    // 不给路径（旧的调用形态）与别的读路径仍然免 token —— §6.12"只读页面可不带"不变
    expect(requiresToken('GET')).toBe(false)
    expect(requiresToken('GET', '/api/page')).toBe(false)
    expect(requiresToken('GET', '/api/page/settings')).toBe(false)
    expect(requiresToken('GET', '/api/stats')).toBe(false)
    // 前缀匹配是"路径段"级别的：不能因为字符串里含 `log` 就误伤
    expect(requiresToken('GET', '/api/catalog/log-shape')).toBe(false)
  })

  it('authorize 按路径决定要不要凭据（没配 token → 403，不带 → 401）', () => {
    expect(authorize({ method: 'GET', path: '/api/page', provided: undefined, expected: undefined }).allowed).toBe(
      true,
    )
    expect(
      authorize({ method: 'GET', path: '/api/log/stream', provided: undefined, expected: 's3cret' }),
    ).toStrictEqual({ allowed: false, status: 401, reason: '这个请求需要 token' })
    expect(
      authorize({ method: 'GET', path: '/api/log/stream', provided: 's3cret', expected: 's3cret' }).allowed,
    ).toBe(true)
    const noEnv = authorize({ method: 'GET', path: '/api/log/stream', provided: 's3cret', expected: undefined })
    expect(noEnv.allowed).toBe(false)
    if (!noEnv.allowed) expect(noEnv.status).toBe(403)
  })

  it('⭐ 没配 token 时**写操作一律拒**（fail-closed，403）', () => {
    const verdict = authorize({ method: 'POST', provided: 'whatever', expected: undefined })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.status).toBe(403)
      expect(verdict.reason).toContain(TOKEN_ENV)
    }

    // 空串也当"没配"（环境变量设了个空值不等于配好了）
    expect(authorize({ method: 'POST', provided: 'x', expected: '' }).allowed).toBe(false)
  })

  it('配了 token 但没带 → 401（与"没配"分开：那是服务器的问题，这是请求的问题）', () => {
    const verdict = authorize({ method: 'POST', provided: undefined, expected: 'secret' })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.status).toBe(401)
  })

  it('token 不对 → 401；对了 → 放行', () => {
    expect(authorize({ method: 'POST', provided: 'wrong', expected: 'secret' }).allowed).toBe(false)
    expect(authorize({ method: 'POST', provided: 'secret', expected: 'secret' }).allowed).toBe(true)
  })

  it('读操作连 token 都不看（没配也放行）', () => {
    expect(authorize({ method: 'GET', provided: undefined, expected: undefined }).allowed).toBe(true)
  })
})

describe('T31 —— 定时安全比较', () => {
  it('相同为真、不同为假、长度不同**不抛**', () => {
    expect(tokenEquals('abc', 'abc')).toBe(true)
    expect(tokenEquals('abc', 'abd')).toBe(false)
    expect(tokenEquals('abc', 'abcd')).toBe(false) // 长度不同：先比长度，不进 timingSafeEqual
    expect(tokenEquals('', '')).toBe(true)
    // 非 ASCII 也按字节比（不会因为编码差异误判）
    expect(tokenEquals('密钥', '密钥')).toBe(true)
    expect(tokenEquals('密钥', '密匙')).toBe(false)
  })
})

describe('T31 —— 取 token：头优先于查询串', () => {
  it('x-yanxin-token 头最优先', () => {
    expect(readToken({ 'x-yanxin-token': 'from-header' }, new URLSearchParams('token=from-query'))).toBe('from-header')
  })

  it('Authorization: Bearer 也认（大小写不敏感）', () => {
    expect(readToken({ authorization: 'Bearer abc' }, new URLSearchParams())).toBe('abc')
    expect(readToken({ authorization: 'bearer abc' }, new URLSearchParams())).toBe('abc')
    expect(readToken({ authorization: 'Basic abc' }, new URLSearchParams())).toBeUndefined()
  })

  it('都没有时取查询串；空值当"没带"', () => {
    expect(readToken({}, new URLSearchParams('token=abc'))).toBe('abc')
    expect(readToken({}, new URLSearchParams('token='))).toBeUndefined()
    expect(readToken({}, new URLSearchParams())).toBeUndefined()
    expect(readToken({ 'x-yanxin-token': '' }, new URLSearchParams())).toBeUndefined()
  })
})

describe('T31 —— 路径规范化', () => {
  it('补前导斜杠、去尾斜杠、空值回默认', () => {
    expect(normalizePath('yanxin')).toBe('/yanxin')
    expect(normalizePath('/yanxin/')).toBe('/yanxin')
    expect(normalizePath('/yanxin///')).toBe('/yanxin')
    expect(normalizePath('  /yanxin  ')).toBe('/yanxin')
    expect(normalizePath('')).toBe('/yanxin')
    expect(normalizePath('   ')).toBe('/yanxin')
  })
})

describe('T31 —— 外壳与脚本是字面量（XSS 那条链被断开的地方）', () => {
  it('⭐ 外壳里没有外部脚本引用（脚本**内联**，没有相对路径可解析错）', () => {
    expect(CONSOLE_SHELL).not.toContain('<script src')
    expect(CONSOLE_SHELL).toContain(CONSOLE_CLIENT_SCRIPT)
  })

  it('客户端渲染只用 textContent / createElement —— **没有 innerHTML**', () => {
    expect(CONSOLE_CLIENT_SCRIPT).not.toContain('innerHTML')
    expect(CONSOLE_CLIENT_SCRIPT).not.toContain('outerHTML')
    expect(CONSOLE_CLIENT_SCRIPT).not.toContain('insertAdjacentHTML')
    expect(CONSOLE_CLIENT_SCRIPT).toContain('textContent')
    expect(CONSOLE_CLIENT_SCRIPT).toContain('createElement')
  })

  it('客户端脚本自己推导挂载路径（服务端不往里填东西）', () => {
    expect(CONSOLE_CLIENT_SCRIPT).toContain('location.pathname')
    expect(CONSOLE_CLIENT_SCRIPT).not.toContain('__')
  })

  it('写操作带 x-yanxin-token 头（表单提交路径）', () => {
    expect(CONSOLE_CLIENT_SCRIPT).toContain('x-yanxin-token')
  })
})

/**
 * 外壳样式的那几道锁。美化**只发生在 `<style>` 里**（渲染器不产 class，所以选择器只能走
 * 结构与属性）—— 下面每条都是为了钉住这个边界：不引入第二次请求、不给 hidden 输入解封、
 * 不出现第二种强调色。
 */
describe('外壳样式 —— 只有一条 <style>，且没有外部依赖', () => {
  it('⭐ 零外链：没有 @import / url() / 任何 http 资源（离线回环面）', () => {
    expect(CONSOLE_SHELL).not.toContain('@import')
    expect(CONSOLE_SHELL).not.toContain('url(')
    expect(CONSOLE_SHELL).not.toMatch(/https?:\/\/[^"'\s]*\.(css|js|woff|png|svg)/)
    expect(CONSOLE_SHELL.match(/<style>/g)).toHaveLength(1)
  })

  it('暗色单主题，且尊重 prefers-reduced-motion', () => {
    expect(CONSOLE_SHELL).toContain('color-scheme: dark')
    expect(CONSOLE_SHELL).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('无光晕、无渐变、无阴影（状态只靠一根左边线）', () => {
    expect(CONSOLE_SHELL).not.toContain('box-shadow')
    expect(CONSOLE_SHELL).not.toContain('text-shadow')
    expect(CONSOLE_SHELL).not.toContain('filter:')
    expect(CONSOLE_SHELL).not.toContain('gradient(')
  })

  it('强调色只有一个来源（--accent 家族），warn 是唯一例外', () => {
    // 裸的暖色字面量只允许出现在 token 定义里；正文样式一律引用变量
    expect(CONSOLE_SHELL).toContain('--accent: #c8a063')
    expect(CONSOLE_SHELL).toContain('--accent-hi: #dcbb84')
    expect(CONSOLE_SHELL.match(/#c8a063|#dcbb84|#6a5637/g)).toHaveLength(3)
  })

  it('⭐ 表单样式把 hidden 排除在外（作者样式会盖掉 UA 的 display: none）', () => {
    expect(CONSOLE_SHELL).toContain('input:not([type="checkbox"]):not([type="hidden"])')
    // 裸 `input {` 规则一旦存在，hidden 输入就会变成可见的空框
    expect(CONSOLE_SHELL).not.toMatch(/^(\s*)input\s*\{/m)
  })

  it('圆角只有一档语义：区块一档、行内 chip 一档，没有第三种值', () => {
    expect(CONSOLE_SHELL).toContain('--r-block: 10px')
    expect(CONSOLE_SHELL).toContain('--r-chip: 5px')
    const radii = [...CONSOLE_SHELL.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => (m[1] ?? '').trim())
    expect(new Set(radii)).toStrictEqual(new Set(['var(--r-block)', 'var(--r-chip)']))
  })

  it('id 选择器写成属性形式（行首的 `#xxx` 会被全仓卫生扫描当成私有字段）', () => {
    expect(CONSOLE_SHELL).not.toMatch(/^\s*#[A-Za-z]/m)
    expect(CONSOLE_SHELL).toContain('[id="status"]')
  })
})

describe('T31 —— 行内标记：文案里的 **粗体** 与 `代码` 要真的显示成粗体和代码', () => {
  /** 最小假 DOM：只实现这段脚本实际用到的那几件事（append / textContent）。 */
  class El {
    private readonly kids: El[] = []
    private own: string
    constructor(public readonly tag: string, initial?: string) {
      this.own = initial ?? ''
    }
    append(...items: readonly El[]): void {
      this.kids.push(...items)
    }
    set textContent(value: string) {
      this.own = value
    }
    get textContent(): string {
      return this.own + this.kids.map(child => child.textContent).join('')
    }
    /** `#text` 只出文字，元素递归出 `<tag>内容</tag>` —— 用于断言形状而不是断言像素。 */
    html(): string {
      if (this.tag === '#text') return this.own
      return `<${this.tag}>${this.own + this.kids.map(child => child.html()).join('')}</${this.tag}>`
    }
  }

  /** 跑一次渲染，顺带记下它建过哪些元素。 */
  function render(source: string): { html: string; tags: string[] } {
    const tags: string[] = []
    const fake = {
      createElement: (tag: string) => {
        tags.push(tag)
        return new El(tag)
      },
      createTextNode: (text: string) => new El('#text', text),
    }
    // 被测对象是**浏览器里跑的那段源文本**，不是它的 TypeScript 翻版 —— 只能这样取。
    const make = new Function('document', `${CONSOLE_MARKDOWN_FILL}; return fill`)
    const fill = make(fake) as (node: El, text: string) => void
    const root = new El('p')
    fill(root, source)
    return { html: root.html(), tags }
  }

  const cases: { source: string; html: string; why: string }[] = [
    { source: '普通文字', html: '<p>普通文字</p>', why: '没有标记时一字不差' },
    { source: '**粗体**', html: '<p><strong>粗体</strong></p>', why: '成对的星号变强调' },
    { source: '`code`', html: '<p><code>code</code></p>', why: '成对的反引号变行内代码' },
    {
      source: '前 **粗** 后 `码` 尾',
      html: '<p>前 <strong>粗</strong> 后 <code>码</code> 尾</p>',
      why: '两种标记混排，文字段不丢',
    },
    {
      source: '名单存在 settings 的 `yanxin-admin` 命名空间（即 `$DSH_HOME/settings.yaml`）',
      html: '<p>名单存在 settings 的 <code>yanxin-admin</code> 命名空间（即 <code>$DSH_HOME/settings.yaml</code>）</p>',
      why: '管理员页的真实文案（两处代码跨度）',
    },
    { source: '100 ** 2 落单的星号', html: '<p>100 ** 2 落单的星号</p>', why: '没有闭合 → 原样，不吞后面的字' },
    { source: '一个反引号 ` 在这里落单', html: '<p>一个反引号 ` 在这里落单</p>', why: '凑不成对 → 原样' },
    { source: 'a ` b ` c', html: '<p>a <code> b </code> c</p>', why: '夹着空格的两个反引号仍然算一对' },
    { source: '****', html: '<p>****</p>', why: '空跨度不成立' },
    { source: '``', html: '<p>``</p>', why: '空代码不成立' },
    { source: '', html: '<p></p>', why: '空串不建任何节点' },
    { source: '**开头没关', html: '<p>**开头没关</p>', why: '只找到开标 → 整段原样' },
    {
      source: '世界引擎现在是**卸下的**：不在开放时段',
      html: '<p>世界引擎现在是<strong>卸下的</strong>：不在开放时段</p>',
      why: '世界页那条 notice 的真实文案',
    },
  ]

  for (const testCase of cases) {
    it(`${JSON.stringify(testCase.source).slice(0, 46)} → ${testCase.why}`, () => {
      expect(render(testCase.source).html).toBe(testCase.html)
    })
  }

  it('⭐ 标记不打开新的注入面：`<script>` 无论在内在外都只是文字', () => {
    const attack = '**卸下的** <script>alert(1)</script> `x`'
    const { html, tags } = render(attack)
    expect(html).toBe('<p><strong>卸下的</strong> <script>alert(1)</script> <code>x</code></p>')
    // 建出来的元素只有这两种标记 —— 文本里的标签名永远不会变成一个真元素
    expect(tags).toStrictEqual(['strong', 'code'])
    expect(tags).not.toContain('script')
  })

  it('行内标记不嵌套：内层的反引号留在外层里当文字', () => {
    expect(render('**看 `这里` 吧**').html).toBe('<p><strong>看 `这里` 吧</strong></p>')
  })

  it('脚本里确实接上了这套渲染（el 走 fill、code 区块走 plain 不解析）', () => {
    expect(CONSOLE_CLIENT_SCRIPT).toContain('fill(node, text)')
    expect(CONSOLE_CLIENT_SCRIPT).toContain("case 'code': return plain('pre'")
    expect(CONSOLE_CLIENT_SCRIPT).toContain(CONSOLE_MARKDOWN_FILL.trim())
  })
})
