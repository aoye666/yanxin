/**
 * 创世的验收（T27，spec §6.7）。
 *
 * 创世是**唯一一次**"从散文长出结构化世界"：`persona/world.md`（她与你的世界）→
 * World-LLM 提取 → 内核校验 → 提交。所以这里要证明两件事：
 *
 *   · **只长出合法的世界**：只有 create、根地点是 null、引用整批可解析、必须有她 ——
 *     不合法就带着**机读诊断**让它改（与 T25 的裁定者同一套纪律）
 *   · **失败不覆盖**（验收点名的）：一次都没提交过 = 一个字节都没写。世界要么是创世前的
 *     样子，要么是刚创世的样子 —— 绝不出现"被清空的世界"（她的家当没了还没人报错）
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallWorldModel, WorldModelRequest } from '../../src/world/arbiter.ts'
import { KernelError } from '../../src/world/error.ts'
import { GENESIS_KEY, genesis, checkGenesis, buildProposal, renderGenesisPrompt } from '../../src/world/genesis.ts'
import { TRANSACTION_LOG, WorldKernel } from '../../src/world/kernel.ts'
import { emptyWorld, type EntityInput, type TransactionProposal } from '../../src/world/state.ts'

const SELF_ID = 'yanxin'

/** 一段世界文档（散文，形状与 `persona/world.md` 同类；测试不依赖真实文件内容）。 */
const WORLD_DOC = '小研住在一个小房子里。房子外面是一条很宽的街道。她有一部手机。'

const dirs: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function makeWorld(): Promise<{ dir: string; kernel: WorldKernel }> {
  const dir = await mkdtemp(join(tmpdir(), 'yanxin-genesis-'))
  dirs.push(dir)
  return { dir, kernel: await WorldKernel.open(dir, { warn: () => undefined }) }
}

/** 一份合法的世界清单（前向引用：她先写、房子后写 —— 同批必须放行）。 */
function entities(): EntityInput[] {
  return [
    { id: SELF_ID, kind: 'actor', name: '小研', location: 'house' },
    { id: 'phone', kind: 'object', name: '手机', location: 'house', owner: SELF_ID },
    { id: 'house', kind: 'place', name: '小房子', location: null },
    { id: 'street', kind: 'place', name: '很宽的街道', location: null },
  ]
}

/**
 * 一个"按剧本回答"的世界模型。
 *
 * `script` 是每次调用的返回值（用尽后重复最后一次）—— 记下每次收到的提示词，
 * 好断言"诊断确实喂回去了"。
 */
function scriptedModel(script: unknown[]): { callModel: CallWorldModel; prompts: string[] } {
  const prompts: string[] = []
  const callModel: CallWorldModel = async (request: WorldModelRequest) => {
    prompts.push(request.prompt)
    const reply = script[Math.min(prompts.length - 1, script.length - 1)]
    return typeof reply === 'function' ? (reply as (r: WorldModelRequest) => never)(request) : { arguments: reply }
  }
  return { callModel, prompts }
}

