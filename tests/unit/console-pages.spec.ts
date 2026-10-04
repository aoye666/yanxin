/**
 * 控制台六页的**纯逻辑**用例（T32/T33）。
 *
 * 这些函数都是"输入 → 区块"或"输入 → 判定"，不碰服务也不碰文件 ——
 * 所以能表驱动地测。真正"页挂得上、写进 settings 生效"的部分在
 * `tests/integration/console-pages.spec.ts`。
 */
import { describe, expect, it } from 'vitest'
import { normalizeSenderId, renderAdminsBlocks } from '../../src/console/pages/admins.ts'
import { renderMemoryBlocks } from '../../src/console/pages/memory.ts'
import {
  checkModelRoute,
  modelChoices,
  renderSettingsBlocks,
} from '../../src/console/pages/settings.ts'
import { summarizeEvent, renderTalkBlocks } from '../../src/console/pages/talk.ts'
import { parseWindows, renderWindowBlocks, windowsText } from '../../src/console/pages/window.ts'
import { renderWorldBlocks, viewFrom, worldMissingBlocks } from '../../src/console/pages/world.ts'
import type { WorldStatus } from '../../src/world/engine.ts'

const BASE = '/yanxin'

/** 一个打开好的世界状态（测"正常路径"用）。 */
function readyStatus(): WorldStatus {
  return {
    ready: true,
    tu: 12_345,
    era: 1_790_458_038_648,
    sequence: 7,
    entities: 10,
    actions: 3,
    ticks: 42,
    inbound: 99,
    groupId: '3000000003',
  }
}

const CLOSED: WorldStatus = {
  ready: false,
  tu: null,
  era: null,
  sequence: null,
  entities: null,
  actions: null,
  ticks: 0,
  inbound: 0,
  groupId: '',
}

describe('A) 管理员页：号码规范化 + 名单渲染', () => {
  const cases: Array<[unknown, string | undefined]> = [
    ['2000000001', '2000000001'],
    [' 3000000001 ', '3000000001'],
    ['', undefined],
    ['   ', undefined],
    ['abc', undefined],
    ['123', undefined], // 太短
    ['1234567890123', undefined], // 13 位：太长
    ['2000000001\n', '2000000001'],
    [2000000001, undefined], // 不是字符串：不猜
    [null, undefined],
  ]
  it.each(cases)('%s → %s', (input, expected) => {
    expect(normalizeSenderId(input)).toBe(expected)
  })

  it('空名单：明确说 fail-closed（不是"随便谁都能进"）', () => {
    const text = JSON.stringify(renderAdminsBlocks([], BASE))
    expect(text).toContain('没有任何人是管理员')
    expect(text).toContain('fail-closed')
  })

  it('非空：表格 + 两个表单（加入 / 移出），action 都带 base', () => {
    const blocks = renderAdminsBlocks(['2000000001'], BASE)
    const text = JSON.stringify(blocks)
    expect(text).toContain('当前 1 位管理员')

    const forms = blocks.filter((block) => block.kind === 'form')
    expect(forms).toHaveLength(2)
    expect(JSON.stringify(forms[0])).toContain(`${BASE}/api/admins/add`)
    expect(JSON.stringify(forms[1])).toContain(`${BASE}/api/admins/remove`)
  })
})

