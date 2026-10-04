/**
 * 世界内核的验收（T20，spec §6.7 / ADR 0015）。
 *
 * 这条内核存在的唯一理由：**模型写不出自洽的世界，所以让它只提案**。
 * 因此本文件的重点是**四类校验的反证**（每类都要证明"该拒的真的拒了，且拒得有理由"）：
 *
 *   ① 类目合法 —— 未知操作拒
 *   ② 引用完整性 —— 悬空引用 / 类型不符 / 成环拒（**但同批前向引用要放行**）
 *   ③ 幂等 —— 同键重复提交只生效一次
 *   ④ 乐观并发 —— 版本不符拒（防"基于旧感知改新状态"）
 *
 * 外加两条"内核的自洽"：**重放等价**（日志是权威）与**崩溃语义**
 * （只有最后一行能容忍不完整；提交前崩溃 = 世界没变）。
 *
 * ⚠️ 断言要打在**机读诊断**上（`code` / `reason`）—— 那是模型据以自我修正的东西，
 * 只断言"抛了个错"等于没测这条链路能不能闭合。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KernelError } from '../../src/world/error.ts'
import { TRANSACTION_LOG, WorldKernel } from '../../src/world/kernel.ts'
import type { TransactionProposal, WorldOperation } from '../../src/world/state.ts'

const dirs: string[] = []
const warnings: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
  warnings.length = 0
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yanxin-world-'))
  dirs.push(dir)
  return dir
}

function openWorld(dir: string, options: Parameters<typeof WorldKernel.open>[1] = {}): Promise<WorldKernel> {
  return WorldKernel.open(dir, { warn: (message) => warnings.push(message), ...options })
}

/** 一个提案（默认空操作，便于只改一处做对照）。 */
function proposal(operations: WorldOperation[], over: Partial<TransactionProposal> = {}): TransactionProposal {
  return { idempotencyKey: `key-${Math.random().toString(36).slice(2)}`, operations, ...over }
}

/** 创世：小研（actor）+ 房子（place）+ 手机（object）。 */
function genesis(): TransactionProposal {
  return proposal(
    [
      { op: 'create', entity: { id: 'bot', kind: 'actor', name: '小研', location: 'house' } },
      { op: 'create', entity: { id: 'house', kind: 'place', name: '小房子', location: null } },
      { op: 'create', entity: { id: 'street', kind: 'place', name: '很宽的街道', location: null } },
      { op: 'create', entity: { id: 'phone', kind: 'object', name: '手机', location: 'house', owner: 'bot' } },
    ],
    { idempotencyKey: 'genesis-1', source: 'bootstrap' },
  )
}

/** 断言一次提交被拒，返回诊断列表。 */
async function expectRejected(kernel: WorldKernel, candidate: TransactionProposal): Promise<NonNullable<KernelError['details']>> {
  try {
    await kernel.submit(candidate)
  } catch (error) {
    expect(error, '应当抛 KernelError').toBeInstanceOf(KernelError)
    const details = (error as KernelError).details
    expect(details, '拒绝必须带机读诊断（模型靠它自我修正）').toBeDefined()
    return details ?? []
  }
  throw new Error('提交本该被拒，但它通过了')
}

describe('T20 —— 原子提交与只追加', () => {
  it('空世界打开是安全的（目录不存在 → sequence 0）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(join(dir, 'not-created-yet'))
    expect(kernel.isEmpty).toBe(true)
    expect(kernel.snapshot.entities).toEqual({})
  })

  it('提交后：实体入快照、序号 +1、日志多一行', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)

    const result = await kernel.submit(genesis())

    expect(result.duplicated).toBe(false)
    expect(result.sequence).toBe(1)
    expect(Object.keys(kernel.snapshot.entities).sort()).toEqual(['bot', 'house', 'phone', 'street'])
    expect(kernel.snapshot.entities['house']?.revision).toBe(1)

    const log = await readFile(join(dir, TRANSACTION_LOG), 'utf8')
    expect(log.split('\n').filter((line) => line.trim() !== '')).toHaveLength(1)
  })

  it('日志**只追加**：提交三次 = 三行，且旧行一字未动', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const afterFirst = await readFile(join(dir, TRANSACTION_LOG), 'utf8')
    await kernel.submit(proposal([{ op: 'move', id: 'bot', location: 'street' }]))
    await kernel.submit(proposal([{ op: 'update', id: 'bot', changes: { name: '毕小研' } }]))

    const final = await readFile(join(dir, TRANSACTION_LOG), 'utf8')
    const lines = final.split('\n').filter((line) => line.trim() !== '')
    expect(lines).toHaveLength(3)
    expect(final.startsWith(afterFirst), '旧内容必须原样保留（只追加，无原地改写）').toBe(true)
  })
})

