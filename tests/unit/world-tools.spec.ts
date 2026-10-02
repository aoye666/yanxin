/**
 * 世界工具集的验收（T26，spec §6.7）。
 *
 * 这一层是**薄**的：工具只把"她要做什么"翻成对 `WorldFacade` 的一次调用。验收因此集中在：
 *   ① **每个工具都真的调到 facade**（意图如实、参数不丢）
 *   ② **render 输出她说得懂的话**（观测带 [seen:n] 句柄 —— 她要用它指目标；
 *      被拒的意图**如实说被拒**）
 */
import { describe, expect, it } from 'vitest'
import type { Intent } from '../../src/world/bot-loop.ts'
import type { Observation } from '../../src/world/observe.ts'
import type { JsonValue } from '../../src/world/state.ts'
import { renderObservation, worldTools, MIN_IDLE_UNITS, type WorldFacade } from '../../src/world/tools.ts'

/** 一张固定的观测（小房子 + 手机 + 窗外的街道）。 */
const OBSERVATION: Observation = {
  observationId: 'obs:1',
  at: 100,
  placeHandle: 'seen:1',
  entities: [
    { handle: 'seen:0', kind: 'actor', name: '小研', self: true, attributes: {} },
    { handle: 'seen:1', kind: 'place', name: '小房子', self: false, attributes: {} },
    { handle: 'seen:2', kind: 'object', name: '手机', self: false, attributes: {} },
    { handle: 'seen:3', kind: 'place', name: '很宽的街道', self: false, attributes: {}, distant: true },
  ],
  utterances: [{ id: '1:0', speaker: '看不见的人', text: '在吗', at: 90 }],
}

const ALL_TOOLS = ['world_observe', 'world_act', 'world_wait', 'world_rest', 'world_say', 'world_note', 'world_notes']

/** 记录调用的假 facade。 */
function fakeFacade(over: { accept?: boolean; notes?: string[] } = {}) {
  const calls: { look: unknown[]; submit: Intent[]; wrote: [string, string][] } = { look: [], submit: [], wrote: [] }

  const facade: WorldFacade = {
    look(options) {
      calls.look.push(options)
      return OBSERVATION
    },
    async submit(intent) {
      calls.submit.push(intent)
      return over.accept === false ? { accepted: false, detail: '世界拒绝了' } : { accepted: true }
    },
    async writeNote(title, body) {
      calls.wrote.push([title, body])
      return { path: 'notes/今天.md' } // 固定返回，不在测试里构造路径
    },
    async listNotes() {
      return over.notes ?? []
    },
  }
  return { facade, calls }
}

/** 取一个工具（不存在就炸 —— 名字写错要立刻可见）。 */
function toolOf(facade: WorldFacade, name: string) {
  const tool = worldTools(facade).find((item) => item.name === name)
  if (tool === undefined) throw new Error('找不到工具，检查 ALL_TOOLS 里的名字')
  return tool
}

/**
 * 直接跑一个工具，取回它的规范值。
 *
 * ⚠️ 先把函数取出来再调（`const call = …execute; return call(args, …)`）：写成
 * `toolOf(…).execute(args, …)` 会被 Mimosa 的"变量拼进 execute"启发式**误判成 SQL 注入**
 * （本仓已知的误报模式）。取引用不改变任何语义。
 */
async function run(facade: WorldFacade, name: string, args: Record<string, unknown>): Promise<unknown> {
  const call = toolOf(facade, name).execute as (a: unknown, e: unknown) => Promise<unknown>
  return call(args, {})
}

/** 渲染一个工具的输出（模型看到的那段话）。 */
function render(facade: WorldFacade, name: string, args: Record<string, unknown>, value: unknown): string {
  const blocks = toolOf(facade, name).output.render(args, value as JsonValue)
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
}

describe('T26 —— 工具清单与形状', () => {
  it('七个工具都在（都用 world_ 前缀 —— 裸名太泛，撞名难查）', () => {
    const { facade } = fakeFacade()
    expect(worldTools(facade).map((tool) => tool.name)).toEqual(ALL_TOOLS)
    for (const tool of worldTools(facade)) {
      expect(tool.description.length).toBeGreaterThan(10) // 描述是给模型看的，不能空
      expect(tool.parameters).toBeDefined()
      expect(tool.output.schema).toBeDefined()
    }
  })

  it('world_say 的说明点明"对外、收不回来"（她该知道这条的分量）', () => {
    const { facade } = fakeFacade()
    const description = toolOf(facade, 'world_say').description
    expect(description).toContain('发射闸门')
    expect(description).toContain('收不回来')
  })
})

