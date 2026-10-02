/**
 * 跨版本 session 事件读取的验收（ADR 0011）。
 *
 * 这一层的存在理由就是**运行时与类型是两份 dsh-session**，所以测试必须把两条路径
 * 都钉住，外加"两条都不在"时的 fail-loud —— 否则这个适配层会退化成新的静默失败点。
 */
import { describe, expect, it } from 'vitest'
import { readSessionEvents, type SessionEventSource } from '../../src/onebot/session-api.ts'

/** npm 形态：有 snapshotEvents，没有 events。 */
function npmShape(seen: number[] = []): SessionEventSource {
  return {
    snapshotEvents(fromSeq = 0, toSeqExclusive = 99) {
      seen.push(fromSeq)
      return [{ seq: fromSeq, type: 'turn/start', data: { turn: 1 }, to: toSeqExclusive }]
    },
  }
}

/** monorepo 形态：有 events（getter），没有 snapshotEvents。 */
function monorepoShape(): SessionEventSource {
  const prefix = { seq: 1, type: 'request/header', data: {} }
  const fresh = { seq: 2, type: 'turn/start', data: { turn: 1 } }
  return {
    get events() {
      return [prefix, fresh]
    },
  }
}

describe('readSessionEvents —— 两种 dsh-session 形态', () => {
  it('npm 形态：走 snapshotEvents，并把 fromSeq 透传进去', () => {
    const seen: number[] = []
    const events = readSessionEvents(npmShape(seen), 42)

    expect(seen).toEqual([42])
    expect(events).toHaveLength(1)
  })

  it('monorepo 形态：没有 snapshotEvents 时回退到全量 events', () => {
    const events = readSessionEvents(monorepoShape(), 42)

    // 全量返回（含 firstSeq 之前的前缀），过滤交给调用方 —— extractAssistantTurn 自带。
    expect(events).toHaveLength(2)
    expect((events[0] as { seq: number }).seq).toBe(1)
  })

  it('两者都在时优先 snapshotEvents（拿更窄的区间）', () => {
    const session: SessionEventSource = {
      events: [{ seq: 1, type: 'request/header', data: {} }],
      snapshotEvents: () => [{ seq: 7, type: 'turn/start', data: { turn: 1 } }],
    }

    expect(readSessionEvents(session, 7)).toEqual([{ seq: 7, type: 'turn/start', data: { turn: 1 } }])
  })

  it('receiver 仍是 session 本身（不给代理换掉 this 的机会）', () => {
    const session = {
      marker: 'session 自身',
      snapshotEvents(this: { marker: string }) {
        return [this.marker]
      },
    }

    expect(readSessionEvents(session, 0)).toEqual(['session 自身'])
  })

  it('events 不是数组（undefined / 非数组）时也走 fail-loud', () => {
    expect(() => readSessionEvents({ events: undefined }, 0)).toThrow(/snapshotEvents/)
    expect(() => readSessionEvents({ events: 'oops' as unknown as readonly unknown[] }, 0)).toThrow(/snapshotEvents/)
  })

  it('两者都没有时抛错，并把实际 prototype 成员写进错误信息', () => {
    class FutureSession {
      whatever(): void {}
      get seq(): number {
        return 3
      }
    }

    // 故意断言成接口类型：这个类**就是**要模拟"未来某天 API 又变了"的形态，
    // 所以它不该满足今天的接口 —— 满足的话这个测试就失去意义了。
    const future = new FutureSession() as unknown as SessionEventSource

    expect(() => readSessionEvents(future, 0)).toThrow(/whatever/)
    expect(() => readSessionEvents(future, 0)).toThrow(/ADR 0011/)
  })

  it('prototype 读不出来时，错误信息仍然成形（不掩盖原始问题）', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('prototype 被挡住了')
        },
        get() {
          return undefined
        },
      },
    )

    expect(() => readSessionEvents(hostile as SessionEventSource, 0)).toThrow(/prototype 被挡住了/)
  })
})