describe('T20 —— 校验①：类目合法', () => {
  it('未知操作被拒，诊断指出是哪一条', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const details = await expectRejected(kernel, proposal([{ op: 'delete', id: 'house' } as unknown as WorldOperation]))
    expect(details[0]?.code).toBe('UNKNOWN_OPERATION')
    expect(details[0]?.opIndex).toBe(0)
    expect(details[0]?.reason).toBe('unknown_op')
  })

  it('缺少 idempotencyKey 被拒（幂等是内核的硬前提）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)

    const details = await expectRejected(
      kernel,
      proposal([{ op: 'create', entity: { id: 'x', kind: 'place', name: 'X', location: null } }], { idempotencyKey: '' }),
    )
    expect(details[0]?.code).toBe('MISSING_IDEMPOTENCY_KEY')
  })
})

describe('T20 —— 校验①·5：形状（模型漏字段要拿得到可修正的诊断）', () => {
  // 2026-09-27 夜间隔离实例实测：agnes 的提案里出现过 `{op:'update', id}` 少了 changes，
  // 应用阶段于是抛**裸 TypeError**（"Cannot read properties of undefined (reading 'name')"）
  // —— 模型拿到它无从下手。这一组把"该拒的拒得有理由"钉在机读诊断上。
  const table: Array<[string, WorldOperation, string]> = [
    ['create 少了 entity', { op: 'create' } as unknown as WorldOperation, 'entity'],
    [
      'create 的 entity 少了 id',
      { op: 'create', entity: { kind: 'object', name: '笔' } } as unknown as WorldOperation,
      'entity.id',
    ],
    [
      'create 的 entity 少了 kind',
      { op: 'create', entity: { id: 'pen', name: '笔' } } as unknown as WorldOperation,
      'entity.kind',
    ],
    ['update 少了 changes', { op: 'update', id: 'phone' } as unknown as WorldOperation, 'changes'],
    ['update 的 changes 是 null', { op: 'update', id: 'phone', changes: null } as unknown as WorldOperation, 'changes'],
    ['action.start 少了 action', { op: 'action.start' } as unknown as WorldOperation, 'action'],
    [
      'action.start 的 action 少了 id',
      { op: 'action.start', action: { actorId: 'bot', intent: '看看' } } as unknown as WorldOperation,
      'action.id',
    ],
    ['action.finish 少了 id', { op: 'action.finish' } as unknown as WorldOperation, 'id'],
    [
      'action.finish 的 status 不在枚举里（"success" 会污染世界状态）',
      { op: 'action.finish', id: 'x', status: 'success' } as unknown as WorldOperation,
      'status',
    ],
    [
      'action.finish 塞了多余字段（要改状态请单独发 update）',
      {
        op: 'action.finish',
        id: 'x',
        status: 'completed',
        changes: [{ op: 'entity.update', id: 'yanxin', fields: {} }],
      } as unknown as WorldOperation,
      'op',
    ],
    ['move 少了 id', { op: 'move', location: 'house' } as unknown as WorldOperation, 'id'],
    ['say 少了 actorId', { op: 'say', text: '在的' } as unknown as WorldOperation, 'actorId'],
    ['say 少了 text', { op: 'say', actorId: 'bot' } as unknown as WorldOperation, 'text'],
    ['say 的 text 只有空白', { op: 'say', actorId: 'bot', text: '   ' } as unknown as WorldOperation, 'text'],
  ]

  it.each(table)('⭐ %s → BAD_FIELD（field=%s）', async (_label, operation, field) => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const details = await expectRejected(kernel, proposal([operation]))
    const hit = details.find((item) => item.code === 'BAD_FIELD')

    expect(hit, '应当给出 BAD_FIELD 诊断').toBeDefined()
    expect(hit?.field).toBe(field)
    expect(hit?.message ?? '').not.toBe('')
    // 多余字段那条：键名在 message 里说清（diagnostic 的 field 没有单独的枚举值）
    if (field === 'op') expect(hit?.message).toContain('单独发一条 update')
    // 拒了就不该动世界（事务数不该增加）
    expect(kernel.transactionCount).toBe(1)
  })

  it('⭐ 反证：少了 changes 的 update 不再抛裸 TypeError，且补上之后能自愈', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    // 这条以前是 TypeError（"…reading 'name'"）；现在必须是**带诊断的拒绝**
    await expectRejected(kernel, proposal([{ op: 'update', id: 'phone' } as unknown as WorldOperation]))
    // 而且能自愈：补上 changes 之后同一世界照样接受
    const ok = await kernel.submit(proposal([{ op: 'update', id: 'phone', changes: { name: '我的手机' } }]))
    expect(ok.sequence).toBe(2)
  })

  it('形状齐了就放行（不误伤正常提案）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const result = await kernel.submit(
      proposal([
        { op: 'move', id: 'phone', location: 'street' },
        { op: 'update', id: 'phone', changes: { attributes: { 电量: { value: 12, visibility: 'public' } } } },
        { op: 'say', actorId: 'bot', text: '出门带手机' },
      ]),
    )
    expect(result.sequence).toBe(2)
    expect(result.utterances).toHaveLength(1)
  })
})