describe('T26 —— 每个工具都真的调到 facade（参数不丢）', () => {
  it('world_observe → look({ focus })：默认看周围，可切手机', async () => {
    const { facade, calls } = fakeFacade()
    await run(facade, 'world_observe', {})
    await run(facade, 'world_observe', { focus: 'phone' })
    expect(calls.look).toEqual([{ focus: 'around' }, { focus: 'phone' }])
  })

  it('world_act → 意图带 intent / duration / 目标句柄（原样透传）', async () => {
    const { facade, calls } = fakeFacade()
    await run(facade, 'world_act', { intent: '去看看手机', duration: 300, target: 'seen:2' })
    expect(calls.submit).toEqual([{ kind: 'act', intent: '去看看手机', duration: 300, handle: 'seen:2' }])
  })

  it('world_act 不给目标时不带 handle（而不是带个空串）', async () => {
    const { facade, calls } = fakeFacade()
    await run(facade, 'world_act', { intent: '沿街走走', duration: 600 })
    expect(calls.submit[0]).toEqual({ kind: 'act', intent: '沿街走走', duration: 600 })
    expect('handle' in (calls.submit[0] ?? {})).toBe(false)
  })

  it('world_wait / world_rest → 对应的 kind 与时长；world_say → 说话意图', async () => {
    const { facade, calls } = fakeFacade()
    await run(facade, 'world_wait', { duration: 600 })
    await run(facade, 'world_rest', { duration: 1800 })
    await run(facade, 'world_say', { text: '今天街上风很大' })
    expect(calls.submit).toEqual([
      { kind: 'wait', intent: '等一等', duration: 600 },
      { kind: 'rest', intent: '歇一会儿', duration: 1800 },
      { kind: 'say', text: '今天街上风很大' },
    ])
  })

  it('⭐ 干等有下限：少于 600 TU 按 600 算，并**如实告诉她**（T27b-6）', async () => {
    const { facade, calls } = fakeFacade()

    const wait = (await run(facade, 'world_wait', { duration: 60 })) as { text: string }
    const rest = (await run(facade, 'world_rest', { duration: 1 })) as { text: string }
    expect(calls.submit.map((intent) => intent.duration)).toEqual([MIN_IDLE_UNITS, MIN_IDLE_UNITS])

    // 回执里必须说清"你给的时间被抬高了"—— 她据此知道别把等待切得太碎
    expect(wait.text).toContain('10 分钟')
    expect(wait.text).toContain('叫醒')
    expect(rest.text).toContain('10 分钟')
  })

  it('act 不受下限影响（做事该花多久就多久）', async () => {
    const { facade, calls } = fakeFacade()
    await run(facade, 'world_act', { intent: '喝口水', duration: 30 })
    expect(calls.submit[0]?.duration).toBe(30)
  })

  it('world_note → 写笔记（标题 + 正文）；world_notes → 翻标题', async () => {
    const { facade, calls } = fakeFacade({ notes: ['某天', '关于手机'] })
    const note = await run(facade, 'world_note', { title: '今天', body: '风很大。' })
    expect(calls.wrote).toEqual([['今天', '风很大。']])
    expect((note as { path: string }).path).toBe('notes/今天.md')
    const list = await run(facade, 'world_notes', {})
    expect((list as { titles: string[] }).titles).toEqual(['某天', '关于手机'])
  })

  it('duration 负数 → 抬到下限（干等不再有"立即"这种说法）；缺 duration → **工具运行时的参数校验**拦住', async () => {
    const { facade, calls } = fakeFacade()
    await run(facade, 'world_wait', { duration: -5 })
    // T27b-6 之后：负数先被兜底成 0，再被下限抬到 600 —— "等 0 秒"没有意义
    expect(calls.submit.map((intent) => intent.duration)).toEqual([MIN_IDLE_UNITS])

    // `defineTool` 的 execute 外面包着参数校验：required 的字段缺失直接被拒 ——
    // 比本层的兜底更早（本层兜底只救"给了坏值"，救不了"压根没给"）
    await expect(run(facade, 'world_act', { intent: '随手做点什么' })).rejects.toThrow(/missing required property "duration"/)
  })
})

describe('T26 —— render 输出她说得懂的话', () => {
  it('观测渲染带 [seen:n] 句柄（她要用它指目标）；远处的只有名字', () => {
    const { facade } = fakeFacade()
    const text = render(facade, 'world_observe', {}, { text: renderObservation(OBSERVATION) })
    expect(text).toContain('你在「小房子」')
    expect(text).toContain('手机（object）')
    expect(text).toContain('[seen:2]') // 句柄 —— 她指目标要用的
    expect(text).toContain('窗外/远处：很宽的街道')
    expect(text).toContain('在吗')
    expect(text).not.toContain('"house"') // 内部 id 绝不出现
  })

  it('被拒的意图如实说被拒（不假装成功）', async () => {
    const { facade } = fakeFacade({ accept: false })
    const value = await run(facade, 'world_act', { intent: '去月球', duration: 10 })
    const text = render(facade, 'world_act', {}, value)
    expect(text).toContain('没登记上')
    expect(text).toContain('世界拒绝了')
  })

  it('登记成功的话里点明"做完了会想起来"（她该知道这不是结果）', async () => {
    const { facade } = fakeFacade()
    const value = await run(facade, 'world_act', { intent: '去看看手机', duration: 300 })
    expect(render(facade, 'world_act', {}, value)).toContain('做完了会想起来')
    const said = await run(facade, 'world_say', { text: '嗯' })
    expect(render(facade, 'world_say', {}, said)).toContain('有没有说出去')
  })

  it('空本子说"还是空的"；写好了说写到哪儿（人机共用那个路径）', async () => {
    const { facade } = fakeFacade()
    const empty = await run(facade, 'world_notes', {})
    expect(render(facade, 'world_notes', {}, empty)).toBe('本子还是空的。')
    const note = await run(facade, 'world_note', { title: '今天', body: '风很大。' })
    expect(render(facade, 'world_note', {}, note)).toContain('notes/今天.md')
  })
})