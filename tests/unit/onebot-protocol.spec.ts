/**
 * OneBot v11 纯协议层的验收（T8/T9 的协议部分）。
 *
 * 重点覆盖一个**真实陷阱**：心跳事件同时带 `post_type` 与 `status`，
 * 分类时若先看 `status` 就会把心跳误判成 API 响应 —— 而心跳的 `status` 是**对象**，
 * 后续逻辑会以更难懂的方式炸掉。
 */
import { describe, expect, it } from 'vitest'
import {
  buildApiFrame,
  classifyFrame,
  isClientRole,
  isHeartbeat,
  isLifecycleConnect,
  parseHandshake,
  pathnameOf,
  type HeaderValue,
} from '../../src/onebot/protocol.ts'

/** 便于按名取头（大小写不敏感，模拟 Node 的行为）。 */
function headers(map: Record<string, string | string[] | undefined>) {
  const lower: Record<string, HeaderValue> = {}
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v
  return (name: string) => lower[name.toLowerCase()]
}

describe('parseHandshake —— 合法握手', () => {
  it.each(['API', 'Event', 'Universal'])('接受 X-Client-Role: %s', (role) => {
    const r = parseHandshake(headers({ 'x-self-id': '2000000002', 'x-client-role': role }))
    expect(r).toEqual({ ok: true, selfId: '2000000002', role, token: undefined })
  })

  it('解析 Authorization: Bearer <token>', () => {
    const r = parseHandshake(
      headers({ 'x-self-id': '1', 'x-client-role': 'Universal', authorization: 'Bearer example-onebot-token-1234' }),
    )
    expect(r).toEqual({ ok: true, selfId: '1', role: 'Universal', token: 'example-onebot-token-1234' })
  })

  it('Bearer 大小写不敏感、前后空白可容忍', () => {
    const r = parseHandshake(
      headers({ 'x-self-id': ' 1 ', 'x-client-role': ' API ', authorization: '  bearer   abc  ' }),
    )
    expect(r).toEqual({ ok: true, selfId: '1', role: 'API', token: 'abc' })
  })

  it('头值可能是数组（Node 的 IncomingHttpHeaders），取第一个', () => {
    const r = parseHandshake(headers({ 'x-self-id': ['10001', '20002'], 'x-client-role': ['Universal'] }))
    expect(r).toEqual({ ok: true, selfId: '10001', role: 'Universal', token: undefined })
  })

  it('头名大小写不敏感', () => {
    const r = parseHandshake(headers({ 'X-Self-ID': '123', 'X-Client-Role': 'Event' }))
    expect(r.ok).toBe(true)
  })
})

describe('parseHandshake —— 不合法的握手都要给出可读原因', () => {
  const cases: Array<[string, Record<string, string | string[] | undefined>, RegExp]> = [
    ['缺 X-Self-ID', { 'x-client-role': 'API' }, /缺少 X-Self-ID/],
    ['X-Self-ID 为空串', { 'x-self-id': '   ', 'x-client-role': 'API' }, /缺少 X-Self-ID/],
    ['X-Self-ID 非数字', { 'x-self-id': 'abc', 'x-client-role': 'API' }, /不是数字串/],
    ['缺 X-Client-Role', { 'x-self-id': '1' }, /缺少 X-Client-Role/],
    ['X-Client-Role 非法', { 'x-self-id': '1', 'x-client-role': 'Bot' }, /X-Client-Role 非法/],
    ['Authorization 不是 Bearer', { 'x-self-id': '1', 'x-client-role': 'API', authorization: 'Basic abc' }, /不是 Bearer 形式/],
  ]

  it.each(cases)('%s', (_label, map, pattern) => {
    const r = parseHandshake(headers(map))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(pattern)
  })
})

describe('classifyFrame —— ⚠️ 心跳陷阱（这条是本节存在的理由）', () => {
  /** 规范的真实心跳形状：同时带 post_type 与 status（status 是**对象**） */
  const heartbeat = {
    time: 1790333000,
    self_id: 2000000002,
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status: { online: true, good: true },
    interval: 15000,
  }

  it('心跳必须被分类为 event，而不是 api-response', () => {
    const f = classifyFrame(heartbeat)
    expect(f.kind).toBe('event')
    if (f.kind === 'event') {
      expect(f.postType).toBe('meta_event')
      expect(isHeartbeat(f)).toBe(true)
      expect(f.selfId).toBe('2000000002')
    }
  })

  it('若先按 status 判定就会误判 —— 用反证说明顺序为何重要', () => {
    // 心跳的 status 是对象；如果按"有 status 就是 API 响应"来判，
    // 就会得到 status 为对象的"响应"，与 ApiResponseFrame.status: string 矛盾。
    expect(typeof heartbeat.status).not.toBe('string')
    expect(classifyFrame(heartbeat).kind).not.toBe('api-response')
  })

  it('lifecycle connect 能被识别（NapCat 每次(重)连都会发）', () => {
    const f = classifyFrame({
      time: 1,
      self_id: 2000000002,
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
    })
    expect(f.kind).toBe('event')
    if (f.kind === 'event') {
      expect(isLifecycleConnect(f)).toBe(true)
      expect(isHeartbeat(f)).toBe(false)
    }
  })
})

