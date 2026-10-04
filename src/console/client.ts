/**
 * 控制台的**客户端**：渲染器脚本与外壳（T31）。
 *
 * ## 为什么脚本内联在外壳里
 *
 * 一开始它是 `<script src="./client.js">` —— 在浏览器里**加载失败**：从 `/yanxin`
 * （无尾斜杠）解析相对路径时，`yanxin` 被当成文件名，`./client.js` 于是变成 `/client.js`。
 * 那种 bug 在 curl 直连 `/yanxin/client.js` 时看不出来（服务端两条路径都对）。
 *
 * 内联之后：**少一个请求、没有相对路径、外壳仍是一个常量**（这一段脚本是写死的，
 * 不含任何服务端插值）。挂载路径由脚本自己从 `location.pathname` 推导（见下）。
 *
 * ## 两条纪律（XSS 那条链断开的地方）
 *
 *   · 渲染**只用 `createElement` / `createTextNode` / `textContent`** —— 没有 `innerHTML`。
 *     昵称、群消息、日志行里的 `<script>` 只会原样显示成文字
 *   · 挂载路径与服务端数据**都来自 JSON 响应**（`payload.data.base` / `.pages`），
 *     不是拼进 HTML 的 —— 所以这里不存在"把数据写进标记"的代码路径
 *
 * ## 行内标记为什么不破坏上面那条
 *
 * `fill()` 认 `**粗体**` 与 `` `代码` `` 两种成对标记（页文案里有一百多处），
 * 但它只产出**文本节点**和 `strong` / `code` 两种元素，**从不**从文本里取属性、
 * URL 或标签名。所以 `<script>` 依然是文字，`**` 变成了加粗 —— 被解析的是标记字符，
 * 不是标记语言。`code` 区块（日志、转录）走 {@link plain}，原样不解析。
 */
import type { ServerResponse } from 'node:http'

/**
 * 行内标记渲染器（脚本的一部分；单独导出只为了能在 Node 里直接测）。
 *
 * 成对才生效：落单的 `*` 或反引号当普通字符。这里不嵌套 —— 文案里没有 `**\`x\`**` 这种形态。
 */
export const CONSOLE_MARKDOWN_FILL = `
  /** 建一个只带纯文本的元素（**不**解析标记）。 */
  function plain(tag, text) {
    var node = document.createElement(tag)
    if (text !== undefined) node.textContent = String(text)
    return node
  }

  function addText(node, chunk) {
    if (chunk) node.append(document.createTextNode(chunk))
  }

  function addMark(node, tag, content) {
    node.append(plain(tag, content))
  }

  /** 把一段文字按 **粗体** / 反引号代码 拆开挂到 node 上；产出只有文本节点与 strong/code。 */
  function fill(node, text) {
    var source = String(text)
    var tick = '\\u0060'
    var start = 0
    var i = 0
    while (i < source.length) {
      if (source.charAt(i) === '*' && source.charAt(i + 1) === '*') {
        var close = source.indexOf('**', i + 2)
        if (close > i + 2) {
          addText(node, source.slice(start, i))
          addMark(node, 'strong', source.slice(i + 2, close))
          i = close + 2
          start = i
          continue
        }
      }
      if (source.charAt(i) === tick) {
        var stop = source.indexOf(tick, i + 1)
        if (stop > i + 1) {
          addText(node, source.slice(start, i))
          addMark(node, 'code', source.slice(i + 1, stop))
          i = stop + 1
          start = i
          continue
        }
      }
      i = i + 1
    }
    addText(node, source.slice(start))
  }
`