describe('T20 —— 校验②：引用完整性', () => {
  it('悬空 location 被拒（且告诉它要引用 place）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)

    const details = await expectRejected(
      kernel,
      proposal([{ op: 'create', entity: { id: 'cup', kind: 'object', name: '杯子', location: 'kitchen' } }]),
    )
    expect(details[0]?.code).toBe('DANGLING_LOCATION')
    expect(details[0]?.targetId).toBe('kitchen')
    expect(details[0]?.expectedKinds).toEqual(['place'])
    expect(details[0]?.field).toBe('location')
  })

  it('location 指向非 place 被拒（类型不符要说清实际是什么）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const details = await expectRejected(
      kernel,
      proposal([{ op: 'create', entity: { id: 'cup', kind: 'object', name: '杯子', location: 'phone' } }]),
    )
    expect(details[0]?.code).toBe('WRONG_LOCATION_KIND')
    expect(details[0]?.reason).toBe('wrong_kind')
    expect(details[0]?.actualKind).toBe('object')
  })

  it('⭐ 同批**前向引用**必须放行（先建引用者、后建被引用者）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)

    // 手机先于房子创建 —— 逐条校验会误判，我们校验的是"整批候选世界"
    const result = await kernel.submit(
      proposal(
        [
          { op: 'create', entity: { id: 'phone', kind: 'object', name: '手机', location: 'house', owner: 'bot' } },
          { op: 'create', entity: { id: 'house', kind: 'place', name: '小房子', location: null } },
          { op: 'create', entity: { id: 'bot', kind: 'actor', name: '小研', location: 'house' } },
        ],
        { idempotencyKey: 'forward-ref' },
      ),
    )
    expect(result.duplicated).toBe(false)
    expect(Object.keys(kernel.snapshot.entities)).toHaveLength(3)
  })

  it('owner 指向非 actor 被拒', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const details = await expectRejected(
      kernel,
      proposal([{ op: 'create', entity: { id: 'cup', kind: 'object', name: '杯子', location: 'house', owner: 'house' } }]),
    )
    expect(details[0]?.code).toBe('WRONG_OWNER_KIND')
    expect(details[0]?.expectedKinds).toEqual(['actor'])
  })

  it('actor / place 不能有 owner（只有物件可以有）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const details = await expectRejected(
      kernel,
      proposal([{ op: 'create', entity: { id: 'cat', kind: 'actor', name: '猫', location: 'house', owner: 'bot' } }]),
    )
    expect(details[0]?.code).toBe('OWNER_NOT_ALLOWED')
    expect(details[0]?.reason).toBe('owner_not_allowed')
  })

  it('⭐ 容纳关系成环被拒，并给出闭合路径', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const details = await expectRejected(
      kernel,
      proposal([
        { op: 'create', entity: { id: 'room', kind: 'place', name: '里屋', location: 'house' } },
        { op: 'move', id: 'house', location: 'room' },
      ]),
    )
    const cycle = details.find((item) => item.code === 'CONTAINMENT_CYCLE')
    expect(cycle).toBeDefined()
    expect(cycle?.path?.[0]).toBe(cycle?.path?.[cycle.path.length - 1]) // 闭合
    expect(cycle?.path).toContain('house')
    expect(cycle?.path).toContain('room')
  })

  it('重复创建同一实体被拒（改建请用 update / 移动用 move）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const details = await expectRejected(
      kernel,
      proposal([{ op: 'create', entity: { id: 'house', kind: 'place', name: '另一个房子', location: null } }]),
    )
    expect(details[0]?.code).toBe('DUPLICATE_ENTITY')
  })

  it('动作的目标不存在被拒；行动者必须是 actor', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const missingTarget = await expectRejected(
      kernel,
      proposal([{ op: 'action.start', action: { id: 'a1', actorId: 'bot', intent: '拿起', targetIds: ['teacup'] } }]),
    )
    expect(missingTarget[0]?.code).toBe('UNKNOWN_ENTITY')

    const wrongActor = await expectRejected(
      kernel,
      proposal([{ op: 'action.start', action: { id: 'a2', actorId: 'phone', intent: '发消息' } }]),
    )
    expect(wrongActor[0]?.code).toBe('WRONG_ACTOR_KIND')
  })

  it('一次把所有问题说清（不是遇到第一个就停）—— 模型能一轮改完', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)

    const details = await expectRejected(
      kernel,
      proposal(
        [
          { op: 'create', entity: { id: 'cup', kind: 'object', name: '杯子', location: 'kitchen' } },
          { op: 'create', entity: { id: 'lamp', kind: 'object', name: '台灯', location: 'study', owner: 'house' } },
        ],
        { idempotencyKey: 'many-problems' },
      ),
    )
    const codes = details.map((item) => item.code)
    expect(codes).toContain('DANGLING_LOCATION')
    expect(codes).toContain('DANGLING_OWNER')
    expect(details.length).toBeGreaterThanOrEqual(2)
  })
})

