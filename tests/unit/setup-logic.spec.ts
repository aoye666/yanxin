/**
 * 向导纯逻辑的验收（T28a，spec §6.11）。
 *
 * 这里唯一值得测的东西是**两个真相来源不一致时怎么办**：
 * 落盘的记录说"我做过了"，现场的证据说"没有"。因此每条用例都在构造一种不一致，
 * 断言状态**如实退回**（而不是乐观地相信自己写过的那个数字）。
 *
 * 最坏的那个状态是"界面显示就绪、agent 顶着空人格跑起来污染记忆" —— T30 的拦截依赖
 * 这里的判定，所以最后一条用例专门盯它。
 */
import { describe, expect, it } from 'vitest'
import {
  emptyRecord,
  evaluateStep,
  isRunnable,
  markCompleted,
  nextStep,
  parseRecord,
  reconcile,
  resetTo,
  warnings,
  withAccountId,
  type SetupEvidence,
  type SetupRecord,
} from '../../src/setup/logic.ts'
import { SETUP_STEPS, stepIndex, type SetupStep } from '../../src/setup/types.ts'

const AT = 1_800_000_000_000

/** 全部成立的现场（各用例只改需要的字段）。 */
function evidence(over: Partial<SetupEvidence> = {}): SetupEvidence {
  return {
    persona: { base: true, profile: true, world: true },
    presets: { installed: 3, total: 3 },
    world: { transactions: 4, clock: true },
    accounts: { registered: ['10001'], connected: ['10001'] },
    ...over,
  }
}

/** 全部完成且证据齐全的记录。 */
function readyRecord(over: Partial<SetupRecord> = {}): SetupRecord {
  return { schemaVersion: 1, completed: [...SETUP_STEPS], accountId: '10001', updatedAt: AT, ...over }
}

describe('T28a —— 状态 = 记录 ∩ 证据（按顺序取最长前缀）', () => {
  const cases: { name: string; record: SetupRecord; evidence: SetupEvidence; status: string; next: SetupStep | null }[] = [
    {
      name: '全新：什么都没做 → init，下一步是 persona',
      record: emptyRecord(AT),
      evidence: evidence({ persona: { base: false, profile: false, world: false }, presets: { installed: 0, total: 3 }, world: { transactions: 0, clock: false }, accounts: { registered: [], connected: [] } }),
      status: 'init',
      next: 'persona',
    },
    {
      name: '只做了 persona → persona，下一步 background',
      record: { ...emptyRecord(AT), completed: ['persona'] },
      evidence: evidence({ persona: { base: true, profile: false, world: false }, world: { transactions: 0, clock: false }, accounts: { registered: [], connected: [] } }),
      status: 'persona',
      next: 'background',
    },
    {
      name: '四步全做完且证据齐全 → ready',
      record: readyRecord(),
      evidence: evidence(),
      status: 'ready',
      next: null,
    },
    {
      name: '⭐ 记录说 ready，但人格文件不见了 → 退回 init（不许显示就绪）',
      record: readyRecord(),
      evidence: evidence({ persona: { base: false, profile: true, world: true }, presets: { installed: 0, total: 3 } }),
      status: 'init',
      next: 'persona',
    },
    {
      name: '⭐ 记录说 ready，但世界没了（人格还在）→ 退到 background，下一步重做 world',
      record: readyRecord(),
      evidence: evidence({ world: { transactions: 0, clock: false } }),
      status: 'background',
      next: 'world',
    },
    {
      name: '⭐ 记录说 ready，但预设没装齐 → 退到之前（人格装上了但没生效，等于没装）',
      record: readyRecord(),
      evidence: evidence({ presets: { installed: 2, total: 3 } }),
      status: 'init',
      next: 'persona',
    },
    {
      name: '⭐ presets total = 0（打包损坏）→ 0/0 不等于装齐，照样拦（否则守卫放行、报错指向错的方向）',
      record: readyRecord(),
      evidence: evidence({ presets: { installed: 0, total: 0 } }),
      status: 'init',
      next: 'persona',
    },
    {
      name: '账号还没选定 → 状态停在 world（前序都成立）',
      record: { ...readyRecord(), completed: ['persona', 'background', 'world'], accountId: undefined },
      evidence: evidence(),
      status: 'world',
      next: 'accounts',
    },
    {
      name: '账号选错了（不在注册表里）→ 同样停在 world',
      record: { ...readyRecord(), completed: ['persona', 'background', 'world'], accountId: '99999' },
      evidence: evidence(),
      status: 'world',
      next: 'accounts',
    },
    {
      name: '⚠️ 协议端没连上**不算**未完成（那是告警不是拦路）',
      record: readyRecord(),
      evidence: evidence({ accounts: { registered: ['10001'], connected: [] } }),
      status: 'ready',
      next: null,
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = reconcile(testCase.record, testCase.evidence)
      expect(result.status).toBe(testCase.status)
      expect(result.next).toBe(testCase.next)
    })
  }

  it('⭐ "被前序挡住"与"证据消失"要分清：前者不算 reverted', () => {
    // 世界没了，但账号那步记录的选定仍然成立 —— 它只是**排在后面**，不是失效了
    const result = reconcile(readyRecord(), evidence({ world: { transactions: 0, clock: false } }))
    expect(result.reverted).toEqual(['world'])
    expect(result.reverted).not.toContain('accounts')
  })

  it('reverted 会列出所有"做过但现在不成立"的步骤（人格与世界同时丢）', () => {
    const result = reconcile(
      readyRecord(),
      evidence({ persona: { base: false, profile: false, world: false }, presets: { installed: 0, total: 3 }, world: { transactions: 0, clock: false } }),
    )
    expect(result.reverted).toEqual(['persona', 'background', 'world'])
  })

  it('下一步的推导与状态一致（nextStep 是同一张表）', () => {
    expect(nextStep('init')).toBe('persona')
    expect(nextStep('persona')).toBe('background')
    expect(nextStep('background')).toBe('world')
    expect(nextStep('world')).toBe('accounts')
    expect(nextStep('ready')).toBeNull()
  })
})