/** 浏览器端脚本（**字面量**；挂载路径运行时自己推导）。 */
export const CONSOLE_CLIENT_SCRIPT = `(function () {
  // 挂载路径：去掉尾斜杠后再去掉最后一段（'/yanxin/' → '/yanxin'，'/yanxin/setup' → '/yanxin'）。
  // 裸挂载路径（'/yanxin'）去掉最后一段会变成空串，那时回退成原值。
  // 服务端在首次响应里也会给 base（payload.data.base），拿到之后就以它为准。
  var pathname = location.pathname.replace(/\\/+$/, '')
  var base = pathname.replace(/\\/[^/]*$/, '') || pathname
  var slug = pathname.slice(base.length) || '/'
  var app = document.getElementById('app')
  var navBar = document.getElementById('nav')
  var pending = ''
  /** 接口返回的区块（结果里的 data.blocks），渲染在页尾；下一次加载清掉。 */
  var pendingBlocks = null
${CONSOLE_MARKDOWN_FILL}
  function el(tag, text, className) {
    var node = document.createElement(tag)
    if (text !== undefined) fill(node, text)
    if (className) node.className = className
    return node
  }

  function renderBlock(block) {
    var i
    switch (block.kind) {
      case 'p': return el('p', block.text)
      case 'ul':
        if (block.items.length === 0) return el('p', '（空）')
        var ul = el('ul')
        for (i = 0; i < block.items.length; i++) ul.append(el('li', block.items[i]))
        return ul
      case 'code': return plain('pre', block.text)
      case 'stream':
        // 实时流（SSE）：服务端推一行挂一行。id 走属性选择器美化（渲染器不产 class）。
        var box = plain('pre')
        box.id = 'stream-box'
        // 日志流要 token，而 EventSource **不能带自定义请求头** —— 只能拼进查询串（见 logic.ts）
        var stream = block.url + (block.url.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(token())
        var source = new EventSource(stream)
        source.onmessage = function (event) {
          try {
            var payload = JSON.parse(event.data)
            if (payload.reset) box.textContent = ''
            if (payload.text) {
              box.append(document.createTextNode(payload.text))
              var lines = box.textContent.split('\\n')
              if (lines.length > 400) box.textContent = lines.slice(-400).join('\\n')
              box.scrollTop = box.scrollHeight
            }
          } catch (_) { /* 坏帧忽略 —— 下一帧照常 */ }
        }
        source.onerror = function () {
          // readyState 2 = CLOSED：401/403 浏览器不会再重连，得说一句人话，
          // 否则使用者对着一块空白，分不清"没日志"和"没权限"。
          if (source.readyState === 2) {
            box.append(document.createTextNode('\\n（日志流被拒：token 不对，或服务端没配凭据）'))
          }
        }
        return box
      case 'notice': return el('p', block.text, 'notice ' + block.tone)
      case 'link':
        var p = el('p')
        var a = el('a', block.text)
        a.setAttribute('href', block.href)
        p.append(a)
        return p
      case 'table':
        var table = el('table')
        if (block.caption) table.append(el('caption', block.caption))
        if (block.head) {
          var head = el('thead')
          var headRow = el('tr')
          for (i = 0; i < block.head.length; i++) headRow.append(el('th', block.head[i]))
          head.append(headRow)
          table.append(head)
        }
        var body = el('tbody')
        for (i = 0; i < block.rows.length; i++) {
          var row = el('tr')
          for (var j = 0; j < block.rows[i].length; j++) row.append(el('td', block.rows[i][j]))
          body.append(row)
        }
        table.append(body)
        return table
      case 'form':
        var form = el('form')
        form.setAttribute('method', 'post')
        form.setAttribute('action', block.action)
        for (i = 0; i < block.fields.length; i++) {
          var field = block.fields[i]
          var kind = field.type || 'text'
          var input = document.createElement(kind === 'textarea' ? 'textarea' : 'input')
          input.setAttribute('name', field.name)
          // textarea 没有 type 属性（写了会变成无名属性，浏览器仍按 textarea 渲染）
          if (kind !== 'textarea') input.setAttribute('type', kind)
          if (field.value !== undefined) {
            // 多行内容赋给 .value —— 不拼 HTML 字符串：人格里的 #、<、** 只会显示成文字
            if (kind === 'textarea') input.value = field.value
            else input.setAttribute('value', field.value)
          }
          if (kind === 'textarea') {
            input.setAttribute('rows', '14')
            input.setAttribute('spellcheck', 'false')
          }
          if (kind === 'checkbox' && field.value === 'true') input.checked = true
          if (kind === 'hidden') { form.append(input); continue }
          var label = el('label', field.label)
          label.append(input)
          if (field.hint) label.append(el('small', field.hint))
          form.append(label)
        }
        var button = el('button', block.submit || '提交')
        button.setAttribute('type', 'submit')
        form.append(button)
        form.addEventListener('submit', submitForm)
        return form
      default: return el('p', '（这一页用了控制台不认识的区块：' + block.kind + '）')
    }
  }

  function token() {
    var value = sessionStorage.getItem('yanxin-token')
    if (value) return value
    value = prompt('这一步需要 ' + '${'${TOKEN_NAME}'}' + '（只存在这个标签页里）') || ''
    if (value) sessionStorage.setItem('yanxin-token', value)
    return value
  }

  function submitForm(event) {
    event.preventDefault()
    var form = event.target
    var payload = {}
    // ⚠️ 选择器要带上 textarea：只查 input 的话，多行字段会被**静默丢掉** ——
    // 表单看起来提交了、后端收到一个空 body，而症状是"什么都没改"，最难归因的一种。
    var inputs = form.querySelectorAll('input, textarea')
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i]
      payload[input.name] = input.type === 'checkbox' ? (input.checked ? 'true' : 'false') : input.value
    }
    fetch(form.getAttribute('action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yanxin-token': token() },
      body: JSON.stringify(payload),
    })
      .then(function (res) { return res.json().catch(function () { return { ok: res.ok } }) })
      .then(function (result) {
        var data = result.data || {}
        // 接口可以**返回区块**（结果里的 data.blocks）—— 例如记忆页的检索结果。
        // 约定：这些区块追加在页尾（不替换页面本身），下一次导航/刷新就清掉。
        if (result.ok && data.blocks) pendingBlocks = data.blocks
        // 业务的成败与请求的成败是两件事：请求成功而那一步失败是常见的（缺前置）
        status(result.ok ? (data.detail || data.error || '已提交。') : '被拒：' + (result.error || '未知原因'))
      })
      .catch(function (error) { status('请求失败：' + error.message) })
  }

  function status(text) {
    pending = text
    load()
  }

  function nav(pages) {
    while (navBar.firstChild) navBar.removeChild(navBar.firstChild)
    var home = el('a', '控制台首页')
    home.setAttribute('href', base + '/')
    if (slug === '/') home.setAttribute('aria-current', 'page')
    navBar.append(home)
    for (var i = 0; i < pages.length; i++) {
      var link = el('a', pages[i].title)
      link.setAttribute('href', base + '/' + pages[i].slug)
      if (slug === '/' + pages[i].slug) link.setAttribute('aria-current', 'page')
      navBar.append(link)
    }
  }

  function load() {
    while (app.firstChild) app.removeChild(app.firstChild)
    fetch(base + '/api/page' + (slug === '/' ? '' : slug))
      .then(function (res) { return res.json() })
      .then(function (payload) {
        var data = payload.data || {}
        if (data.base) base = data.base
        if (!payload.ok) { app.append(el('p', payload.error || '出错了', 'notice warn')); return }
        document.title = data.title
        nav(data.pages || [])
        if (pending) {
          var line = el('p', pending, 'notice')
          line.id = 'status'
          app.append(line)
        }
        app.append(el('h1', data.title))
        for (var i = 0; i < data.blocks.length; i++) app.append(renderBlock(data.blocks[i]))
        if (pendingBlocks) {
          for (var k = 0; k < pendingBlocks.length; k++) app.append(renderBlock(pendingBlocks[k]))
          pendingBlocks = null
        }
      })
      .catch(function (error) { app.append(el('p', '加载失败：' + error.message, 'notice warn')) })
  }

  load()
})()`.replace('${TOKEN_NAME}', 'YANXIN_CONSOLE_TOKEN')

