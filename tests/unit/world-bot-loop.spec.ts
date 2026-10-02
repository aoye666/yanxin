/**
 * Bot-LLM 循环的验收（T24c，spec §6.7）。
 *
 * 四组：
 *   ① **一轮的形状**：observe → decide → 翻译 → 提交；`duration` 换成 `expectedEnd`
 *   ② **句柄是唯一的指路方式**：模型给 `seen:n`，循环解析回真实 id；
 *      **瞎编的句柄让这一轮作废**（不猜、不提交）
 *   ③ **结果注入**：上一批动作的结算结果进下一轮的 `notices`，消费一次
 *   ④ **她的视角是投影出来的**（集成 T24a）：观测里看不到屋外的东西，也没有内部 id
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BotLoop, type Intent, type TurnContext } from '../../src/world/bot-loop.ts'
import { WorldKernel } from '../../src/world/kernel.ts'

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
  const dir = await mkdtemp(join(tmpdir(), 'yanxin-botloop-'))
  dirs.push(dir)
  return dir
}

/** 创世：小研 + 房子 + 手机 + 街上（同级）。 */
async function seed(kernel: WorldKernel): Promise<void> {
  await kernel.submit({
    idempotencyKey: 'genesis',
    operations: [
      { op: 'create', entity: { id: 'bot', kind: 'actor', name: '小研', location: 'house' } },
      { op: 'create', entity: { id: 'house', kind: 'place', name: '小房子', location: null } },
      { op: 'create', entity: { id: 'street', kind: 'place', name: '很宽的街道', location: null } },
      { op: 'create', entity: { id: 'phone', kind: 'object', name: '手机', location: 'house', owner: 'bot' } },
    ],
    source: 'bootstrap',
  })
}

/** 可控世界时钟。 */
function fakeClock(start = 1000) {
  let value = start
  return {
    now: () => value,
    set(next: number): void {
      value = next
    },
  }
}

/** 造一个循环（决策函数由各用例给）。 */
async function makeLoop(options: {
  kernel: WorldKernel
  decide: (context: TurnContext) => Promise<Intent | null>
  clock?: ReturnType<typeof fakeClock>
}): Promise<{ loop: BotLoop; clock: ReturnType<typeof fakeClock> }> {
  const clock = options.clock ?? fakeClock(1000)
  const loop = new BotLoop({
    kernel: options.kernel,
    clock,
    selfId: 'bot',
    decide: options.decide,
    warn: (message) => warnings.push(message),
  })
  return { loop, clock }
}

