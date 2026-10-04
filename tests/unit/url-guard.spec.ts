/**
 * URL 守卫的表驱动用例 —— spec §7.4-A 的验收。
 *
 * 由 spike/url-guard-check.mts 正式化而来（T38）。分四组：
 *   A 公网放行 / B 各类内网与非法地址拒绝 / C 参数扫描 / D 端到端判定
 *
 * 注意：A 组与 D 组的公网用例会做真实 DNS 解析（example.com 等），需要网络。
 * 若在离线环境跑，这几条会失败 —— 那属于环境问题而非逻辑问题，不要为了让它变绿
 * 而删掉 DNS 解析这条断言（spec §7.4-A 第 3 条明确要求"先解析再判定"）。
 */
import { describe, expect, it } from 'vitest'
import {
  apply,
  checkUrl,
  collectUrlArgs,
  isBlockedHostname,
  isBlockedIpv4,
  isBlockedIpv6,
  parseIpv6,
} from '../../src/net/url-guard.ts'

describe('A) checkUrl：应当放行的公网地址', () => {
  const allowed = [
    'https://example.com/',
    'http://example.com/a',
    'https://example.com:443/ok',
    'https://api.suotianyi.top/v1/models',
    // IPv6 公网字面量（不走 DNS，离线也稳）
    'http://[2606:4700:4700::1111]/',
    'http://[2001:4860:4860::8888]/dns-query',
  ]

  it.each(allowed)('%s', async (url) => {
    await expect(checkUrl(url)).resolves.toBeUndefined()
  })
})

