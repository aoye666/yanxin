/**
 * 召回注入的措辞与"不留痕迹"（T16 的纯逻辑部分）。
 *
 * 这些断言看着琐碎，但每一条都对应一种**会以最难查的方式出错**的退化：
 *
 *   · 空召回留下空行/占位符 → prompt 与无记忆时不一致（验收要求**逐字节相同**），
 *     而且会教模型"你有记忆机制"→ 小研开始元叙述（它的人格明确禁止这个）；
 *   · markdown 不压平 → 模型把记忆当成"用户写了这些东西"，当成用户的话来回应；
 *   · 不截断 → 一条记忆吃掉整个上下文。
 */
import { describe, expect, it } from 'vitest'
import { renderMemories, withMemories } from '../../src/memory/inject.ts'

const MESSAGE = '[群 3000000003 · 鹤(2000000003)] 游戏好玩'

describe('renderMemories —— 措辞与形态', () => {
  it('空召回 → 空串（调用方据此判断"什么都没加"）', () => {
    expect(renderMemories([])).toBe('')
  })

  it('内容为空白的条目被丢掉（不让空行混进 prompt）', () => {
    expect(renderMemories([{ content: '   ', source: 'x' }])).toBe('')
    expect(renderMemories([{ content: '\n\n', source: 'x' }])).toBe('')
  })

  it('有召回 → 一段"你记得这些"，每条一个 `- ` 项', () => {
    const rendered = renderMemories([
      { content: '爸爸是高三学生', source: 'a.md' },
      { content: '喜欢 MyGO', source: 'b.md' },
    ])

    expect(rendered).toContain('你记得这些')
    expect(rendered).toContain('- 爸爸是高三学生')
    expect(rendered).toContain('- 喜欢 MyGO')
  })

  it('⚠️ 用第一人称"你记得"，不用"检索/匹配/知识库"这类工程词', () => {
    const rendered = renderMemories([{ content: 'x', source: 's' }])

    for (const word of ['检索', '匹配', '知识库', '数据库', '搜索结果', 'memory']) {
      expect(rendered.includes(word), `不该出现工程词「${word}」`).toBe(false)
    }
  })

  it('markdown 被压平成单行（标题符号、列表符号、换行都去掉）', () => {
    const rendered = renderMemories([
      { content: '## 关于爸爸\n\n- 高三学生\n- 喜欢 MyGO\n', source: 'a.md' },
    ])

    expect(rendered).toContain('- 关于爸爸 高三学生 喜欢 MyGO')
    // 压平后不该还有独立的标题行
    expect(rendered).not.toContain('##')
  })

  it('单条超长时截断并加省略号（一条记忆不该吃掉整个上下文）', () => {
    const rendered = renderMemories([{ content: 'x'.repeat(1000), source: 'a.md' }])

    const line = rendered.split('\n').find((candidate) => candidate.startsWith('- ')) ?? ''
    expect(line.length).toBeLessThan(400)
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('renderMemories —— session 溯源翻成人话', () => {
  it.each([
    ['agent:3000000001:group:3000000003', '[群 3000000003] '],
    ['agent:3000000001:private:2000000001', '[私聊] '],
    ['admin:2000000001', '[管理员私聊] '],
    ['world:3000000001', '[世界] '],
  ])('%s → %s', (sessionId, label) => {
    expect(renderMemories([{ content: '内容', source: 's', sessionId }])).toContain(`- ${label}内容`)
  })

  it('⚠️ 绝不让模型看到工程格式的 session id', () => {
    const rendered = renderMemories([
      { content: '内容', source: 's', sessionId: 'agent:3000000001:group:3000000003' },
    ])

    expect(rendered).not.toContain('agent:')
    expect(rendered).not.toContain('3000000001')
  })

  it('认不出的形态**不标**（宁可少一个标签，也不泄漏内部格式）', () => {
    const rendered = renderMemories([{ content: '内容', source: 's', sessionId: 'session-51a7fed9' }])

    expect(rendered).toContain('- 内容')
    expect(rendered).not.toContain('session-51a7fed9')
  })

  it('没有 sessionId 时也不标（不是所有后端都给溯源）', () => {
    expect(renderMemories([{ content: '内容', source: 's' }])).toContain('- 内容')
  })
})

describe('withMemories —— 召回为空时必须逐字节一致', () => {
  it('⚠️ 空记忆 → **原样返回**（一个字节都不加）', () => {
    expect(withMemories(MESSAGE, '')).toBe(MESSAGE)
  })

  it('有记忆 → 记忆在前、消息在后，中间空一行', () => {
    const memories = renderMemories([{ content: '喜欢 MyGO', source: 'a.md' }])

    expect(withMemories(MESSAGE, memories)).toBe(`${memories}\n\n${MESSAGE}`)
  })

  it('空记忆与有记忆的差别只在"多了那段背景"，原消息部分完整保留', () => {
    const memories = renderMemories([{ content: '喜欢 MyGO', source: 'a.md' }])
    const withRecall = withMemories(MESSAGE, memories)

    expect(withRecall.endsWith(MESSAGE)).toBe(true)
  })
})