describe('T24c —— 一轮的形状（observe → decide → 翻译 → 提交）', () => {
  it('`act` 意图 → 世界多了一个 pending 动作', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const { loop } = await makeLoop({
      kernel,
      decide: async (context) => {
        // 她看见手机（在观测里找一个"手机"）
        const phone = context.observation.entities.find((item) => item.name === '手机')
        return { kind: 'act', intent: '去看看手机', handle: phone?.handle, duration: 300 }
      },
    })

    const result = await loop.runOnce()

    expect(result.kind).toBe('act')
    expect(result.sequence).toBeDefined()
    const action = Object.values(kernel.snapshot.actions)[0]
    expect(action?.intent).toBe('去看看手机')
    expect(action?.status).toBe('pending')
  })

  it('⭐ `duration` 换成 `expectedEnd = 生成时刻 + duration`', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(5000)

    const { loop } = await makeLoop({
      kernel,
      clock,
      decide: async () => ({ kind: 'act', intent: '沿街走走', duration: 900 }),
    })

    await loop.runOnce()

    const action = Object.values(kernel.snapshot.actions)[0]
    expect(action?.expectedEnd).toBe(5900) // 5000 + 900
    expect(action?.startedAt).toBe(5000)
  })

  it('`wait` / `rest` 同样映射成"要花时间的动作"（意图文本区分）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const { loop } = await makeLoop({
      kernel,
      decide: async () => ({ kind: 'rest', duration: 1800 }),
    })
    await loop.runOnce()

    const action = Object.values(kernel.snapshot.actions)[0]
    expect(action?.intent).toBe('歇一会儿') // 没给 intent 时的兜底措辞
    expect(action?.expectedEnd).toBe(1000 + 1800)
  })

  it('`say` 意图 → 世界里多了一句她的话', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const { loop } = await makeLoop({
      kernel,
      decide: async () => ({ kind: 'say', text: '今天街上风很大' }),
    })
    await loop.runOnce()

    expect(kernel.snapshot.utterances.map((item) => item.text)).toEqual(['今天街上风很大'])
    expect(kernel.snapshot.utterances[0]?.speakerId).toBe('bot')
  })

  it('`nothing` / `null` 都是"她决定什么都不做"（不提案）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const nothing = await makeLoop({ kernel, decide: async () => ({ kind: 'nothing' }) })
    expect((await nothing.loop.runOnce()).kind).toBe('nothing')

    const nullIntent = await makeLoop({ kernel, decide: async () => null })
    expect((await nullIntent.loop.runOnce()).kind).toBe('nothing')

    expect(kernel.transactionCount).toBe(1) // 只有创世
  })

  it('决策函数抛错 → 告警 + 按"什么都不做"处理（不因为一次失败停摆）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const { loop } = await makeLoop({
      kernel,
      decide: async () => {
        throw new Error('LLM 掉线了')
      },
    })

    expect((await loop.runOnce()).kind).toBe('nothing')
    expect(warnings.some((message) => message.includes('决策失败'))).toBe(true)
  })

  it('⭐ 她自己不在世界里 → **抛错**（配置错误要响亮，不掩盖）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    // selfId 配错了 —— 这不是"运行时状况"而是装配错误：`observe` 直接抛（T24a 的纪律），
    // runOnce 让它穿出去。上层（T27 的调度）该在装配期就拦住这种错误。
    const loop = new BotLoop({
      kernel,
      clock: fakeClock(1000),
      selfId: '不存在的人',
      decide: async () => ({ kind: 'say', text: '你好' }),
      warn: (message) => warnings.push(message),
    })

    await expect(loop.runOnce()).rejects.toThrow(/世界里没有/)
    expect(kernel.transactionCount).toBe(1) // 什么都没提交
  })
})

describe('T24c —— 句柄是唯一的指路方式', () => {
  it('⭐ 模型给句柄，循环解析回**真实 id**（提案里是 id，不是句柄）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    let seenHandle = ''
    const { loop } = await makeLoop({
      kernel,
      decide: async (context) => {
        const phone = context.observation.entities.find((item) => item.name === '手机')
        seenHandle = phone?.handle ?? ''
        return { kind: 'act', intent: '拿手机', handle: phone?.handle, duration: 10 }
      },
    })

    await loop.runOnce()

    expect(seenHandle).toMatch(/^seen:/) // 模型看到的是句柄
    const action = Object.values(kernel.snapshot.actions)[0]
    expect(action?.targetIds).toEqual(['phone']) // 世界里落的是真实 id
    expect(JSON.stringify(action)).not.toContain('seen:')
  })

  it('⭐ 瞎编句柄（`seen:99`）→ 这一轮作废：**不猜、不提交**', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const { loop } = await makeLoop({
      kernel,
      decide: async () => ({ kind: 'act', intent: '拿一个不存在的东西', handle: 'seen:99', duration: 10 }),
    })

    const result = await loop.runOnce()

    expect(result.rejected).toContain('没有这个句柄')
    expect(kernel.snapshot.actions).toEqual({}) // 什么都没提交
    expect(kernel.transactionCount).toBe(1) // 只有创世
    expect(warnings.some((message) => message.includes('无法翻译'))).toBe(true)
  })

  it('`say` 不需要句柄（她说话不用指着什么）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const { loop } = await makeLoop({ kernel, decide: async () => ({ kind: 'say', text: '嗯' }) })
    const result = await loop.runOnce()
    expect(result.rejected).toBeUndefined()
  })
})