describe('T20 —— 校验③：幂等', () => {
  it('⭐ 同键重复提交只生效一次（防超时重试重复结算）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)

    const first = await kernel.submit(genesis())
    const second = await kernel.submit(genesis())

    expect(first.duplicated).toBe(false)
    expect(second.duplicated).toBe(true)
    expect(second.sequence).toBe(first.sequence) // 返回首次的序号，而不是 +1
    expect(kernel.transactionCount).toBe(1) // 没有产生新事务
    expect(kernel.snapshot.entities['house']?.revision).toBe(1) // 实体没被改动两次

    const log = await readFile(join(dir, TRANSACTION_LOG), 'utf8')
    expect(log.split('\n').filter((line) => line.trim() !== '')).toHaveLength(1)
  })

  it('幂等判定**先于**完整校验：同键重试带着已过时的版本也只会被忽略，不会报版本不符', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())
    const key = 'retry-after-timeout'

    // 首次：基于「bot 版本 1」，成功（版本 +1）
    const first = await kernel.submit(
      proposal([{ op: 'move', id: 'bot', location: 'street' }], { idempotencyKey: key, expectedVersions: { bot: 1 } }),
    )
    expect(first.duplicated).toBe(false)

    // 超时重试：同一个 key，但携带的版本已经旧了。
    // 若幂等判定排在乐观并发之后，这里会被误报"版本不符"—— 而它本来就该被安静忽略。
    const retry = await kernel.submit(
      proposal([{ op: 'move', id: 'bot', location: 'street' }], { idempotencyKey: key, expectedVersions: { bot: 1 } }),
    )
    expect(retry.duplicated).toBe(true)
    expect(retry.sequence).toBe(first.sequence)
    expect(kernel.snapshot.entities['bot']?.revision).toBe(2) // 只动过一次
  })

  it('不同键即使内容相同也会执行（幂等看键，不看内容）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())
    await kernel.submit(proposal([{ op: 'say', actorId: 'bot', text: '嗯' }], { idempotencyKey: 'k1' }))
    await kernel.submit(proposal([{ op: 'say', actorId: 'bot', text: '嗯' }], { idempotencyKey: 'k2' }))
    expect(kernel.transactionCount).toBe(3) // 创世 + 两次 say（同内容不同键 = 两件事）
    expect(kernel.snapshot.utterances).toHaveLength(2)
  })
})