describe('T28a —— 缺什么要说人话（可操作）', () => {
  it('每一步的 missing 都指向具体文件或配置项', () => {
    const bare = reconcile(
      emptyRecord(AT),
      evidence({ persona: { base: false, profile: false, world: false }, presets: { installed: 0, total: 3 }, world: { transactions: 0, clock: false }, accounts: { registered: [], connected: [] } }),
    )
    const lines = bare.steps.flatMap((state) => state.missing).join('\n')

    expect(lines).toContain('persona/base.md')
    expect(lines).toContain('profile.md')
    expect(lines).toContain('clock.json')
    expect(lines).toContain('preset')
    expect(lines).toContain('事务')
    expect(lines).toContain('selfId')
  })

  it('账号没选定与选定但不在注册表里，给的是两句不同的话', () => {
    const noChoice = evaluateStep('accounts', evidence(), emptyRecord(AT))
    const wrongChoice = evaluateStep('accounts', evidence({ accounts: { registered: ['1'], connected: [] } }), withAccountId(emptyRecord(AT), '2', AT))

    expect(noChoice.missing.join()).toContain('还没指定')
    expect(wrongChoice.missing.join()).toContain('不在账号注册表里')
  })

  it('告警（不拦 ready）与缺失（拦）分开', () => {
    const record = readyRecord()
    expect(warnings(evidence({ accounts: { registered: ['10001'], connected: [] } }), record)).toEqual([
      expect.stringContaining('还没有反连'),
    ])
    expect(warnings(evidence(), record)).toEqual([])
    expect(warnings(evidence({ accounts: { registered: [], connected: [] } }), { ...record, accountId: undefined })).toEqual([
      expect.stringContaining('一个 QQ 账号都没注册'),
    ])
  })
})

