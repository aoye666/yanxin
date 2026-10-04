/**
 * 合并转发展开（`src/onebot/forward.ts`）的验收。
 *
 * 这一件的失败模式全是**静默**的：拉不到就 `[forward]` 一个字、深度不设上限会把几十条
 * 套娃消息灌进 prompt、按位置替换占位符会把内容错位。所以每条都断言"她实际读到什么"，
 * 而不是断言内部调用了几次什么。
 */
import { describe, expect, it } from 'vitest'
import {
  FORWARD_MAX_DEPTH,
  FORWARD_MAX_NODES,
  FORWARD_PLACEHOLDER,
  expandForward,
  forwardNodes,
  renderInboundText,
} from '../../src/onebot/forward.ts'
import { normalizeMessage } from '../../src/onebot/message.ts'

/** 记下了每次 API 调用的假传输；返回什么由每个用例自己塞。 */
function recorder(result: unknown | ((action: string, params: Record<string, unknown>) => unknown)) {
  const calls: { action: string; params: Record<string, unknown> }[] = []
  const warn: string[] = []
  const call = async (action: string, params: Record<string, unknown>): Promise<unknown> => {
    calls.push({ action, params })
    if (typeof result === 'function') {
      const fn = result as (a: string, p: Record<string, unknown>) => unknown
      return fn(action, params)
    }
    return result
  }
  return { calls, warn, call, warnOf: (message: string) => void warn.push(message) }
}

const makeWarn = (sink: string[]) => (message: string) => sink.push(message)

function node(nickname: string, text: string, time?: number): Record<string, unknown> {
  return {
    type: 'node',
    data: {
      user_id: 10001,
      nickname,
      ...(time === undefined ? {} : { time }),
      content: [{ type: 'text', data: { text } }],
    },
  }
}

describe('展开合并转发：谁在哪个时间说了什么', () => {
  it('⭐ 官方形态 {messages:[…]}：一次 get_forward_msg，渲染出人名、时间与原话', async () => {
    const r = recorder({ messages: [node('张三', '今晚八点开门', 1_759_572_180), node('李四', '带猫来')] })

    const text = await expandForward(r.call, { id: '7788', inline: undefined }, makeWarn(r.warn))

    expect(r.calls).toEqual([{ action: 'get_forward_msg', params: { message_id: '7788' } }])
    expect(text).toContain('[转发消息 · 共 2 条]')
    expect(text).toContain('- 张三（')
    expect(text).toContain('今晚八点开门')
    expect(text).toContain('- 李四：带猫来') // 没有时间就不带括号
    expect(r.warn).toEqual([])
  })

  it('NapCat 形态：data 直接是数组、节点是裸对象（没有 type:node 包着）', async () => {
    const raw = [{ user_id: 20002, nickname: '王五', content: '[CQ:text,text=裸节点也在]' }]
    const r = recorder(raw)

    const text = await expandForward(r.call, { id: '9', inline: undefined }, makeWarn(r.warn))

    expect(text).toContain('- 王五：裸节点也在')
  })

  it('内联节点（数组形态的 data.content）不需要再发一次 API', async () => {
    const r = recorder({ messages: [] })

    const text = await expandForward(r.call, { id: '7788', inline: [node('张三', '内联的')] }, makeWarn(r.warn))

    expect(r.calls).toEqual([])
    expect(text).toContain('- 张三：内联的')
  })

  it('没有昵称时拿 QQ 号当名字（总比给模型一个空标签强）', async () => {
    const r = recorder({ messages: [{ user_id: 555, content: [{ type: 'text', data: { text: '喂' } }] }] })

    expect(await expandForward(r.call, { id: '1', inline: undefined }, () => {})).toContain('- 555：喂')
  })
})

describe('拉不到时的降级（可诊断，不静默吞掉）', () => {
  it('⭐ API 抛错 → 保留占位符 + warn 里带转发 id', async () => {
    const r = recorder(() => {
      throw new Error('API get_forward_msg 返回 status=failed retcode=1200')
    })

    const text = await expandForward(r.call, { id: '7788', inline: undefined }, makeWarn(r.warn))

    expect(text).toBe(FORWARD_PLACEHOLDER)
    expect(r.warn.join('\n')).toContain('7788')
    expect(r.warn.join('\n')).toContain('retcode=1200')
  })

  it('拉到但一个节点都没有 → 同样是占位符 + warn', async () => {
    const r = recorder({ messages: [] })

    expect(await expandForward(r.call, { id: 'abc', inline: undefined }, makeWarn(r.warn))).toBe(FORWARD_PLACEHOLDER)
    expect(r.warn.join('\n')).toContain('abc')
  })

  it('既没有 id 也没有内联节点 → 不调 API，直接占位符 + warn', async () => {
    const r = recorder({ messages: [] })

    const text = await expandForward(r.call, { id: '', inline: undefined }, makeWarn(r.warn))

    expect(text).toBe(FORWARD_PLACEHOLDER)
    expect(r.calls).toEqual([])
    expect(r.warn.join('\n')).toContain('没有 id')
  })

  it('整条消息不被丢掉：文本段照旧在，转发段换成展开结果', async () => {
    const r = recorder({ messages: [node('张三', '八点开门')] })
    const normalized = normalizeMessage('[CQ:forward,id=7788]帮我看看这个')

    const text = await renderInboundText(r.call, normalized.segments, makeWarn(r.warn))

    expect(text).toContain('- 张三：八点开门')
    expect(text).toContain('帮我看看这个')
  })
})