describe('T27 —— 创世成功路径', () => {
  it('⭐ 散文 → 结构化实体：世界从 0 开始，纪元是 T0', async () => {
    const { kernel } = await makeWorld()
    const { callModel, prompts } = scriptedModel([{ entities: entities() }])

    const result = await genesis({ kernel, worldDoc: WORLD_DOC, callModel, selfId: SELF_ID })

    expect(result.attempts).toBe(1)
    expect(result.sequence).toBe(1)
    expect(kernel.transactionCount).toBe(1)
    expect(Object.keys(kernel.snapshot.entities).sort()).toEqual(['house', 'phone', 'street', SELF_ID])
    // 创世的世界时刻是 0：纪元由 T=0 定义（T21 的 clock），不是"提交那一刻"
    expect(kernel.snapshot.effectiveAt).toBe(0)
    // 提示词里带着世界文档与她自己的 id（模型据此写清单）
    expect(prompts[0]).toContain(WORLD_DOC)
    expect(prompts[0]).toContain(SELF_ID)
  })

  it('⭐ 落盘的操作**全是 create**（模型没有机会写别的操作类型）', async () => {
    const { dir, kernel } = await makeWorld()
    const { callModel } = scriptedModel([{ entities: entities() }])
    await genesis({ kernel, worldDoc: WORLD_DOC, callModel, selfId: SELF_ID })

    const line = await readFile(join(dir, TRANSACTION_LOG), 'utf8')
    const transaction = JSON.parse(line.trim()) as { proposal: TransactionProposal }
    expect(transaction.proposal.idempotencyKey).toBe(GENESIS_KEY)
    expect(transaction.proposal.source).toBe('bootstrap')
    expect(new Set(transaction.proposal.operations.map((operation) => operation.op))).toEqual(new Set(['create']))
  })

  it('根地点是 null、屋里与她都指向房子（层级从第一天起就是对的）', async () => {
    const { kernel } = await makeWorld()
    const { callModel } = scriptedModel([{ entities: entities() }])
    await genesis({ kernel, worldDoc: WORLD_DOC, callModel, selfId: SELF_ID })

    expect(kernel.snapshot.entities['house']?.location).toBeNull()
    expect(kernel.snapshot.entities['street']?.location).toBeNull()
    expect(kernel.snapshot.entities[SELF_ID]?.location).toBe('house')
    expect(kernel.snapshot.entities['phone']?.owner).toBe(SELF_ID)
  })
})

describe('T27 —— 校验与自我修正', () => {
  it('⭐ 悬空引用被拒 → 诊断喂回去 → 模型改对（第二次成功）', async () => {
    const { kernel } = await makeWorld()
    const dangling: EntityInput[] = [
      { id: SELF_ID, kind: 'actor', name: '小研', location: 'nowhere' },
      { id: 'house', kind: 'place', name: '小房子', location: null },
    ]
    const { callModel, prompts } = scriptedModel([{ entities: dangling }, { entities: entities() }])

    const result = await genesis({ kernel, worldDoc: WORLD_DOC, callModel, selfId: SELF_ID, warn: () => undefined })

    expect(result.attempts).toBe(2)
    // 第二次的提示词里带着机读诊断（哪条操作、引用了谁、为什么）
    expect(prompts[1]).toContain('nowhere')
    expect(prompts[1]).toContain('上一次的清单被拒')
    expect(kernel.snapshot.entities['street']).toBeDefined()
  })

  it('形状不对（kind 非法 / location 是数字）当作"没给出清单"，重来而不是崩', async () => {
    const { kernel } = await makeWorld()
    const { callModel, prompts } = scriptedModel([
      { entities: [{ id: 'house', kind: 'building', name: '房子', location: null }] },
      { entities: entities() },
    ])

    const result = await genesis({ kernel, worldDoc: WORLD_DOC, callModel, selfId: SELF_ID, warn: () => undefined })

    expect(result.attempts).toBe(2)
    expect(prompts[1]).toContain('install_world')
  })

  it('checkGenesis 的五条规矩各自有反证（她 / 类型 / 地点 / 根 / 只 create）', () => {
    const run = (list: EntityInput[], selfId = SELF_ID): string[] =>
      checkGenesis(buildProposal(list), selfId).map((diagnostic) => diagnostic.code)

    expect(run([])).toContain('GENESIS_NO_SELF')
    expect(run([{ id: SELF_ID, kind: 'object', name: '小研', location: null }, { id: 'p', kind: 'place', name: '屋', location: null }])).toContain(
      'GENESIS_SELF_NOT_ACTOR',
    )
    expect(run([{ id: SELF_ID, kind: 'actor', name: '小研', location: null }])).toContain('GENESIS_NO_PLACE')
    expect(
      run([
        { id: SELF_ID, kind: 'actor', name: '小研', location: 'room' },
        { id: 'room', kind: 'place', name: '屋', location: 'house' },
      ]),
    ).toContain('GENESIS_NO_ROOT_PLACE')

    // 非 create 的操作：不该出现在创世里（buildProposal 只造 create，这里是直接验规矩）
    const sneaky: TransactionProposal = {
      ...buildProposal([]),
      operations: [{ op: 'move', id: 'house', location: null }],
    }
    expect(checkGenesis(sneaky, SELF_ID).map((diagnostic) => diagnostic.code)).toContain('GENESIS_OP_NOT_ALLOWED')
  })

  it('空世界上的"合法清单"当然是合法的（跑一遍正路径，避免只测反证）', () => {
    expect(emptyWorld().sequence).toBe(0)
    expect(checkGenesis(buildProposal(entities()), SELF_ID)).toEqual([])
  })
})