describe('T20 —— 校验④：乐观并发', () => {
  it('⭐ 版本不符被拒（防"基于旧感知改新状态"）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const stale = kernel.snapshot.entities['bot']?.revision ?? 0
    await kernel.submit(proposal([{ op: 'move', id: 'bot', location: 'street' }])) // 版本 +1

    const details = await expectRejected(
      kernel,
      proposal([{ op: 'move', id: 'bot', location: 'house' }], { expectedVersions: { bot: stale } }),
    )
    expect(details[0]?.code).toBe('VERSION_MISMATCH')
    expect(details[0]?.reason).toBe('version_mismatch')
    expect(details[0]?.entityId).toBe('bot')
  })

  it('expectedVersions 写 null = "该实体应当不存在"（创建语义）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const details = await expectRejected(
      kernel,
      proposal(
        [{ op: 'create', entity: { id: 'house', kind: 'place', name: '重复的房子', location: null } }],
        { expectedVersions: { house: null } },
      ),
    )
    expect(details.some((item) => item.reason === 'version_mismatch' || item.code === 'DUPLICATE_ENTITY')).toBe(true)
  })

  it('版本一致则放行（正常路径不能被并发检查误伤）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const current = kernel.snapshot.entities['bot']?.revision ?? 0
    const result = await kernel.submit(
      proposal([{ op: 'move', id: 'bot', location: 'street' }], { expectedVersions: { bot: current } }),
    )
    expect(result.duplicated).toBe(false)
    expect(kernel.snapshot.entities['bot']?.location).toBe('street')
  })
})

describe('T20 —— 重放（日志是权威）', () => {
  it('⭐ 重新打开得到等价快照（实体 / 版本 / 序号 / 说话记录）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())
    await kernel.submit(proposal([{ op: 'move', id: 'bot', location: 'street' }]))
    await kernel.submit(proposal([{ op: 'say', actorId: 'bot', text: '今天街上风很大' }]))
    await kernel.submit(
      proposal([
        { op: 'action.start', action: { id: 'a1', actorId: 'bot', intent: '在街上走走', expectedEnd: 120 } },
        { op: 'action.finish', id: 'a1', status: 'completed' },
      ]),
    )

    const before = kernel.snapshot
    const reopened = await openWorld(dir)
    const after = reopened.snapshot

    expect(after.sequence).toBe(before.sequence)
    expect(after.effectiveAt).toBe(before.effectiveAt)
    expect(after.entities).toEqual(before.entities)
    expect(after.actions).toEqual(before.actions)
    expect(after.utterances).toEqual(before.utterances)
  })

  it('重放后幂等键仍然生效（跨进程重启也不会重复结算）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const reopened = await openWorld(dir)
    const retry = await reopened.submit(genesis())
    expect(retry.duplicated).toBe(true)
    expect(reopened.transactionCount).toBe(1)
  })
})

