/**
 * 裁定者的验收（T25，spec §6.7）。
 *
 * 三组：
 *   ① **模型不写文件**：它给提案、`arbiter` 预校验；**不提交**（提交是 runtime 的事）
 *   ② **校验反馈循环**：提案不合法 → 把**机读诊断**喂回模型重提（最多 N 轮）→ 用尽则 `null`
 *   ③ **视角差异**：提示词给它**内部 id**（它要写提案）与 `hidden` 属性（世界真相那一侧）——
 *      与她对模型看到的"句柄 + 无 hidden"正好相反
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROPOSE_WORLD, WorldArbiter, renderContext, type WorldModelRequest } from '../../src/world/arbiter.ts'
import { WorldKernel } from '../../src/world/kernel.ts'
import type { WorldAction, WorldSnapshot } from '../../src/world/state.ts'

const dirs: string[] = []
const warnings: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
  warnings.length = 0
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yanxin-arbiter-'))
  dirs.push(dir)
  return dir
}

/** 创世 + 一个到期动作。 */
async function seed(kernel: WorldKernel): Promise<void> {
  await kernel.submit({
    idempotencyKey: 'genesis',
    operations: [
      { op: 'create', entity: { id: 'bot', kind: 'actor', name: '小研', location: 'house' } },
      { op: 'create', entity: { id: 'house', kind: 'place', name: '小房子', location: null } },
      {
        op: 'create',
        entity: {
          id: 'phone',
          kind: 'object',
          name: '手机',
          location: 'house',
          owner: 'bot',
          // hidden 属性：世界真相那一侧（她看不到，裁定者看得到）
          attributes: { 电量: { value: '12%', visibility: 'hidden' } },
        },
      },
    ],
    source: 'bootstrap',
  })
  await kernel.submit({
    idempotencyKey: 'start',
    operations: [
      {
        op: 'action.start',
        action: { id: 'a1', actorId: 'bot', intent: '去看看手机', targetIds: ['phone'], expectedEnd: 1200 },
      },
    ],
  })
}

/** 取那个到期动作。 */
function actionOf(kernel: WorldKernel): WorldAction {
  const action = kernel.snapshot.actions['a1']
  if (action === undefined) throw new Error('测试里没有动作 a1')
  return action
}

/** 可编程的假模型（按调用序号给不同回复）。 */
function scriptedModel(replies: { arguments?: unknown; text?: string }[]) {
  const requests: WorldModelRequest[] = []
  let index = 0
  const callModel = async (request: WorldModelRequest): Promise<{ arguments?: unknown; text?: string }> => {
    requests.push(request)
    const reply = replies[Math.min(index, replies.length - 1)] ?? {}
    index += 1
    return reply
  }
  return { requests, callModel, get calls() { return index } }
}

/** 一条合法的结算（完成）。 */
function completed(): { arguments: { operations: unknown[] } } {
  return {
    arguments: {
      operations: [{ op: 'action.finish', id: 'a1', status: 'completed', reason: '看完了手机' }],
    },
  }
}

describe('T25 —— 模型给提案，但**不写文件**', () => {
  it('⭐ 合法提案被返回，且**没有提交**（提交是 runtime 的职责）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const before = kernel.transactionCount

    const model = scriptedModel([completed()])
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, warn: (m) => warnings.push(m) })

    const proposal = await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)

    expect(proposal).toBeDefined()
    expect(proposal?.operations).toHaveLength(1)
    expect(proposal?.idempotencyKey).toBe('settle:a1') // 确定性：一个动作只结算一次
    expect(proposal?.source).toBe('world-llm')
    expect(kernel.transactionCount).toBe(before) // ⚠️ 一个字节都没写
    expect(kernel.snapshot.actions['a1']?.status).toBe('pending') // 世界没变
  })

  // 现场形状（2026-10-01）：真实动作 id 带 `act:` 前缀（`act:tool.9.4`），而模型会把它
  // 抄成裸的 `tool.9.4` —— 提示词里动作 id 就列在一串裸实体 id 下面。内核回
  // UNKNOWN_ACTION，两次重试的调用全烧掉，动作留在 pending 下一拍再赌一次。
  it('⭐ 模型把动作 id 抄错也照样结算（finish 的 id 由裁定器强制填）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const model = scriptedModel([
      { arguments: { operations: [{ op: 'action.finish', id: '1', status: 'completed', reason: '看完了手机' }] } },
    ])
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, warn: (m) => warnings.push(m) })

    const proposal = await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)

    // 非空本身就说明内核认了这条提案（不认的话 adjudicate 会耗尽重试返回 null）
    expect(proposal?.operations).toEqual([
      { op: 'action.finish', id: 'a1', status: 'completed', reason: '看完了手机' },
    ])
    expect(model.calls).toBe(1) // 一次就过，没烧重试
    expect(warnings).toEqual([])
  })

  it('只改 finish 的 id：别的操作（update / say）引用的实体 id 原样保留', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const model = scriptedModel([
      {
        arguments: {
          operations: [
            { op: 'action.finish', id: '抄错了', status: 'completed', reason: '看完了手机' },
            { op: 'update', id: 'phone', changes: { attributes: { 电量: { value: '11%', visibility: 'hidden' } } } },
          ],
        },
      },
    ])
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, warn: (m) => warnings.push(m) })

    const proposal = await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)

    expect((proposal?.operations ?? [])[0]).toMatchObject({ op: 'action.finish', id: 'a1' })
    expect((proposal?.operations ?? [])[1]).toMatchObject({ op: 'update', id: 'phone' })
  })

  it('工具纪律：请求里带 `propose_world`（对应 `tool_choice: required`）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const model = scriptedModel([completed()])
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, warn: (m) => warnings.push(m) })
    await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)

    expect(model.requests[0]?.tool.name).toBe('propose_world')
    expect(model.requests[0]?.tool).toBe(PROPOSE_WORLD)
    expect(PROPOSE_WORLD.schema).toBeDefined()
  })
})