/**
 * 外壳（**字面量**：唯一的内插是上面那段脚本本身，不含任何外部数据）。
 *
 * 样式全在这里，且**只用结构与属性选择器** —— 渲染器不产 class，所以美化不需要动客户端脚本
 * （也就没有"把数据写进 class"的路径）。一条强调色、一套圆角、零外链资源。
 *
 * 这段 CSS 活在模板字符串**里面**：注释里不能出现反引号，也不能出现 `${`。
 */
export const CONSOLE_SHELL = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>研心控制台</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0e0f10;
    --surface: #16181a;
    --surface-2: #1c1f22;
    --fg: #ecece6;
    --fg-body: #d8d8d1;
    --muted: #93938b;
    --line: #292c30;
    --line-strong: #3d4147;
    --accent: #c8a063;
    --accent-hi: #dcbb84;
    --accent-dim: #6a5637;
    --warn: #c9665c;
    --r-block: 10px;
    --r-chip: 5px;
    --serif: Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif;
    --sans: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    --mono: ui-monospace, "Cascadia Mono", Consolas, "Sarasa Mono SC", monospace;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html {
    background: var(--bg);
    scrollbar-color: var(--line-strong) transparent;
  }
  body {
    font: 15px/1.65 var(--sans);
    color: var(--fg-body);
    margin: 0 auto;
    padding: 2.75rem 2rem 6rem;
    max-width: 74rem;
    display: flex;
    align-items: flex-start;
    gap: 2.4rem;
  }
  ::selection { background: rgba(200, 160, 99, .28); color: var(--fg); }

  /* 导航：**左侧竖排标签栏**，sticky 跟随滚动。当前页用 aria-current 高亮
     （值来自 location，不是服务端数据 —— 不破坏"数据不进标记属性"的纪律） */
  nav {
    position: sticky;
    top: 2.75rem;
    align-self: flex-start;
    flex-shrink: 0;
    width: 10.5rem;
    display: flex;
    flex-direction: column;
    gap: .1rem;
    margin: 0;
    padding: 0 .9rem 0 0;
    border-right: 1px solid var(--line);
    font-size: 13.5px;
    letter-spacing: .02em;
  }
  nav a {
    color: var(--muted);
    text-decoration: none;
    padding: .42rem .7rem;
    border-radius: var(--r-chip);
    transition: color .14s ease-out, background-color .14s ease-out;
  }
  /* 「首页」是根：与分支隔一条发丝线 */
  nav a:first-child {
    color: var(--fg);
    margin-bottom: .45rem;
    padding-bottom: .6rem;
    border-bottom: 1px solid var(--line);
  }
  nav a:hover { color: var(--accent-hi); background: var(--surface-2); }
  nav a[aria-current] {
    color: var(--accent-hi);
    background: var(--surface-2);
    font-weight: 600;
  }
  nav a:focus-visible, main a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
    border-radius: var(--r-chip);
  }

  main { min-height: 55vh; flex: 1; min-width: 0; }
  /* 纯 CSS 的加载态：load() 会先清空 main，那一段空档就是"正在取这一页" */
  main:empty::before {
    content: '正在取这一页…';
    display: block;
    color: var(--muted);
    font-size: 13.5px;
  }
  main > * { animation: appear .2s ease-out both; }
  @keyframes appear { from { opacity: 0; transform: translateY(4px); } }

  h1 {
    font: 400 1.85rem/1.25 var(--serif);
    letter-spacing: .01em;
    color: var(--fg);
    margin: 0 0 1.6rem;
  }
  h1::after {
    content: '';
    display: block;
    width: 2.4rem;
    height: 2px;
    margin-top: .75rem;
    background: var(--accent);
  }

  p, ul { margin: .85rem 0; max-width: 64ch; }
  li { margin: .3rem 0; }
  li::marker { color: var(--accent-dim); }
  strong { color: var(--fg); font-weight: 600; }
  a { color: var(--accent); }
  main a {
    text-decoration: underline;
    text-decoration-color: var(--accent-dim);
    text-underline-offset: 3px;
    text-decoration-thickness: 1px;
  }
  main a:hover { color: var(--accent-hi); text-decoration-color: currentColor; }

  /* 行内 code 是这一页的术语强调；code **区块**（日志、转录）是裸 <pre>，不走这里 */
  code {
    font: .87em/1.4 var(--mono);
    color: var(--accent-hi);
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--r-chip);
    padding: .1em .38em;
  }
  pre {
    font: 12.8px/1.6 var(--mono);
    color: #d0d3d0;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-block);
    padding: .9rem 1rem;
    margin: 1.25rem 0;
    overflow-x: auto;
  }
  /* 实时日志流：固定高度内部滚动，新日志自动滚到底 */
  [id="stream-box"] {
    max-height: 26rem;
    overflow-y: auto;
    white-space: pre-wrap;
  }

  /* 表格：没有满格网格，只留行与行之间的发丝线；首列用负边距对齐正文 */
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1.25rem 0 1.75rem -.75rem;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  caption {
    caption-side: top;
    text-align: left;
    color: var(--muted);
    font-size: 12.5px;
    letter-spacing: .06em;
    padding: 0 0 .6rem .75rem;
  }
  th, td {
    text-align: left;
    vertical-align: top;
    padding: .55rem .75rem;
  }
  th {
    color: var(--muted);
    font-weight: 600;
    font-size: 12.5px;
    letter-spacing: .04em;
    border-bottom: 1px solid var(--line-strong);
    white-space: nowrap;
  }
  td { color: var(--fg-body); border-bottom: 1px solid var(--line); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: var(--surface); color: var(--fg); }

  /* 提示条：平面，无阴影。左边那根线是唯一的状态色 */
  .notice {
    max-width: 64ch;
    margin: 1rem 0;
    padding: .7rem .95rem;
    color: var(--fg-body);
    background: var(--surface);
    border: 1px solid var(--line);
    border-left: 2px solid var(--accent-dim);
    border-radius: var(--r-block);
  }
  .notice.warn { border-left-color: var(--warn); }
  /* 用属性选择器而不是 #status：全仓有个卫生扫描把行首的 #xxx 当 TS 私有字段（ADR 0007） */
  [id="status"] { border-left-color: var(--accent); background: var(--surface-2); }

  /* 表单：hidden 必须排除（作者样式会盖掉 UA 的 display:none，把它显示出来） */
  form { margin: 2rem 0 1rem; max-width: 34rem; }
  form label {
    display: grid;
    gap: .3rem;
    margin: 0 0 1.1rem;
    font-size: 14px;
    color: var(--fg);
  }
  form label small { color: var(--muted); font-size: 12.5px; line-height: 1.45; }
  /* 复选框要和它的文字同行；不支持 :has() 时退化成普通块级 label，仍然可用 */
  form label:has(input[type="checkbox"]) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: .3rem .65rem;
  }
  input:not([type="checkbox"]):not([type="hidden"]) {
    display: block;
    width: 100%;
    font: inherit;
    font-size: 14px;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-block);
    padding: .55rem .75rem;
    transition: border-color .14s ease-out;
  }
  input:not([type="checkbox"]):not([type="hidden"]):hover { border-color: var(--muted); }
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-color: transparent;
  }
  input[type="checkbox"] {
    width: 1rem;
    height: 1rem;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  button {
    font: 600 14px/1 var(--sans);
    letter-spacing: .02em;
    color: #17140e;
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--r-block);
    padding: .72rem 1.35rem;
    cursor: pointer;
    transition: background-color .14s ease-out, transform .1s ease-out;
  }
  button:hover { background: var(--accent-hi); }
  button:active { transform: translateY(1px); }
  button:focus-visible { outline: 2px solid var(--fg); outline-offset: 3px; }

  @media (max-width: 640px) {
    body { flex-direction: column; gap: 0; padding: 2rem 1.15rem 4rem; }
    nav {
      position: static;
      width: auto;
      flex-direction: row;
      flex-wrap: wrap;
      gap: .2rem .5rem;
      border-right: none;
      border-bottom: 1px solid var(--line);
      padding: 0 0 1rem;
      margin-bottom: 1.8rem;
    }
    nav a:first-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
    h1 { font-size: 1.55rem; }
    table { margin-left: 0; font-size: 13.5px; }
    th, td { padding: .5rem .55rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<nav id="nav"></nav>
<main id="app"></main>
<script>
${CONSOLE_CLIENT_SCRIPT}
</script>
</body>
</html>
`

/** 写外壳（常量；脚本已内联，所以只有一个响应）。 */
export function serveShell(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(CONSOLE_SHELL)
}

/**
 * 把**裸挂载路径**（`/yanxin`）重定向到带尾斜杠的形式。
 *
 * 为什么必须做：相对路径的解析规则里，`/yanxin` 的最后一段被当成**文件名** ——
 * 页内任何相对链接都会跑到上一级去。重定向一次之后所有 URL 都规整了
 * （客户端脚本仍会自己推导挂载路径，所以这只影响首屏那一次）。
 */
export function redirectToSlash(res: ServerResponse, base: string): void {
  res.writeHead(308, { location: `${base}/`, 'cache-control': 'no-store' })
  res.end()
}