describe('T20 —— 崩溃语义', () => {
  it('⭐ 最后一行不完整 → 丢弃并告警（写入中断的正常形态）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    // 模拟 append 写到一半进程死掉
    await writeFile(join(dir, TRANSACTION_LOG), `{"sequence":2,"proposal":{"idem`, { flag: 'a' })

    const reopened = await openWorld(dir)
    expect(reopened.transactionCount).toBe(1) // 完整的那条还在
    expect(reopened.snapshot.entities['house']).toBeDefined()
    expect(warnings.some((message) => message.includes('最后一行不完整'))).toBe(true)
  })

  it('⭐ 残行丢弃是物理截断：丢弃 → 再提交 → 再重开，新事务不粘残行（两次崩溃周期后世界照常打开）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    // 第一次崩溃周期：append 写到一半死掉
    await writeFile(join(dir, TRANSACTION_LOG), `{"sequence":2,"proposal":{"idem`, { flag: 'a' })
    const reopened = await openWorld(dir) // 丢弃残行（并物理截断文件）
    expect(reopened.transactionCount).toBe(1)

    // 第二次崩溃周期：在"已截断"的日志上正常提交，然后重开
    await reopened.submit(proposal([{ op: 'move', id: 'bot', location: 'street' }]))
    const reopened2 = await openWorld(dir)
    // 修复前：新事务粘在残行后面 → 要么 LOG_CORRUPTED（世界打不开），要么这条被当残行丢弃
    expect(reopened2.transactionCount).toBe(2)
    expect(reopened2.snapshot.entities['bot']?.location).toBe('street')

    // 日志里没有任何"半个 JSON"残留
    const lines = (await readFile(join(dir, TRANSACTION_LOG), 'utf8')).split('\n').filter((line) => line.trim() !== '')
    expect(lines.length).toBe(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('⭐ 并发提交被串行化：两个 submit 并发进来，序号唯一、日志两行都完好（防同序号/毒行）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const results = await Promise.all([
      kernel.submit(proposal([{ op: 'move', id: 'bot', location: 'street' }])),
      kernel.submit(proposal([{ op: 'update', id: 'bot', changes: { attributes: { mood: { value: 'curious', visibility: 'public' } } } }])),
    ])

    // 两个都成功，且序号恰好是一对不重复的连续值
    const sequences = results.map((result) => result.sequence).sort((a, b) => a - b)
    expect(sequences).toEqual([2, 3])
    expect(kernel.transactionCount).toBe(3)

    const lines = (await readFile(join(dir, TRANSACTION_LOG), 'utf8')).split('\n').filter((line) => line.trim() !== '')
    expect(lines.length).toBe(3)
    const logged = lines.map((line) => (JSON.parse(line) as { sequence: number }).sequence)
    expect(new Set(logged).size).toBe(3) // 每行序号唯一（修复前：两行同 sequence）
  })

  it('⭐ 中间行损坏 → 抛错不掩盖（那是被外力改坏，不是崩溃痕迹）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())
    await kernel.submit(proposal([{ op: 'move', id: 'bot', location: 'street' }]))

    const path = join(dir, TRANSACTION_LOG)
    const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim() !== '')
    lines[0] = '{坏行}'
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8')

    await expect(openWorld(dir)).rejects.toThrow(/第 1 行损坏/)
  })

  it('⭐ 提交前崩溃 = 世界没变（日志没写就没有这件事）', async () => {
    const dir = await makeDir()
    let explode = false
    const kernel = await openWorld(dir, {
      beforeAppend: () => {
        if (explode) throw new Error('模拟：append 之前进程崩溃')
      },
    })
    await kernel.submit(genesis())

    explode = true
    await expect(kernel.submit(proposal([{ op: 'move', id: 'bot', location: 'street' }]))).rejects.toThrow(/崩溃/)

    expect(kernel.snapshot.entities['bot']?.location).toBe('house') // 内存没变
    const reopened = await openWorld(dir)
    expect(reopened.snapshot.entities['bot']?.location).toBe('house') // 日志也没变
  })
})

describe('T20 —— 数据形态（JSON 硬纪律）', () => {
  it('非 JSON 值被拒（NaN 会被静默写成 null，那会让重放不等价）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)

    await expect(
      kernel.submit(
        proposal([
          {
            op: 'create',
            entity: { id: 'x', kind: 'object', name: 'X', location: null, attributes: { size: { value: NaN, visibility: 'public' } } },
          },
        ]),
      ),
    ).rejects.toThrow(/INVALID_JSON|只能包含有限 JSON 值/)
  })

  it('原型污染键被拒', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)

    await expect(
      kernel.submit(
        proposal([
          {
            op: 'create',
            entity: {
              id: 'x',
              kind: 'object',
              name: 'X',
              location: null,
              attributes: JSON.parse('{"__proto__":{"polluted":true}}') as never,
            },
          },
        ]),
      ),
    ).rejects.toThrow(KernelError)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})