describe('T28a —— 回退与推进', () => {
  it('⭐ 回退到某一步：清掉它及其后的完成记录（可重跑）', () => {
    const after = resetTo(readyRecord(), 'world', AT + 1)

    expect(after.completed).toEqual(['persona', 'background'])
    expect(after.accountId).toBeUndefined() // accounts 排在世界之后，一起作废
    expect(after.updatedAt).toBe(AT + 1)
  })

  it('回退到 accounts 只清它自己（世界与人格都留着）', () => {
    const after = resetTo(readyRecord(), 'accounts', AT + 1)
    expect(after.completed).toEqual(['persona', 'background', 'world'])
    expect(after.accountId).toBeUndefined()
  })

  it('回退到 persona 等于重来（但**不删文件** —— 重跑的语义是覆盖）', () => {
    const after = resetTo(readyRecord(), 'persona', AT + 1)
    expect(after.completed).toEqual([])
  })

  it('标记完成按顺序规范化，且重复标记不产生第二条', () => {
    const first = markCompleted(emptyRecord(AT), 'background', AT + 1)
    expect(first.completed).toEqual(['background'])
    const both = markCompleted(markCompleted(emptyRecord(AT), 'background', AT + 1), 'persona', AT + 2)
    expect(both.completed).toEqual(['persona', 'background']) // 顺序按 SETUP_STEPS，不看标记先后
    expect(both.updatedAt).toBe(AT + 2)
  })

  it('⭐ 能不能跑只看**现场**（记录只是账本）：现场都成立时后面的步骤也能跑', () => {
    // 现场全成立、记录空 —— 这正是"人格是手工装的"那种状态：
    // 后面的步骤**不该**被账本拦住（否则 STEP_BLOCKED 会把"缺什么"报成全世界缺的东西）
    const satisfied = reconcile(emptyRecord(AT), evidence())
    expect(isRunnable('persona', satisfied)).toBe(true)
    expect(isRunnable('background', satisfied)).toBe(true)
    expect(isRunnable('world', satisfied)).toBe(true)
    // accounts 也能跑（前序都在）——它**自己的输入**（选哪个 QQ 号）由那一步的动作校验
    // （没给就 BAD_INPUT），不归"能不能跑"管：能跑 ≠ 参数齐
    expect(isRunnable('accounts', satisfied)).toBe(true)
  })

  it('⭐ 前序的**现场**不成立时，后面的步骤不能跑（该拦的仍然拦得住）', () => {
    const broken = reconcile(emptyRecord(AT), evidence({ world: { transactions: 0, clock: false } }))
    expect(isRunnable('persona', broken)).toBe(true)
    expect(isRunnable('background', broken)).toBe(true)
    expect(isRunnable('world', broken)).toBe(true) // 它自己就是那一步
    expect(isRunnable('accounts', broken)).toBe(false) // 世界不成立 → 绑账号没有意义
  })

  it('前序证据不成立时，后面的步骤不能跑（先把人格装回来）', () => {
    const broken = reconcile(
      { ...readyRecord(), completed: ['persona', 'background'] },
      evidence({ persona: { base: false, profile: true, world: true }, presets: { installed: 0, total: 3 } }),
    )
    expect(isRunnable('background', broken)).toBe(false)
  })
})

describe('T28a —— 落盘记录的解析（坏值不掩盖）', () => {
  it('正常记录能还原，顺序被规范化；selfId 是已删的旧字段，解析时丢弃', () => {
    const parsed = parseRecord({ schemaVersion: 1, completed: ['world', 'persona'], accountId: '7', selfId: 'yanxin', updatedAt: AT }, AT)
    expect(parsed).toBeDefined()
    expect(parsed?.completed).toEqual(['persona', 'world'])
    expect(parsed?.accountId).toBe('7')
    expect(parsed).not.toHaveProperty('selfId')
  })

  it('未知步骤被过滤掉（旧版本写过的步骤名不该让整个记录作废）', () => {
    const parsed = parseRecord({ schemaVersion: 1, completed: ['persona', '考古学'], updatedAt: AT }, AT)
    expect(parsed?.completed).toEqual(['persona'])
  })

  it('重复步骤被去重（手改文件写重复不该改变语义）', () => {
    const parsed = parseRecord({ schemaVersion: 1, completed: ['persona', 'persona'], updatedAt: AT }, AT)
    expect(parsed?.completed).toEqual(['persona'])
  })

  it('形状不对（版本不符 / completed 不是数组 / 根本不是对象）→ undefined（服务会 warn，不当成有效记录）', () => {
    expect(parseRecord(null, AT)).toBeUndefined()
    expect(parseRecord('{}', AT)).toBeUndefined()
    expect(parseRecord({ schemaVersion: 2, completed: [] }, AT)).toBeUndefined()
    expect(parseRecord({ schemaVersion: 1, completed: 'all' }, AT)).toBeUndefined()
  })

  it('accountId 缺省时不写空串（"没选"与"选了空"是两件事）；旧记录里的 selfId 死字段被丢弃', () => {
    const parsed = parseRecord({ schemaVersion: 1, completed: [], updatedAt: AT }, AT)
    expect(parsed).not.toHaveProperty('accountId')
    // selfId 曾经落盘过（后证实全仓只写不读，连同写入路径一起删除）—— 解析时静默丢弃
    const legacy = parseRecord({ schemaVersion: 1, completed: [], selfId: 'yanxin', updatedAt: AT }, AT)
    expect(legacy).not.toHaveProperty('selfId')
  })
})

describe('T28a —— 步骤表本身', () => {
  it('顺序是固定的四步，且索引单调（顺序即依赖）', () => {
    expect([...SETUP_STEPS]).toEqual(['persona', 'background', 'world', 'accounts'])
    expect(SETUP_STEPS.map(stepIndex)).toEqual([0, 1, 2, 3])
  })
})