describe('套娃的边界（深度与条数）', () => {
  /** 造一条 `levels` 层深的转发链：每层一条话 + 一个下一层转发。 */
  function chain(levels: number): (action: string, params: Record<string, unknown>) => unknown {
    return (_action, params) => {
      const id = String(params.message_id) // 'L2' / 'L3' …
      const depth = Number(id.slice(1))
      const content: unknown[] = [{ type: 'text', data: { text: `第${depth}层的话` } }]
      if (depth < levels) content.push({ type: 'forward', data: { id: `L${depth + 1}` } })
      return { messages: [{ user_id: 1, nickname: `第${depth}层`, content }] }
    }
  }

  it(`⭐ 深度上限 ${FORWARD_MAX_DEPTH}：超限的那层留占位符，且不再多发 API`, async () => {
    const r = recorder(chain(8))

    const text = await expandForward(r.call, { id: 'L1', inline: undefined }, makeWarn(r.warn))

    // 顶层 + 往下各一层：拉的次数就是深度上限的层数，第 8 层根本不会被问到
    expect(r.calls.length).toBeLessThanOrEqual(FORWARD_MAX_DEPTH)
    expect(text).toContain('- 第1层：第1层的话')
    expect(text).toContain(FORWARD_PLACEHOLDER)
    expect(text).not.toContain('第8层')
  })

  it(`⭐ 条数预算 ${FORWARD_MAX_NODES}：超出的部分如实说"还有 N 条没展开"`, async () => {
    const many = Array.from({ length: FORWARD_MAX_NODES + 5 }, (_, i) => node(`同学${i}`, `第${i}句`))
    const r = recorder({ messages: many })

    const text = await expandForward(r.call, { id: 'big', inline: undefined }, makeWarn(r.warn))

    expect(text).toContain(`共 ${FORWARD_MAX_NODES + 5} 条`)
    expect(text).toContain(`已展开 ${FORWARD_MAX_NODES} 条`)
    expect(text).toContain(`还有 5 条没展开`)
    expect(text).not.toContain('同学' + String(FORWARD_MAX_NODES + 4))
  })

  it('嵌套转发渲染出来带缩进（看得出哪句是被转发的转发）', async () => {
    const r = recorder({}) // 只用它的 warn 收集口，返回值由下面的 byId 给
    const nestedNode = {
      user_id: 1,
      nickname: '外层',
      content: [
        { type: 'text', data: { text: '先看这个' } },
        { type: 'forward', data: { id: 'inner' } },
      ],
    }
    const byId: Record<string, unknown> = {
      outer: { messages: [nestedNode] },
      inner: { messages: [{ user_id: 2, nickname: '里层', content: [{ type: 'text', data: { text: '里边的话' } }] }] },
    }
    const call = async (_action: string, params: Record<string, unknown>) => byId[String(params.message_id)]

    const text = await expandForward(call, { id: 'outer', inline: undefined }, makeWarn(r.warn))

    expect(text).toContain('- 外层：先看这个[转发消息')
    expect(text).toContain('\n  - 里层：里边的话') // 第 2 层缩进两格
  })
})

describe('forwardNodes 的形态容忍', () => {
  it('三种真实返回形状都摊成节点数组，垃圾输入给空表', () => {
    expect(forwardNodes({ messages: [{ type: 'node', data: { nickname: 'a' } }] })).toEqual([{ nickname: 'a' }])
    expect(forwardNodes([{ nickname: 'b' }])).toEqual([{ nickname: 'b' }])
    expect(forwardNodes({ data: [{ nickname: 'c' }] })).toEqual([{ nickname: 'c' }])
    expect(forwardNodes(null)).toEqual([])
    expect(forwardNodes('不是JSON')).toEqual([])
  })

  it('行内空白被压成一格、过长截断，但换行留着（转发块的层次靠换行与缩进）', async () => {
    const long = '啊'.repeat(400)
    const r = recorder({
      messages: [{ user_id: 1, nickname: '长', content: [{ type: 'text', data: { text: `一   二 ${long}` } }] }],
    })

    const text = await expandForward(r.call, { id: 'x', inline: undefined }, makeWarn(r.warn))

    expect(text).toContain('一 二 ')
    expect(text).not.toContain('啊'.repeat(350)) // 每条原话按 300 字截
    expect(text).toMatch(/…$/)
    expect(text.length).toBeLessThan(500)
  })

  it('正文里的换行不会被糊成一行', async () => {
    const r = recorder({
      messages: [{ user_id: 1, nickname: '分行', content: [{ type: 'text', data: { text: '第一行\n第二行' } }] }],
    })

    const text = await expandForward(r.call, { id: 'x', inline: undefined }, makeWarn(r.warn))

    expect(text).toContain('\n第二行')
  })
})