describe('T25 —— 校验反馈循环（模型靠机读诊断自我修正）', () => {
  it('⭐ 第一次提案引用不存在的实体 → 诊断喂回去 → 第二次改对', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const model = scriptedModel([
      // 第一次：引用一个不存在的茶杯（模型编的）
      {
        arguments: {
          operations: [
            { op: 'action.finish', id: 'a1', status: 'completed', reason: '拿起了茶杯' },
            { op: 'move', id: 'teacup', location: 'house' },
          ],
        },
      },
      completed(), // 第二次：改对了
    ])
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, warn: (m) => warnings.push(m) })

    const proposal = await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)

    expect(model.calls).toBe(2) // 重提了一次
    expect(proposal).toBeDefined()
    expect(proposal?.operations).toHaveLength(1) // 只剩合法的那条

    // ⚠️ 第二次的提示词里带着**机读诊断**（模型据此改对）
    const second = model.requests[1]?.prompt ?? ''
    expect(second).toContain('上一次的提案被拒')
    expect(second).toContain('UNKNOWN_ENTITY')
    expect(second).toContain('teacup')
    expect(warnings.some((m) => m.includes('未通过校验'))).toBe(true)
  })

  it('用尽重试 → `null`（"这次裁不了"，运行时保持 pending 等下一拍）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const bad = { arguments: { operations: [{ op: 'move', id: '不存在的', location: null }] } }
    const model = scriptedModel([bad]) // 每次都同样的坏提案
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, maxAttempts: 2, warn: (m) => warnings.push(m) })

    expect(await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)).toBeNull()
    expect(model.calls).toBe(2)
    expect(warnings.some((m) => m.includes('都没给出合法提案'))).toBe(true)
    expect(kernel.transactionCount).toBe(2) // 仍然只有创世与 start
  })

  it('模型没给工具调用（arguments 缺失）→ 也提示它用工具', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const model = scriptedModel([{ text: '我觉得她应该成功了' }, completed()])
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, warn: (m) => warnings.push(m) })

    const proposal = await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)

    expect(proposal).toBeDefined()
    expect(model.requests[1]?.prompt).toContain('你没有用 propose_world')
  })

  it('动作不存在 / 类目非法 → 同样走反馈循环（不是直接放弃）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const model = scriptedModel([
      { arguments: { operations: [{ op: '爆炸', id: 'a1' }] } },
      completed(),
    ])
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, warn: (m) => warnings.push(m) })

    const proposal = await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)

    expect(proposal).toBeDefined()
    expect(model.requests[1]?.prompt).toContain('UNKNOWN_OPERATION')
  })
})

describe('T25 —— 视角差异与无状态', () => {
  it('⭐ 提示词给裁定者**内部 id** 与 **hidden 属性**（与她看到的句柄相反）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const prompt = renderContext(actionOf(kernel), kernel.snapshot)

    expect(prompt).toContain('house') // 内部 id（它要写提案）
    expect(prompt).toContain('phone')
    expect(prompt).toContain('电量') // hidden 属性：世界真相那一侧
    expect(prompt).toContain('去看看手机') // 到期动作的意图
    expect(prompt).toContain('不能替她说话') // 纪律写进提示词
    expect(prompt).not.toContain('seen:') // 句柄是**她**的限制，不是世界的限制
  })

  it('⭐ 无状态：每次裁定都从传入的快照重建（"世界已变"天然被处理）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const model = scriptedModel([completed()])
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, warn: (m) => warnings.push(m) })

    // 第一次裁定后，世界被改（手机移到了街上）
    await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)
    await kernel.submit({
      idempotencyKey: 'move',
      operations: [
        { op: 'create', entity: { id: 'street', kind: 'place', name: '很宽的街道', location: null } },
        { op: 'move', id: 'phone', location: 'street' },
      ],
    })

    // 第二次裁定：提示词反映的是**改之后**的世界
    await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)
    const second = model.requests[1]?.prompt ?? ''
    expect(second).toContain('street')
    expect(second).toContain('在 street') // 手机现在在街上
  })

  it('提示词里写明"现在是几点、期望何时完成"（模型据此判"超时了吗"）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    // 把世界时间推后（动作期望 1200 完成，现在 2000）
    await kernel.submit({
      idempotencyKey: 'tick',
      effectiveAt: 2000,
      operations: [{ op: 'say', actorId: 'bot', text: '（时间流逝）' }],
    })

    const prompt = renderContext(actionOf(kernel), kernel.snapshot)
    expect(prompt).toContain('期望 1200 完成')
    expect(prompt).toContain('现在是 2000')
  })

  it('模型返回的提案形状不对（operations 不是数组）→ 走反馈循环', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const model = scriptedModel([{ arguments: { operations: '不是数组' } }, completed()])
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, warn: (m) => warnings.push(m) })

    expect(await arbiter.adjudicate(actionOf(kernel), kernel.snapshot)).toBeDefined()
    expect(model.calls).toBe(2)
  })

  it('快照类型不变：裁定不修改传入的 world（无副作用）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const snapshot: WorldSnapshot = kernel.snapshot
    const frozen = JSON.stringify(snapshot)
    const model = scriptedModel([completed()])
    const arbiter = new WorldArbiter({ kernel, callModel: model.callModel, warn: (m) => warnings.push(m) })

    await arbiter.adjudicate(actionOf(kernel), snapshot)

    expect(JSON.stringify(snapshot)).toBe(frozen) // 一份没动
  })
})