describe('B) 时段页：解析', () => {
  const good: Array<[string, { start: string; end: string }[]]> = [
    ['14:00-18:00', [{ start: '14:00', end: '18:00' }]],
    ['14:00-18:00, 22:00-23:30', [{ start: '14:00', end: '18:00' }, { start: '22:00', end: '23:30' }]],
    ['14:00-18:00\n22:00-23:30', [{ start: '14:00', end: '18:00' }, { start: '22:00', end: '23:30' }]],
    [' 14:00 - 18:00 ', [{ start: '14:00', end: '18:00' }]], // 空格容错
    ['22:00-07:00', [{ start: '22:00', end: '07:00' }]], // 跨天是合法的
  ]
  it.each(good)('认得 %s', (input, expected) => {
    expect(parseWindows(input)).toEqual({ ok: true, windows: expected })
  })

  const bad: Array<[string, string]> = [
    ['', '至少要写一个时段'],
    ['   ', '至少要写一个时段'],
    ['下午两点到六点', '看不懂这个时段'],
    ['25:00-26:00', '时间要写成 HH:mm'],
    ['14:60-18:00', '时间要写成 HH:mm'],
    ['14:00-18:00-20:00', '看不懂这个时段'],
    ['14:00-14:00', '开始与结束不能相同'],
  ]
  it.each(bad)('拒绝 %s（原因：%s）', (input, reason) => {
    const parsed = parseWindows(input)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain(reason)
  })

  it('不是字符串也不炸', () => {
    expect(parseWindows(undefined).ok).toBe(false)
    expect(parseWindows(123).ok).toBe(false)
  })

  it('windowsText / parseWindows 往返一致', () => {
    const windows = [
      { start: '14:00', end: '18:00' },
      { start: '22:00', end: '07:00' },
    ]
    expect(parseWindows(windowsText(windows))).toEqual({ ok: true, windows })
  })

  it('页面：开着与关着说的是两件事；表单带当前值', () => {
    const open = JSON.stringify(
      renderWindowBlocks({ windows: [{ start: '14:00', end: '18:00' }], isOpen: true, tickMs: 60_000, engineEntryId: 'yanxin-world-engine' }, BASE),
    )
    expect(open).toContain('开放时段')
    expect(open).toContain('14:00-18:00')
    expect(open).toContain('yanxin-world-engine')

    const closed = JSON.stringify(
      renderWindowBlocks({ windows: [], isOpen: false, tickMs: 60_000, engineEntryId: 'x' }, BASE),
    )
    expect(closed).toContain('关闭时段')
    expect(closed).toContain('引擎不会装载')
  })
})

describe('C) 设置页：模型清单 + 校验', () => {
  const llmPiAi = {
    providers: {
      agnes: { models: [{ id: 'agnes-3.0-flash' }, { id: 'agnes-2.5-pro' }] },
      suotianyi: { models: [{ id: 'deepseek-flash' }] },
      broken: { models: 'not-an-array' },
      empty: {},
    },
  }

  it('从 llm-pi-ai 里抽出可用路由（形状坏了就跳过，不抛）', () => {
    expect(modelChoices(llmPiAi)).toEqual([
      { provider: 'agnes', model: 'agnes-3.0-flash' },
      { provider: 'agnes', model: 'agnes-2.5-pro' },
      { provider: 'suotianyi', model: 'deepseek-flash' },
    ])
    expect(modelChoices(undefined)).toEqual([])
    expect(modelChoices({ providers: 'nope' })).toEqual([])
  })

  it('校验：清单里有才放行', () => {
    const choices = modelChoices(llmPiAi)
    expect(checkModelRoute({ provider: 'agnes', model: 'agnes-3.0-flash' }, choices)).toEqual({
      ok: true,
      route: { provider: 'agnes', model: 'agnes-3.0-flash' },
    })
    const bad = checkModelRoute({ provider: 'agnes', model: 'agnes-9.9' }, choices)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain('网关里没有这条路由')

    expect(checkModelRoute({ provider: '', model: 'x' }, choices).ok).toBe(false)
    expect(checkModelRoute({}, choices).ok).toBe(false)
    // 清单拿不到时**不拦**（页面已警告过"填错会让她不回话"）
    expect(checkModelRoute({ provider: 'any', model: 'thing' }, []).ok).toBe(true)
  })

  it('页面：命名空间表标出"可改 / 专页 / 只读"，并给出可选路由', () => {
    const blocks = renderSettingsBlocks(
      [
        { ns: 'agent-default-model', value: { provider: 'agnes', model: 'agnes-3.0-flash' } },
        { ns: 'yanxin-admin', value: { admins: ['2000000001'] } },
        { ns: 'yanxin-window', value: { windows: [] } },
        { ns: 'llm-pi-ai', value: { providers: {} } },
      ],
      modelChoices(llmPiAi),
      BASE,
    )
    const text = JSON.stringify(blocks)
    expect(text).toContain('**可改**')
    expect(text).toContain('管理员页')
    expect(text).toContain('时段页')
    expect(text).toContain('只读')
    expect(text).toContain('agnes-3.0-flash') // 可选路由表
    const form = blocks.find((block) => block.kind === 'form')
    expect(JSON.stringify(form)).toContain(`${BASE}/api/settings/model`)
  })
})