describe('B) checkUrl：应当拒绝的地址', () => {
  const blocked: Array<[string, string]> = [
    ['http://127.0.0.1:3080/', '回环'],
    ['http://127.1.2.3/', '回环段'],
    ['http://localhost/', '内网主机名'],
    ['http://localhost:3080/x', '内网主机名带端口'],
    ['http://foo.localhost/', '*.localhost'],
    ['http://box.local/', '*.local'],
    ['http://svc.internal/', '*.internal'],
    ['http://10.0.0.1/', '私有 10/8'],
    ['http://192.168.1.1/', '私有 192.168/16'],
    ['http://172.16.0.1/', '私有 172.16/12'],
    ['http://172.31.255.255/', '私有 172.16/12 上界'],
    ['http://100.64.0.1/', 'CGNAT'],
    ['http://169.254.169.254/latest/meta-data/', '云元数据'],
    ['http://[::1]/', 'IPv6 回环'],
    ['http://[fd00::1]/', 'IPv6 ULA'],
    ['http://[fe80::1]/', 'IPv6 链路本地'],
    ['http://0.0.0.0/', '未指定'],
    ['http://224.0.0.1/', '多播'],
    ['http://198.18.0.1/', '基准测试段'],
    ['file:///etc/passwd', '非 http 协议'],
    ['ftp://example.com/', '非 http 协议'],
    ['http://user:pass@example.com/', 'URL 内凭据'],
    ['not a url', '无法解析'],
    // ── IPv6 的写法归一化（T35 补的洞）────────────────────────────────────
    // WHATWG URL 把点分内嵌归一化成十六进制：`[::ffff:169.254.169.254]` → `[::ffff:a9fe:a9fe]`。
    // 旧判定只认点分形态，于是这几条**全部能过** —— 现在必须逐条拒绝。
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped 的云元数据（归一化成十六进制）'],
    ['http://[::ffff:a9fe:a9fe]/', 'IPv4-mapped 十六进制写法'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped 的回环'],
    ['http://[::ffff:7f00:1]/', 'IPv4-mapped 回环的十六进制写法'],
    ['http://[::ffff:10.0.0.1]/', 'IPv4-mapped 的私有段'],
    ['http://[64:ff9b::a9fe:a9fe]/', 'NAT64 映射到云元数据'],
    ['http://[64:ff9b:1::a9fe:a9fe]/', 'NAT64 本地前缀映射到云元数据'],
    ['http://[2002:7f00:1::]/', '6to4 嵌回环'],
    ['http://[2002:a9fe:a9fe::]/', '6to4 嵌云元数据'],
    ['http://[0:0:0:0:0:0:0:1]/', '::1 的展开写法'],
    ['http://[fec0::1]/', '站点本地（已弃用，fail-closed）'],
  ]

  it.each(blocked)('%s —— %s', async (url) => {
    const reason = await checkUrl(url)
    expect(typeof reason).toBe('string')
    expect(reason?.length).toBeGreaterThan(0)
  })
})

describe('C) collectUrlArgs：参数扫描', () => {
  const cases: Array<[string, unknown, number]> = [
    ['web_fetch 形态 url', { url: 'https://a.com' }, 1],
    ['tavily_extract 形态 urls 数组', { urls: ['https://a.com', 'http://127.0.0.1/'] }, 2],
    ['tavily_crawl 形态 url', { url: 'http://127.0.0.1/', max_depth: 2 }, 1],
    ['无 URL 参数', { query: '今天天气' }, 0],
    ['域名列表不该被当 URL', { include_domains: ['a.com', 'b.com'], exclude_domains: ['c.com'] }, 0],
    ['嵌套对象', { nested: { url: 'https://b.com' } }, 1],
    ['深层嵌套', { a: { b: { c: { urls: ['https://c.com'] } } } }, 1],
    ['非字符串 url', { url: 123 }, 0],
    ['混合', { urls: ['https://a.com'], select_paths: ['/x'], url: 'https://d.com' }, 2],
  ]

  it.each(cases)('%s', (_label, args, expected) => {
    expect(collectUrlArgs(args)).toHaveLength(expected)
  })
})

describe('D) 端到端：工具参数的最终判定', () => {
  async function anyBlocked(args: unknown): Promise<boolean> {
    for (const url of collectUrlArgs(args)) {
      if (await checkUrl(url)) return true
    }
    return false
  }

  it('tavily_extract 的 urls 数组含私网元素 → 拦', async () => {
    await expect(
      anyBlocked({ urls: ['https://example.com/ok', 'http://169.254.169.254/latest/meta-data/'] }),
    ).resolves.toBe(true)
  })

  it('全公网的 urls 数组 → 放行', async () => {
    await expect(anyBlocked({ urls: ['https://example.com/a', 'https://example.com/b'] })).resolves.toBe(false)
  })
})

describe('E) 单元：地址判定函数', () => {
  it('isBlockedIpv4 覆盖各段', () => {
    for (const ip of ['0.0.0.1', '10.1.2.3', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.0.1', '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255']) {
      expect(isBlockedIpv4(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '223.255.255.255']) {
      expect(isBlockedIpv4(ip), ip).toBe(false)
    }
    // 非法输入按拒绝处理（fail-closed）
    for (const bad of ['999.1.1.1', '1.2.3', 'a.b.c.d']) {
      expect(isBlockedIpv4(bad), bad).toBe(true)
    }
  })

  it('isBlockedIpv6 覆盖各段', () => {
    for (const ip of ['::', '::1', '[::1]', 'fc00::1', 'fd12::34', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1']) {
      expect(isBlockedIpv6(ip), ip).toBe(true)
    }
    for (const ip of ['2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(isBlockedIpv6(ip), ip).toBe(false)
    }
  })

  it('⚠️ 内嵌 IPv4 的封装按【里面的 IPv4】判，不按外层前缀', () => {
    // 这几条是回归用例：它们的**外层是合法的 IPv6 语法**，只有看内嵌才判得出是内网。
    // 起因是实测发现 URL 解析器会把点分写法归一化成十六进制（见下一条），
    // 于是"只认 `::ffff:1.2.3.4` 点分形态"的判定形同虚设。
    const mappedBlocked = [
      '::ffff:a9fe:a9fe', // 169.254.169.254   云元数据
      '::ffff:7f00:1', // 127.0.0.1         回环
      '::ffff:a00:1', // 10.0.0.1          私有
      '::ffff:c0a8:101', // 192.168.1.1       私有
      '::a9fe:a9fe', // ::169.254.169.254 IPv4-compatible
      '64:ff9b::a9fe:a9fe', // NAT64 知名前缀
      '64:ff9b:1::a9fe:a9fe', // NAT64 本地前缀
      '2002:7f00:1::', // 6to4 嵌 127.0.0.1
      '2002:a9fe:a9fe::', // 6to4 嵌 169.254.169.254
    ]
    for (const ip of mappedBlocked) expect(isBlockedIpv6(ip), ip).toBe(true)

    const mappedAllowed = [
      '::ffff:8.8.8.8', // 公网
      '::ffff:808:808', // 8.8.8.8 的十六进制写法
      '64:ff9b::808:808', // NAT64 映射到 8.8.8.8
      '2002:808:808::', // 6to4 嵌 8.8.8.8
    ]
    for (const ip of mappedAllowed) expect(isBlockedIpv6(ip), ip).toBe(false)
  })

  it('parseIpv6：压缩 / 展开 / 内嵌点分三种写法解析到同一组值', () => {
    const expanded = new URL('http://[0:0:0:0:0:0:0:1]/').hostname
    expect(expanded).toBe('[::1]') // URL 自己会归一化 —— 这是本轮取证的一条事实
    expect(parseIpv6(expanded)).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6('[::1]')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304])
    expect(parseIpv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]) // 带 zone 也要认
    expect(parseIpv6('2001:db8::1:2:3')).toEqual([0x2001, 0x0db8, 0, 0, 0, 1, 2, 3])
    // 解析不了的一律 undefined（调用方 fail-closed）
    for (const bad of ['', ':::', '1:2:3', 'gggg::1', '::ffff:999.1.1.1']) {
      expect(parseIpv6(bad), bad).toBeUndefined()
    }
  })

  it('isBlockedHostname 覆盖内网主机名', () => {
    for (const h of ['localhost', 'LOCALHOST', 'a.localhost', 'x.local', 'y.internal', 'z.home.arpa']) {
      expect(isBlockedHostname(h), h).toBe(true)
    }
    for (const h of ['example.com', 'localhost.example.com', 'notlocal']) {
      expect(isBlockedHostname(h), h).toBe(false)
    }
  })

  it('带方括号的 IP 字面量不归 isBlockedHostname 管（分工说明）', () => {
    // isBlockedHostname 只处理【主机名模式】；`[::1]` / `127.0.0.1` 这类字面量在 checkUrl 里
    // 由 isIpLiteral 识别后交给 isBlockedIpv6 / isBlockedIpv4 判定（checkUrl 第 4 步）。
    // 所以这里断言 false 是**正确的分工结果**，不是漏判 —— 端到端由 B 组的
    // `http://[::1]/` 与 `http://127.0.0.1:3080/` 两条用例覆盖。
    for (const h of ['[::1]', '127.0.0.1', '::1']) {
      expect(isBlockedHostname(h), h).toBe(false)
    }
    expect(isBlockedIpv6('[::1]')).toBe(true)
    expect(isBlockedIpv4('127.0.0.1')).toBe(true)
  })
})

describe('F) 重定向：每一跳的归属（T35）', () => {
  it('守卫是【无状态纯判定】：落点再喂一次，内网照样拒绝', async () => {
    // spec §7.4-A 第 3 条要求"每一跳重定向后重新校验"。在我们这一层的实现方式，
    // 就是**不给任何 URL 留可继承的信任** —— 没有"上一跳验过了"这种状态，
    // 同一个 URL 判定几次结论都一样（中间插一个公网 URL 也不影响）。
    const target = 'http://169.254.169.254/latest/meta-data/'
    const first = await checkUrl(target)
    expect(first).toMatch(/内网|保留/)
    await expect(checkUrl('https://example.com/')).resolves.toBeUndefined()
    await expect(checkUrl(target)).resolves.toBe(first)
  })

  // 跳数上限（spec §7.4-A 第 4 条 ≤3）**不在这里断言**：「实际跟不跟这一跳」发生在我们
  // 看不见的 provider 内部（它只跟同源跳转，跨源直接抛 WEB_REDIRECT_BLOCKED ——
  // policy.ts:43-54 / provider.ts:55-101，见 T35 记录）。跳数上限的唯一归属地是
  // `bundle-patch.spec.ts` 里那条 patch 断言；这里重复一遍只会让两处漂移。
})

describe('G) 出口纪律：拦截原因进 logger 前必须脱敏', () => {
  /** 装一个只记 warn 的假 ctx，返回"注册的 pre-execute 处理器"与该 ctx。 */
  function makeCtx() {
    const lines: string[] = []
    let handler: ((exec: any, next: () => Promise<any>) => Promise<any>) | undefined
    const ctx = {
      logger: {
        warn: (fmt: string, ...args: unknown[]) => lines.push(`${fmt} ${args.join(' ')}`),
      },
      on: (event: string, fn: typeof handler) => {
        if (event === 'tools/pre-execute') handler = fn
      },
    }
    apply(ctx as never)
    return { lines, fire: (exec: any) => handler?.(exec, async () => ({ kind: 'allow' })) }
  }

  it('⭐ 带 key 的 URL 被拒时，logger 那一行不含密钥值（它会进控制台日志流）', async () => {
    const { lines, fire } = makeCtx()
    // 拒绝原因里**确实带**用户可控串的两类：解析失败（下一条）与主机名判定（这一条）。
    // 用 IP 字面量做这条用例是**假通过** —— 那个 reason 里只有 `127.0.0.1`， query 根本进不去。
    // ⚠️ 主机名会被 URL 解析器**转小写**，所以密钥取全小写形态，两条断言才可比。
    const verdict = await fire({
      name: 'web_fetch',
      arguments: { url: 'http://tvly-dev-fakekey123456.localhost/mcp' },
    })

    expect(verdict.kind).toBe('deny')
    expect(String(verdict.reason)).toContain('localhost')
    const logged = lines.join('\n')
    expect(logged).toContain('[yanxin-url-guard]')
    expect(logged).not.toContain('tvly-dev-fakekey123456')
    // 落给模型的 deny reason **不**脱敏（那是调用方自己发的 URL），收口的只有 logger 这一条
    expect(String(verdict.reason)).toContain('tvly-dev-fakekey123456')
  })

  it('⭐ 解不开的 URL 折成一行并截断（否则能把换行伪造进日志）', async () => {
    const { lines, fire } = makeCtx()
    const nasty = `not a url\n伪造一行 ERROR tavilyApiKey=tvly-dev-FAKEKEY123456 ${'x'.repeat(400)}`
    await fire({ name: 'web_fetch', arguments: { url: nasty } })

    const logged = lines.join('\n')
    expect(logged).not.toContain('tvly-dev-FAKEKEY123456')
    expect(logged).not.toContain('\n') // 一条 warn 就是一行，注入不进去
    expect(logged.length).toBeLessThan(300) // 200 字符的截断窗口 + 前缀
  })
})