describe('T20 —— 动作生命周期', () => {
  it('start → pending（含发起时目标版本）；finish 后状态与时刻落定', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir, { now: () => 1000 })
    await kernel.submit(genesis())

    await kernel.submit(
      proposal([{ op: 'action.start', action: { id: 'a1', actorId: 'bot', intent: '擦桌子', targetIds: ['phone'] } }]),
    )
    const started = kernel.snapshot.actions['a1']
    expect(started?.status).toBe('pending')
    expect(started?.startedAt).toBe(1000)
    expect(started?.targetVersions['phone']).toBe(1) // 发起时的版本被记下（完成时要复核）

    await kernel.submit(proposal([{ op: 'action.finish', id: 'a1', status: 'completed' }]))
    const finished = kernel.snapshot.actions['a1']
    expect(finished?.status).toBe('completed')
    expect(finished?.finishedAt).toBe(1000)
  })

  it('⭐ 同批 start→finish（立即完成的动作）合法 —— "变更与完成标记在同一事务"', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    // 这是 Write 阶段实测出来的设计缺口：逐条查快照会把"立即完成的动作"全拦掉，
    // 因为 action.finish 校验时看不到同批刚 action.start 的那条。
    const result = await kernel.submit(
      proposal([
        { op: 'action.start', action: { id: 'a-now', actorId: 'bot', intent: '看了一眼窗外', expectedEnd: 0 } },
        { op: 'action.finish', id: 'a-now', status: 'completed' },
      ]),
    )

    expect(result.duplicated).toBe(false)
    expect(kernel.snapshot.actions['a-now']?.status).toBe('completed')
  })

  it('⭐ 重复结算被拒（防"超时重试造成重复结算"）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())
    await kernel.submit(proposal([{ op: 'action.start', action: { id: 'a1', actorId: 'bot', intent: '等一等' } }]))
    await kernel.submit(proposal([{ op: 'action.finish', id: 'a1', status: 'completed' }]))

    const details = await expectRejected(kernel, proposal([{ op: 'action.finish', id: 'a1', status: 'failed' }]))
    expect(details[0]?.code).toBe('ACTION_ALREADY_SETTLED')
  })
})

describe('T20 —— 只读呈现', () => {
  it('导出 Markdown 含实体层级与最近说话；用临时文件 + rename 原子替换', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())
    await kernel.submit(proposal([{ op: 'say', actorId: 'bot', text: '今天街上风很大' }]))

    const markdown = await kernel.exportStatus()

    expect(markdown).toContain('# 世界现状')
    expect(markdown).toContain('小房子')
    expect(markdown).toContain('手机')
    expect(markdown).toContain('今天街上风很大')
    expect(markdown).toContain('只读') // 明确它不是编辑入口

    const onDisk = await readFile(join(dir, 'world-status.md'), 'utf8')
    expect(onDisk).toBe(markdown)
    await expect(readFile(join(dir, 'world-status.md.tmp'), 'utf8')).rejects.toThrow() // 临时文件不残留
  })
})

describe('T27 —— 提交结果带上"这次说了什么"（发射闸门的输入）', () => {
  it('⭐ 提交返回本次产生的 utterances；日志行里的 utteranceIds 也如实填写', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const result = await kernel.submit(
      proposal([
        { op: 'say', actorId: 'bot', text: '嗯，我在' },
        { op: 'say', actorId: 'bot', text: '外面好安静' },
      ]),
    )

    expect(result.utterances.map((utterance) => utterance.text)).toEqual(['嗯，我在', '外面好安静'])
    expect(result.utterances.map((utterance) => utterance.id)).toEqual([`${result.sequence}:0`, `${result.sequence}:1`])

    // 日志行是权威记录：它必须和返回的 id 一致（否则重放出来的听说话记录无法对上）
    const lines = (await readFile(join(dir, TRANSACTION_LOG), 'utf8')).trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as { utteranceIds?: string[] }
    expect(last.utteranceIds).toEqual(result.utterances.map((utterance) => utterance.id))
  })

  it('没说任何话的事务返回空数组（不是"undefined 猜一猜"）', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    const result = await kernel.submit(genesis())
    expect(result.utterances).toEqual([])
  })

  it('⭐ 幂等命中时**不回** utterances：同一句话不会因为重提而被投两次', async () => {
    const dir = await makeDir()
    const kernel = await openWorld(dir)
    await kernel.submit(genesis())

    const candidate = proposal([{ op: 'say', actorId: 'bot', text: '只该发一次' }], { idempotencyKey: 'say-once' })
    const first = await kernel.submit(candidate)
    const second = await kernel.submit(candidate)

    expect(first.utterances).toHaveLength(1)
    expect(second.duplicated).toBe(true)
    expect(second.utterances).toEqual([])
  })

  it('重放后事件 id 与当时一致（裁剪上限内按"当时的长度"编号）', async () => {
    const dir = await makeDir()
    const first = await openWorld(dir)
    await first.submit(genesis())
    const posted = await first.submit(proposal([{ op: 'say', actorId: 'bot', text: '一' }]))

    const reopened = await openWorld(dir)
    expect(reopened.snapshot.utterances.map((utterance) => utterance.id)).toEqual(
      posted.utterances.map((utterance) => utterance.id),
    )
  })
})