describe('D) 世界页：投影摘取 + 渲染', () => {
  const observation = {
    placeHandle: 'seen:2',
    entities: [
      { handle: 'seen:1', name: '小研', kind: 'actor', self: true },
      { handle: 'seen:2', name: '小房子', kind: 'place', self: false },
      { handle: 'seen:3', name: '街道', kind: 'place', self: false, distant: true },
      { handle: 'seen:4', name: '日记本', kind: 'object', self: false },
    ],
  }

  it('摘出"在哪儿 + 看得见什么"（远景不算看得见）', () => {
    const view = viewFrom(readyStatus(), observation, ['今天'], false)
    expect(view.place).toBe('小房子')
    expect(view.visible).toContain('小研（actor） ← 她自己')
    expect(view.visible).toContain('日记本（object）')
    expect(view.visible.join('|')).not.toContain('街道')
  })

  it('打开好的世界：TU + 纪元 + 事务数 + 笔记 + 群号', () => {
    const view = viewFrom(readyStatus(), observation, ['今天', '关于光'], false)
    const text = JSON.stringify(renderWorldBlocks(view, BASE))
    expect(text).toContain('12345')
    expect(text).toContain('已提交事务')
    expect(text).toContain('2026-') // 纪元被格式化过
    expect(text).toContain('关于光')
    expect(text).toContain('世界在转') // 一句话状态
    expect(text).toContain('3000000003') // 当前生效的响应群号
  })

  it('暂停中：页面顶部如实说"手动暂停"，开关的当前值也如实在场', () => {
    const view = viewFrom({ ...readyStatus(), ready: false, tu: null, era: null, sequence: null, entities: null, actions: null }, observation, [], true)
    const text = JSON.stringify(renderWorldBlocks(view, BASE))
    expect(text).toContain('手动暂停')
    expect(text).toContain('world/switch')
    expect(text).toContain('"value":"true"') // checkbox 反映当前状态：暂停中是勾上的
  })

  it('没打开的世界：如实说"没打开"，数值显示 —（不是 0）', () => {
    const text = JSON.stringify(renderWorldBlocks({ status: CLOSED, place: null, visible: [], notes: [], paused: false }, BASE))
    expect(text).toContain('没打开')
    expect(text).toContain('"—"')
    expect(text).toContain('本子上还是空的')
  })

  it('引擎卸下时：窗口关着说"不在时段"，其余才说"服务不在"（两种情形不能混）', () => {
    const closed = JSON.stringify(worldMissingBlocks(false))
    expect(closed).toContain('不在开放时段')
    expect(closed).toContain('不是故障')
    expect(closed).not.toContain('服务不在')

    expect(JSON.stringify(worldMissingBlocks(true))).toContain('服务不在')
    expect(JSON.stringify(worldMissingBlocks(undefined))).toContain('服务不在')
  })
})

describe('E) 记忆页：健康 + 溯源', () => {
  it('后端坏掉时说的是"降级"，不是"出错"', () => {
    const text = JSON.stringify(
      renderMemoryBlocks({ providerId: 'reme', health: { ok: false, detail: '连不上 127.0.0.1:2333' } }, BASE),
    )
    expect(text).toContain('后端不可用')
    expect(text).toContain('增强不是依赖')
    expect(text).toContain('连不上')
  })

  it('没填词就不发空查询', () => {
    const text = JSON.stringify(renderMemoryBlocks({ health: { ok: true } }, BASE))
    expect(text).toContain('填一个词再点检索')
  })

  it('有词有结果：表格里带来源/行/会话（溯源），空结果也是一行', () => {
    const withHits = JSON.stringify(
      renderMemoryBlocks(
        {
          providerId: 'reme',
          health: { ok: true },
          query: '光',
          hits: [
            { content: '下午的光斜进来', source: 'daily/2026-09-27.md', lines: [3, 5], score: 0.82, sessionId: 'world:3000000001' },
          ],
        },
        BASE,
      ),
    )
    expect(withHits).toContain('daily/2026-09-27.md')
    expect(withHits).toContain('3–5')
    expect(withHits).toContain('world:3000000001')
    expect(withHits).toContain('的结果（1 条）')

    const empty = JSON.stringify(renderMemoryBlocks({ health: { ok: true }, query: '不存在的词', hits: [] }, BASE))
    expect(empty).toContain('没有命中')
    expect(empty).toContain('的结果（0 条）')
  })
})