describe('T24c —— 结果注入（她"想起来"刚做完的事）', () => {
  it('⭐ 结算结果进下一轮的 `notices`，并且**只给一次**（消费后清空）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const contexts: TurnContext[] = []
    const { loop } = await makeLoop({
      kernel,
      decide: async (context) => {
        contexts.push(context)
        return { kind: 'nothing' }
      },
    })

    // runtime 的 onOutcome 会调到这里
    loop.feed({ actionId: 'a1', status: 'completed', summary: '去看看手机：做完了', at: 1200 })
    loop.feed({ actionId: 'a2', status: 'failed', summary: '沿街走走：下雨了', at: 1300 })

    await loop.runOnce()
    expect(contexts[0]?.notices).toEqual(['做完了：去看看手机：做完了', '没做成：沿街走走：下雨了'])

    // 第二轮：不再重复提（她已经"想起来"过了）
    await loop.runOnce()
    expect(contexts[1]?.notices).toEqual([])
    expect(loop.notices).toEqual([])
  })

  it('取消的结果措辞不同（"没做成（中途放弃了）"）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const contexts: TurnContext[] = []
    const { loop } = await makeLoop({
      kernel,
      decide: async (context) => {
        contexts.push(context)
        return null
      },
    })

    loop.feed({ actionId: 'a1', status: 'cancelled', summary: '沿街走走', at: 1100 })
    await loop.runOnce()

    expect(contexts[0]?.notices[0]).toContain('没做成（中途放弃了）')
  })

  it('⭐ decide 抛错 → 这批通知**放回**（错误处理只吞错误，不吞数据）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)

    const contexts: TurnContext[] = []
    let fail = true
    const { loop } = await makeLoop({
      kernel,
      decide: async (context) => {
        contexts.push(context)
        if (fail) throw new Error('会话炸了')
        return { kind: 'nothing' }
      },
    })

    loop.feed({ actionId: 'a1', status: 'completed', summary: '去看看手机：做完了', at: 1200 })

    // 第一轮：decide 抛错 —— 她连世界都没看到，这批通知不能算"被想起了"
    await loop.runOnce()
    expect(warnings.some((message) => message.includes('决策失败'))).toBe(true)
    expect(loop.notices).toEqual(['做完了：去看看手机：做完了']) // 放回了

    // 下一轮恢复：她看到那批通知，正常消费掉
    fail = false
    await loop.runOnce()
    expect(contexts[1]?.notices).toEqual(['做完了：去看看手机：做完了'])
    expect(loop.notices).toEqual([])
  })
})

describe('T24c —— 她的视角是投影出来的（集成 T24a）', () => {
  it('⭐ 默认投影：在屋里看不到街上的东西；观测量没有内部 id', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    // 街上放点东西（她看不到）
    await kernel.submit({
      idempotencyKey: 'add-shop',
      operations: [{ op: 'create', entity: { id: 'shop', kind: 'place', name: '杂货店', location: 'street' } }],
    })

    let seen: TurnContext['observation'] | undefined
    const { loop } = await makeLoop({
      kernel,
      decide: async (context) => {
        seen = context.observation
        return null
      },
    })

    await loop.runOnce()

    const names = (seen?.entities ?? []).map((item) => item.name)
    expect(names).toContain('小房子')
    expect(names).toContain('手机')
    expect(names).toContain('很宽的街道') // 同级 → 只有名字
    expect(names).not.toContain('杂货店') // 街上的店 → 看不到
    expect(JSON.stringify(seen)).not.toContain('"house"') // 没有内部 id
  })

  it('决策函数拿得到当前世界时刻（它要据此估 duration）', async () => {
    const dir = await makeDir()
    const kernel = await WorldKernel.open(dir)
    await seed(kernel)
    const clock = fakeClock(4242)

    let at = 0
    const { loop } = await makeLoop({
      kernel,
      clock,
      decide: async (context) => {
        at = context.at
        return null
      },
    })

    await loop.runOnce()
    expect(at).toBe(4242)
  })
})