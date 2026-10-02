/**
 * 传输层参数解析与控制台写入门的**纯逻辑**验收。
 *
 * 分成两组是有意的：
 *   A) 三级回退（settings → 行 config → 默认）—— 与 `src/memory/service.ts` 同一套口径，
 *      回退顺序写反 = 部署基线被静默忽略（memory 那边实测踩过）。
 *   B) `validateTransportInput` —— 这是**服务端安全门**，不是表单提示：
 *      非回环监听 + 空 token = 任何能连上这个端口的人都能冒充她的客户端，
 *      而 §7.4-A 的 URL 守卫管不到那条路（它只管 harness 自己发起的请求）。
 */
import { describe, expect, it } from 'vitest'
import {
  isPublicBindHost,
  resolveTransport,
  sameListenPoint,
  TRANSPORT_DEFAULTS,
  validateTransportInput,
  type Transport,
} from '../../src/onebot/transport.ts'

const CURRENT: Transport = {
  host: '127.0.0.1',
  port: 8080,
  path: '/onebot/v11',
  token: 'tok-1234567890',
  pingIntervalMs: 30_000,
  callTimeoutMs: 15_000,
}

describe('A) resolveTransport：三级回退', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, Partial<Transport>]> = [
    ['settings 说话最大', { host: '0.0.0.0', port: 9000 }, { host: '127.0.0.1', port: 8080 }, { host: '0.0.0.0', port: 9000 }],
    ['settings 没给的项回退到行 config', {}, { host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8080 }],
    ['两处都没有才落到默认（path / token 的默认是"不设限"）', {}, {}, { path: '', token: '' }],
    ['port 两处都没给 → 8080（不让调用方各自猜）', {}, {}, { port: 8080 }],
    [
      '空串 token 是**显式值**，不是"没给"（清空鉴权必须能被表达）',
      { token: '' },
      { token: 'from-config' },
      { token: '' },
    ],
    ['ping 间隔的回退同理', { pingIntervalMs: 5000 }, { callTimeoutMs: 9000 }, { pingIntervalMs: 5000, callTimeoutMs: 9000 }],
  ]

  it.each(cases)('%s', (_label, override, baseline, expected) => {
    const got = resolveTransport(override, baseline) as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(expected)) {
      expect(got[key], key).toEqual(value)
    }
  })

  it('默认值只有 TRANSPORT_DEFAULTS 这一处（schema 里不许再写一份 .default）', () => {
    const got = resolveTransport({}, {})
    expect(got.host).toBe(TRANSPORT_DEFAULTS.host)
    expect(got.path).toBe(TRANSPORT_DEFAULTS.path)
    expect(got.token).toBe(TRANSPORT_DEFAULTS.token)
    expect(got.pingIntervalMs).toBe(TRANSPORT_DEFAULTS.pingIntervalMs)
    expect(got.callTimeoutMs).toBe(TRANSPORT_DEFAULTS.callTimeoutMs)
  })
})

describe('B) isPublicBindHost：什么算对外', () => {
  const cases: Array<[string, boolean]> = [
    ['127.0.0.1', false],
    ['127.5.6.7', false], // 整个 127/8 都是回环
    ['::1', false],
    ['::ffff:127.0.0.1', false], // 双栈 socket 上内核给的就是这个形态
    [' 127.0.0.1 ', false], // 两端空白不该改变判定
    ['0.0.0.0', true],
    ['::', true],
    ['192.168.1.10', true],
    ['10.0.0.5', true], // 内网地址也是"对外"：同网段的机器能连
    ['example.com', true], // 认不出的一律按对外处理（fail-closed）
    ['', true],
  ]

  it.each(cases)('%s', (host, expected) => {
    expect(isPublicBindHost(host)).toBe(expected)
  })
})

describe('C) sameListenPoint：换绑的门', () => {
  it('host 与 port 都相同才不换', () => {
    expect(sameListenPoint({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8080 })).toBe(true)
    expect(sameListenPoint({ host: '127.0.0.1', port: 8080 }, { host: '0.0.0.0', port: 8080 })).toBe(false)
    expect(sameListenPoint({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8081 })).toBe(false)
  })
})

describe('D) validateTransportInput：非回环的两道门', () => {
  it('回环不需要确认，也不需要 token（本机进程才连得上）', () => {
    const verdict = validateTransportInput({ host: '127.0.0.1', confirm_public: 'false' }, CURRENT)
    expect(verdict.ok).toBe(true)
  })

  it('⭐ 非回环 + 没确认 → 拒（哪怕 token 已经有了）', () => {
    const verdict = validateTransportInput({ host: '0.0.0.0' }, CURRENT)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('确认')
  })

  it('⭐ 非回环 + 确认了但没 token → 拒（这才是真正的敞口）', () => {
    const noToken = { ...CURRENT, token: '' }
    const verdict = validateTransportInput({ host: '0.0.0.0', confirm_public: 'true' }, noToken)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/token|冒充/)
  })

  it('非回环 + 确认 + 已有 token → 放行', () => {
    const verdict = validateTransportInput({ host: '0.0.0.0', confirm_public: 'true' }, CURRENT)
    expect(verdict.ok).toBe(true)
  })

  it('把 token 清空的提交不接受（空值 = 不改，不是"关掉鉴权"）', () => {
    const verdict = validateTransportInput({ token: '   ' }, CURRENT)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.patch.token).toBeUndefined()
  })

  it('⭐ 换到非回环的同时想把 token 填上 → 放行（新 token 也算有 token）', () => {
    const noToken = { ...CURRENT, token: '' }
    const verdict = validateTransportInput(
      { host: '192.168.1.20', confirm_public: 'true', token: 'brand-new-token' },
      noToken,
    )
    expect(verdict.ok).toBe(true)
  })

  it('回环可以不带 token 就换过去（收紧方向永远不设卡）', () => {
    const noToken = { ...CURRENT, token: '' }
    const verdict = validateTransportInput({ host: '::1' }, noToken)
    expect(verdict.ok).toBe(true)
  })
})

describe('E) validateTransportInput：字段形态', () => {
  const rejects: Array<[string, Record<string, unknown>]> = [
    ['端口不是数字', { port: '8o8o' }],
    ['端口越界', { port: '70000' }],
    ['端口是负数', { port: '-1' }],
    ['地址写成 host:port', { host: '127.0.0.1:8080' }],
    ['地址是主机名', { host: 'localhost.localdomain' }],
    ['IPv4 段越界', { host: '999.1.1.1' }],
    ['路径不以 / 开头', { path: 'onebot/v11' }],
    ['路径带 query（会把比较变成另一回事）', { path: '/onebot?x=1' }],
    ['ping 间隔不是数字', { pingIntervalMs: '很快' }],
  ]

  it.each(rejects)('%s → 拒', async (_label, input) => {
    const verdict = validateTransportInput(input, CURRENT)
    expect(verdict.ok).toBe(false)
  })

  it('端口 0 合法（交给系统分配）', () => {
    const verdict = validateTransportInput({ port: '0' }, CURRENT)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.patch.port).toBe(0)
  })

  it('空白表单 = 空 patch（调用方据此回"什么都没改"，而不是写一次 settings）', () => {
    const verdict = validateTransportInput({}, CURRENT)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(Object.keys(verdict.patch)).toEqual([])
  })

  it('⭐ 拒绝理由里不带回 token 的值（这一句会显示在页面上，页面免凭据可读）', () => {
    const secret = 'super-secret-token-value'
    const verdict = validateTransportInput({ host: 'bad host', token: secret }, CURRENT)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).not.toContain(secret)
  })
})