describe('T27 —— 失败不覆盖', () => {
  it('⭐ 模型始终给不出合法清单 → 抛 GENESIS_FAILED，且**一个字节都没写**', async () => {
    const { dir, kernel } = await makeWorld()
    const greedy: EntityInput[] = [{ id: SELF_ID, kind: 'actor', name: '小研', location: null }] // 没地点
    const { callModel } = scriptedModel([{ entities: greedy }])

    try {
      await genesis({ kernel, worldDoc: WORLD_DOC, callModel, selfId: SELF_ID, warn: () => undefined })
      expect.unreachable('应当抛 GENESIS_FAILED')
    } catch (error) {
      expect(error).toBeInstanceOf(KernelError)
      expect((error as KernelError).code).toBe('GENESIS_FAILED')
      expect((error as KernelError).details?.length).toBeGreaterThan(0)
    }

    // 世界还是创世前的样子：日志文件根本不存在（不是"写了个空世界"）
    expect(kernel.isEmpty).toBe(true)
    expect(kernel.transactionCount).toBe(0)
    await expect(readFile(join(dir, TRANSACTION_LOG), 'utf8')).rejects.toThrow()
  })

  it('失败之后**仍然可以**正常创世（失败没有留下后遗症）', async () => {
    const { kernel } = await makeWorld()
    const bad = scriptedModel([{ entities: null }])
    await expect(
      genesis({ kernel, worldDoc: WORLD_DOC, callModel: bad.callModel, selfId: SELF_ID, warn: () => undefined }),
    ).rejects.toThrow(KernelError)

    const good = scriptedModel([{ entities: entities() }])
    const result = await genesis({ kernel, worldDoc: WORLD_DOC, callModel: good.callModel, selfId: SELF_ID })
    expect(result.sequence).toBe(1)
  })

  it('⭐ 世界已经有东西了 → 拒（创世是"第一天"的事，不覆盖既有世界）', async () => {
    const { dir, kernel } = await makeWorld()
    const first = scriptedModel([{ entities: entities() }])
    await genesis({ kernel, worldDoc: WORLD_DOC, callModel: first.callModel, selfId: SELF_ID })

    const before = await readFile(join(dir, TRANSACTION_LOG), 'utf8')
    const second = scriptedModel([{ entities: entities() }])
    try {
      await genesis({ kernel, worldDoc: WORLD_DOC, callModel: second.callModel, selfId: SELF_ID })
      expect.unreachable('应当抛 GENESIS_ALREADY_EXISTS')
    } catch (error) {
      expect((error as KernelError).code).toBe('GENESIS_ALREADY_EXISTS')
    }

    expect(second.prompts).toEqual([]) // 连模型都没调（拒绝得越早，越不可能出事）
    expect(await readFile(join(dir, TRANSACTION_LOG), 'utf8')).toBe(before)
  })
})

describe('T27 —— 提示词', () => {
  it('渲染出的提示词里带着世界文档全文与三条硬规矩', () => {
    const prompt = renderGenesisPrompt(WORLD_DOC, SELF_ID)
    expect(prompt).toContain(WORLD_DOC)
    expect(prompt).toContain('只创建、不修改')
    expect(prompt).toContain('根地点')
    expect(prompt).toContain(SELF_ID)
  })
})