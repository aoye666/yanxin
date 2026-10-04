/**
 * 入站消息溯源的验收（T12）。
 *
 * 这一层的存在理由是**不能写自定义 session 事件**（会被持久化读取路径硬拒，
 * 见 `src/onebot/provenance.ts` 的文件头与 ADR 0012），于是溯源挂在
 * `MessageSourceMap` 的 `qq` kind 上、随 `user/message` 一起落盘。
 *
 * 因此这里的断言重点不只是"字段对不对"，还有**它能不能安全地写进日志**：
 * 纯数据、可 JSON 往返、没有 undefined 值混进来。
 */
import { describe, expect, it } from 'vitest'
import { qqSource, type QqMessageSource } from '../../src/onebot/provenance.ts'

const BOT = '3000000001'
const ALOYE = '2000000001'
const GROUP = '3000000003'

describe('qqSource —— 溯源字段', () => {
  it('群聊：带上群号，且 mode / account / userId 原样透传', () => {
    const source = qqSource({ userId: ALOYE, groupId: GROUP, mode: 'agent', account: BOT })

    expect(source).toEqual({
      kind: 'qq',
      userId: ALOYE,
      groupId: GROUP,
      mode: 'agent',
      account: BOT,
    })
  })

  it('⚠️ 私聊：`groupId` 这个键**根本不存在**，而不是 `undefined`', () => {
    const source = qqSource({ userId: ALOYE, mode: 'admin', account: BOT })

    // 用 `in` 而不是 `=== undefined`：JSON 序列化会丢掉 undefined 值，
    // 所以"键存在但值为 undefined"和"键不存在"在落盘后无法区分 ——
    // 必须在源头就保持干净。
    expect('groupId' in source).toBe(false)
    expect(source.groupId).toBeUndefined()
  })

  it.each(['agent', 'admin', 'world'] as const)('mode=%s 原样透传', (mode) => {
    expect(qqSource({ userId: ALOYE, mode, account: BOT }).mode).toBe(mode)
  })

  it('kind 恒为 qq（消费方靠它 switch）', () => {
    expect(qqSource({ userId: ALOYE, mode: 'agent', account: BOT }).kind).toBe('qq')
  })
})

describe('qqSource —— 能安全写进日志', () => {
  it('是可 JSON 往返的纯数据（持久化要求）', () => {
    const source = qqSource({ userId: ALOYE, groupId: GROUP, mode: 'agent', account: BOT })

    expect(JSON.parse(JSON.stringify(source))).toEqual(source)
  })

  it('私聊形态 JSON 往返后仍然没有 groupId 键', () => {
    const source = qqSource({ userId: ALOYE, mode: 'agent', account: BOT })
    const roundTripped = JSON.parse(JSON.stringify(source)) as QqMessageSource

    expect('groupId' in roundTripped).toBe(false)
  })

  it('只含预期字段 —— 不多带任何东西进日志', () => {
    const source = qqSource({ userId: ALOYE, groupId: GROUP, mode: 'world', account: BOT })

    expect(Object.keys(source).sort()).toEqual(['account', 'groupId', 'kind', 'mode', 'userId'])
  })
})