describe('F) 对话页：事件摘要', () => {
  it('入站消息：带模式 / 群 / 发送者（那是溯源）', () => {
    const row = summarizeEvent({
      type: 'user/message',
      seq: 3,
      time: 1_790_458_000_000,
      data: {
        message: {
          content: [{ type: 'text', text: '早上好' }],
          source: { kind: 'qq', mode: 'agent', groupId: '3000000003', userId: '2000000001' },
        },
      },
    })
    expect(row.type).toBe('user/message')
    expect(row.at).toBe(1_790_458_000_000)
    expect(row.text).toContain('【agent】')
    expect(row.text).toContain('群 3000000003')
    expect(row.text).toContain('早上好')
  })

  it('私聊消息：说"私聊"而不是空群号', () => {
    const row = summarizeEvent({
      type: 'user/message',
      data: { message: { content: [{ type: 'text', text: '在吗' }], source: { kind: 'qq', mode: 'admin', userId: '2000000001' } } },
    })
    expect(row.text).toContain('私聊')
  })

  it('工具调用与结果', () => {
    expect(summarizeEvent({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } }).text).toBe(
      'bash({"command":"ls"})',
    )
    expect(summarizeEvent({ type: 'tool/result', data: {} }).text).toBe('ok')
    expect(summarizeEvent({ type: 'tool/result', data: { error: { code: 'TOOL_DENIED' } } }).text).toContain('失败')
  })

  it('负载是扁平的也能认（上游形态变过）', () => {
    expect(summarizeEvent({ type: 'tool/call', name: 'bash', arguments: 'x' }).text).toBe('bash(x)')
  })

  it('不认识的东西只显示类型，不抛', () => {
    expect(summarizeEvent({ type: 'mystery/thing' })).toEqual({ at: null, type: 'mystery/thing', text: '' })
    expect(summarizeEvent(null)).toEqual({ at: null, type: '?', text: '' })
    expect(summarizeEvent('字符串')).toEqual({ at: null, type: '?', text: '' })
  })
})

describe('G) 对话页：页面形态', () => {
  it('没有活着的会话：说明白（不是空白页）', () => {
    const text = JSON.stringify(renderTalkBlocks({ sessions: [] }, BASE))
    expect(text).toContain('没有活着的会话')
  })

  it('有会话：每个会话一个链接（点进去看时间轴）', () => {
    const blocks = renderTalkBlocks({ sessions: ['admin:2000000001', 'world:3000000001'] }, BASE)
    const links = blocks.filter((block) => block.kind === 'link')
    expect(links).toHaveLength(2)
    expect(JSON.stringify(links[0])).toContain(`${BASE}/talk?session=admin%3A2000000001`)
  })

  it('选中会话：时间轴 + 截断时给"显示全部"', () => {
    const rows = Array.from({ length: 3 }, (_v, index) => ({ at: 1_790_458_000_000 + index, type: 'x', text: `第 ${index} 条` }))
    const truncated = JSON.stringify(renderTalkBlocks({ sessions: ['s'], selected: 's', rows, total: 99, shownAll: false }, BASE))
    expect(truncated).toContain('最近 3 / 共 99 条')
    expect(truncated).toContain('显示全部')

    const all = JSON.stringify(renderTalkBlocks({ sessions: ['s'], selected: 's', rows, total: 3, shownAll: true }, BASE))
    expect(all).toContain('全部 3 条')
    expect(all).not.toContain('显示全部')
  })

  it('会话不在活着的列表里：给一句可理解的话 + 限度说明', () => {
    const text = JSON.stringify(renderTalkBlocks({ sessions: ['a'], selected: 'b', note: '会话 b 不在活着的列表里（重启后历史在磁盘上，这一页只覆盖本进程）。' }, BASE))
    expect(text).toContain('只覆盖本进程')
  })

  it('会话里没事件：直说，不显示空表格', () => {
    const text = JSON.stringify(renderTalkBlocks({ sessions: ['s'], selected: 's', rows: [], total: 0 }, BASE))
    expect(text).toContain('还没有事件')
  })
})