describe('classifyFrame —— 事件', () => {
  it('群消息事件：self_id 数字被字符串化（便于与握手头的字符串比对）', () => {
    const f = classifyFrame({
      time: 1,
      self_id: 2000000002,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 99,
      group_id: 123456,
      user_id: 1000000001,
      message: 'hi',
      raw_message: 'hi',
    })
    expect(f.kind).toBe('event')
    if (f.kind === 'event') {
      expect(f.selfId).toBe('2000000002')
      expect(typeof f.selfId).toBe('string')
      expect(f.postType).toBe('message')
    }
  })

  it('self_id 缺失时 selfId 为空串（交给上层的串号检查处理）', () => {
    const f = classifyFrame({ post_type: 'message', message_type: 'private', message: 'x' })
    expect(f.kind).toBe('event')
    if (f.kind === 'event') expect(f.selfId).toBe('')
  })
})

describe('classifyFrame —— API 响应', () => {
  it('失败响应（规范示例）', () => {
    const f = classifyFrame({ status: 'failed', retcode: 1404, data: null, echo: '123' })
    expect(f).toEqual({
      kind: 'api-response',
      status: 'failed',
      retcode: 1404,
      data: null,
      echo: '123',
      raw: { status: 'failed', retcode: 1404, data: null, echo: '123' },
    })
  })

  it('成功响应带 data', () => {
    const f = classifyFrame({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: 'e1' })
    expect(f.kind).toBe('api-response')
    if (f.kind === 'api-response') {
      expect(f.status).toBe('ok')
      expect(f.retcode).toBe(0)
      expect(f.data).toEqual({ message_id: 42 })
    }
  })

  it('echo 缺失时是 undefined（规范说 echo 可选）', () => {
    const f = classifyFrame({ status: 'ok', retcode: 0, data: null })
    expect(f.kind).toBe('api-response')
    if (f.kind === 'api-response') expect(f.echo).toBeUndefined()
  })

  it('retcode 缺失时给 -1（不假装是成功）', () => {
    const f = classifyFrame({ status: 'weird', data: 1 })
    expect(f.kind).toBe('api-response')
    if (f.kind === 'api-response') expect(f.retcode).toBe(-1)
  })
})

describe('classifyFrame —— 无法分类的输入不抛异常', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['数组', [1, 2]],
    ['数字', 42],
    ['字符串', 'hello'],
    ['空对象', {}],
    ['只有 echo', { echo: '1' }],
  ])('%s → unknown', (_label, value) => {
    const f = classifyFrame(value)
    expect(f.kind).toBe('unknown')
    if (f.kind === 'unknown') expect(f.reason.length).toBeGreaterThan(0)
  })
})

describe('parseHandshake —— token 的两种承载方式', () => {
  it('只有 query 形式时也能取到（部分实现两种都提供）', () => {
    const r = parseHandshake(
      headers({ 'x-self-id': '1', 'x-client-role': 'Universal' }),
      '/onebot/v11?access_token=abc123',
    )
    expect(r).toEqual({ ok: true, selfId: '1', role: 'Universal', token: 'abc123' })
  })

  it('Authorization 头优先于 query', () => {
    const r = parseHandshake(
      headers({ 'x-self-id': '1', 'x-client-role': 'Universal', authorization: 'Bearer from-header' }),
      '/ws?access_token=from-query',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.token).toBe('from-header')
  })

  it('两者都没有时 token 为 undefined（未配 token 的部署）', () => {
    const r = parseHandshake(headers({ 'x-self-id': '1', 'x-client-role': 'API' }), '/ws')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.token).toBeUndefined()
  })
})

describe('pathnameOf', () => {
  it.each([
    ['/onebot/v11', '/onebot/v11'],
    ['/onebot/v11?access_token=x', '/onebot/v11'],
    ['/onebot/v11#frag', '/onebot/v11'],
    ['/', '/'],
    [undefined, ''],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(pathnameOf(input)).toBe(expected)
  })
})

describe('isClientRole', () => {
  it('只认规范定义的三个值', () => {
    for (const ok of ['API', 'Event', 'Universal']) expect(isClientRole(ok)).toBe(true)
    for (const bad of ['api', 'BOT', '', null, 1, undefined, 'Universal ']) expect(isClientRole(bad)).toBe(false)
  })
})

describe('buildApiFrame', () => {
  it('产出 action / params / echo 三个字段', () => {
    expect(buildApiFrame('send_group_msg', { group_id: 1, message: 'hi' }, 'e1')).toEqual({
      action: 'send_group_msg',
      params: { group_id: 1, message: 'hi' },
      echo: 'e1',
    })
  })
})
