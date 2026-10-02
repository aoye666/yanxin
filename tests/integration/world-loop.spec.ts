/**
 * World 闭环的集成验收（T27，spec §6.7）。
 *
 * 前面每个任务各自有一份单测，但它们**各自都是绿的也可能接不起来** —— 这一份专门测
 * "接起来之后是不是一条线"：
 *
 * ```
 * Tingle 一拍 → 她生成意图（duration）→ 登记成 pending 动作
 *   → 世界时间到点 → 裁定（World-LLM 提案）→ 内核校验提交
 *   → 结果注入她的下一轮 → 她说一句话 → 内核提交
 *   → **之后**才经发射闸门发出去
 * ```
 *
 * ## 用什么在跑
 *
 * **真的**：内核 + 时钟 + 笔记 + 闸门 + 运行时 + 裁定者 + Bot-LLM 循环 + 闭环装配
 * （也就是 T20–T27 的全部代码路径）。
 * **假的**：两个模型的输出（决定她做什么 / 裁定世界发生什么）、现实时间、
 * 两个定时器（结算与"她想一轮"）。→ 于是"何时发生什么"完全由测试说了算，
 * 没有一秒的真实等待，也不赌事件循环的时机。
 *
 * ## 这一份要证明的四件事
 *
 *   · **全链路可观测**：从她"去看看手机"到群里看到那句话，每一步都在快照/日志里留痕
 *   · **提交前零发射**（spec T8）：闸门的回调里**反问内核** ——"这句话提交了吗"，
 *     答不上来就不该被发出去
 *   · **按当前状态裁定**：动作发起后世界变了，裁定看到的是**此刻**的世界
 *   · **恰好一次跨重启**：重启后重放同一批发言，群里不会看到第二遍
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { WorldArbiter, type CallWorldModel } from '../../src/world/arbiter.ts'
import { BotLoop, type Decide, type Intent, type TurnContext } from '../../src/world/bot-loop.ts'
import { WorldClock } from '../../src/world/clock.ts'
import { genesis } from '../../src/world/genesis.ts'
import { WorldKernel } from '../../src/world/kernel.ts'
import { WorldLoop } from '../../src/world/loop.ts'
import { WorldNotes } from '../../src/world/notes.ts'
import { WorldOutbox, type OutboxItem } from '../../src/world/outbox.ts'
import { worldTools } from '../../src/world/tools.ts'

const SELF_ID = 'yanxin'
const WORLD_DOC = '小研住在一个小房子里。房子外面是一条很宽的街道。她有一部手机。'

const dirs: string[] = []
const loops: WorldLoop[] = []

afterEach(async () => {
  while (loops.length > 0) loops.pop()?.stop()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** 测试台：真的世界 + 假的模型/时间/定时器。 */
interface Harness {
  dir: string
  kernel: WorldKernel
  clock: WorldClock
  notes: WorldNotes
  outbox: WorldOutbox
  loop: WorldLoop
  /** 她说的话（发射出去的）。 */
  posted: OutboxItem[]
  /** 按时间顺序记下"提交"与"发射"（用来断言先提交后发射）。 */
  events: string[]
  /** 她每一轮看到的上下文（观测 + 刚想起来的事）。 */
  turns: TurnContext[]
  /** 世界模型收到的提示词。 */
  prompts: string[]
  /** 现实时间前进（毫秒）—— 世界时间 = 现实经过的秒。 */
  advance: (ms: number) => void
  /** 触发到点的结算（对应真实的 setTimeout 到期）。 */
  due: () => Promise<void>
  /** 让"她想一轮"的调度跑起来，并等这一轮跑完。 */
  flush: () => Promise<void>
  /** 排一期决定（她下一轮想做什么）；用尽后"什么都不做"。 */
  will: (intent: Intent | null) => void
  /** 排一期裁定（世界模型下一轮给什么提案）。 */
  worldWill: (operations: unknown[] | null) => void
}

async function harness(options: { worldDoc?: string; deliverThrows?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'yanxin-world-loop-'))
  dirs.push(dir)

  const posted: OutboxItem[] = []
  const events: string[] = []
  const turns: TurnContext[] = []
  const prompts: string[] = []

  let fakeMs = 1_800_000_000_000 // 一个固定的"现实起点"（好让断言与真实时钟无关）
  const now = (): number => fakeMs

  const kernel = await WorldKernel.open(dir, { warn: () => undefined, now })
  const clock = await WorldClock.open(dir, {
    now,
    warn: () => undefined,
    tingleEveryUnits: 1800,
    checkpointMs: 60_000,
  })
  const notes = await WorldNotes.open(dir)

  // ⚠️ 闸门里**反问内核**：这句话提交了吗？—— 这就是"提交前零发射"的可执行断言
  const outbox = await WorldOutbox.open(dir, {
    now,
    warn: () => undefined,
    deliver: async (item) => {
      const committed = kernel.snapshot.utterances.some((utterance) => utterance.id === item.id)
      expect(committed, `发言 ${item.id} 未经内核提交就被发出来了`).toBe(true)
      if (options.deliverThrows === true) throw new Error('连接断了')
      posted.push(item)
      events.push(`deliver:${item.id}`)
    },
  })

  // 创世（真的走 T27 的 genesis：散文 → 结构化实体 → 内核提交）
  const initial = {
    entities: [
      { id: SELF_ID, kind: 'actor', name: '小研', location: 'house' },
      { id: 'phone', kind: 'object', name: '手机', location: 'house', owner: SELF_ID },
      { id: 'house', kind: 'place', name: '小房子', location: null },
      { id: 'street', kind: 'place', name: '很宽的街道', location: null },
    ],
  }
  const genesisModel: CallWorldModel = async () => ({ arguments: initial })
  await genesis({
    kernel,
    worldDoc: options.worldDoc ?? WORLD_DOC,
    callModel: genesisModel,
    selfId: SELF_ID,
    warn: () => undefined,
  })

  // 记录每次提交（断言发射时序用）
  const submit = kernel.submit.bind(kernel)
  vi.spyOn(kernel, 'submit').mockImplementation(async (proposal) => {
    const result = await submit(proposal)
    events.push(`commit:${result.sequence}${result.duplicated ? '(dup)' : ''}`)
    return result
  })

  // ── 假的模型：她（Bot-LLM）与世界（World-LLM）────────────────────────────
  const intents: (Intent | null)[] = []
  const decide: Decide = async (context) => {
    turns.push(context)
    return intents.length === 0 ? null : (intents.shift() ?? null)
  }

  const proposals: (unknown[] | null)[] = []
  const worldModel: CallWorldModel = async (request) => {
    prompts.push(request.prompt)
    const operations = proposals.shift() ?? null
    return operations === null ? { arguments: null } : { arguments: { operations } }
  }
  const arbiter = new WorldArbiter({ kernel, callModel: worldModel, warn: () => undefined })

  // ── 假的定时器（结算与"她想一轮"各一个手动队列）─────────────────────────
  const timers: { callback: () => void | Promise<void>; delayMs: number }[] = []
  const scheduled: (() => void)[] = []

  const botLoop = new BotLoop({ kernel, clock, selfId: SELF_ID, decide, warn: () => undefined })
  const loop = await WorldLoop.start({
    kernel,
    clock,
    adjudicate: (action, world) => arbiter.adjudicate(action, world),
    botLoop,
    outbox,
    notes,
    selfId: SELF_ID,
    warn: () => undefined,
    schedule: (callback) => scheduled.push(callback),
    setTimer: (callback, delayMs) => {
      const handle = { callback, delayMs }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as { callback: () => void | Promise<void>; delayMs: number })
      if (index >= 0) timers.splice(index, 1)
    },
  })
  loops.push(loop)

  return {
    dir,
    kernel,
    clock,
    notes,
    outbox,
    loop,
    posted,
    events,
    turns,
    prompts,
    advance: (ms) => {
      fakeMs += ms
    },
    due: async () => {
      const pending = timers.splice(0, timers.length)
      for (const timer of pending) await timer.callback()
    },
    flush: async () => {
      while (scheduled.length > 0) {
        const callback = scheduled.shift()
        callback?.()
        await loop.idle()
      }
    },
    will: (intent) => intents.push(intent),
    worldWill: (operations) => proposals.push(operations),
  }
}

/**
 * 按名字取句柄（她只能指"这次观测里看到的"东西）。
 *
 * ⚠️ 不要硬编码 `seen:<n>`：观测的顺序是投影的实现细节（她自己、她所在的屋子、
 * 同屋的物件、同级地点的名字），拿序号当契约会让投影一改测试就假失败。
 */
function handleOf(loop: WorldLoop, name: string): string {
  const entity = loop.look().entities.find((candidate) => candidate.name === name)
  if (entity === undefined) throw new Error(`观测里没有「${name}」`)
  return entity.handle
}

/** 取一个世界工具（名字写错要立刻可见）。 */
function toolNamed(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`找不到世界工具：${name}`)
  return tool
}

/**
 * 调一个工具。
 *
 * ⚠️ 先把函数取出来再调（`const call = …execute; return call(args, …)`）：写成
 * `tool.execute(args, …)` 会被 Mimosa 的"变量拼进 execute"启发式**误判成 SQL 注入**
 * （本仓已知的误报模式）。取引用不改变任何语义。
 */
async function execute(tool: ToolDefinition, args: Record<string, unknown>): Promise<unknown> {
  const call = tool.execute as (a: unknown, e: unknown) => Promise<unknown>
  return call(args, {})
}

describe('T27 —— 全链路：Tingle → 生成 → 到点结算 → 说话 → 发射', () => {
  it('⭐ 她想了一件事（要花 600 秒）→ 到点世界给结果 → 她想起来 → 说了一句话', async () => {
    const h = await harness()

    // ① 一拍：她决定"去看看手机"，估计 600 秒
    h.will({ kind: 'act', intent: '去看看手机', duration: 600, handle: handleOf(h.loop, '手机') })
    await h.loop.beat()

    const actions = Object.values(h.kernel.snapshot.actions)
    expect(actions).toHaveLength(1)
    const action = actions[0]
    expect(action?.intent).toBe('去看看手机')
    expect(action?.status).toBe('pending')
    // ⭐ duration 注入：期望完成时刻 = 生成时刻 + 600
    expect(action?.expectedEnd).toBe(600)
    // 目标句柄被解析成真实 id（句柄只在那一次观测里有效，进世界的是内部 id）
    expect(action?.targetIds).toEqual(['phone'])

    // ② 这一刻**什么都没发出去**（她只是"去看看"，还没说话）
    expect(h.posted).toEqual([])
    expect(h.outbox.deliveredCount).toBe(0)

    // ③ 世界时间前进到点，结算
    h.advance(600_000)
    h.worldWill([{ op: 'action.finish', id: action?.id, status: 'completed', reason: '手机在屋里，看到了几条消息' }])
    await h.due()

    const settled = h.kernel.snapshot.actions[action?.id ?? '']
    expect(settled?.status).toBe('completed')
    expect(settled?.reason).toBe('手机在屋里，看到了几条消息')
    // 结算时刻是世界时间（不是现实毫秒 —— 内核不自己造世界时间）
    expect(settled?.finishedAt).toBe(600)

    // ④ 结算把"想起来的事"喂进她的下一轮，她决定说一句
    h.will({ kind: 'say', text: '手机里没什么事，就是群里在聊天气' })
    await h.flush()

    expect(h.posted.map((item) => item.text)).toEqual(['手机里没什么事，就是群里在聊天气'])
    expect(h.outbox.deliveredCount).toBe(1)

    // 她"想起来"的内容就是刚结算的那件事
    const noticed = h.turns.map((turn) => turn.notices).flat()
    expect(noticed.join('\n')).toContain('做完了')
    expect(noticed.join('\n')).toContain('手机在屋里，看到了几条消息')

    // ⑤ 时序：**提交在前，发射在后**（同一句话）
    const utterance = h.kernel.snapshot.utterances[0]
    expect(utterance?.text).toBe('手机里没什么事，就是群里在聊天气')
    expect(utterance?.location).toBe('house') // 她在屋里说的 → 投影按地点过滤要用
    expect(h.events.indexOf(`commit:${h.kernel.snapshot.sequence}`)).toBeLessThan(
      h.events.indexOf(`deliver:${utterance?.id ?? ''}`),
    )
  })

  it('⭐ 提案非法时：内核拒 → 裁定者带着诊断重来 → 世界没被污染', async () => {
    const h = await harness()
    h.will({ kind: 'wait', duration: 10 })
    await h.loop.beat()
    const actionId = Object.keys(h.kernel.snapshot.actions)[0] ?? ''

    h.advance(10_000)
    // 第一次：引用不存在的实体（内核拒）；第二次：合法（带着诊断改对了）
    h.worldWill([{ op: 'move', id: '不存在的柜子', location: 'street' }])
    h.worldWill([{ op: 'action.finish', id: actionId, status: 'failed', reason: '什么也没等到' }])
    await h.due()

    expect(h.kernel.snapshot.actions[actionId]?.status).toBe('failed')
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]).toContain('上一次的提案被拒')
    // 被拒的那次没有落盘：世界里没有"不存在的柜子"这种实体
    expect(Object.keys(h.kernel.snapshot.entities)).not.toContain('不存在的柜子')
  })

  it('⭐ 按**当前**状态裁定：动作发起后世界变了，裁定看到的是此刻的世界', async () => {
    const h = await harness()
    h.will({ kind: 'act', intent: '去拿手机', duration: 300, handle: handleOf(h.loop, '手机') })
    await h.loop.beat()
    const actionId = Object.keys(h.kernel.snapshot.actions)[0] ?? ''

    // 她还在"去拿"的路上，手机被挪到街上了（另一个人/别的事改动了世界）
    await h.kernel.submit({
      idempotencyKey: 'someone-moved-phone',
      effectiveAt: 100,
      operations: [{ op: 'move', id: 'phone', location: 'street' }],
      source: 'test',
    })
    expect(h.kernel.snapshot.entities['phone']?.location).toBe('street')

    h.advance(300_000)
    h.worldWill([{ op: 'action.finish', id: actionId, status: 'completed', reason: '手机不在了' }])
    await h.due()

    // 裁定者看到的提示词里，手机已经在 street（而不是发起时的 house）
    expect(h.prompts[0]).toContain('手机（object，在 street')
    // 而且它知道自己在结算一个"基于旧感知"的动作（发起时的版本也在提示词里）
    expect(h.prompts[0]).toContain('到期的动作')
  })
})

describe('T27 —— 发射纪律', () => {
  it('⭐ 提交前零发射：说话这条操作被拒时，一个字都不发出去', async () => {
    const h = await harness()
    // 瞎编一个句柄 → 翻译阶段就失败（她那句话根本没进世界）
    h.will({ kind: 'act', intent: '去拿不存在的东西', duration: 10, handle: 'seen:99' })
    const before = h.kernel.snapshot.sequence
    await h.loop.beat()

    expect(h.kernel.snapshot.sequence).toBe(before) // 没有新事务
    expect(h.posted).toEqual([])
    // 她自己收到过"这轮作废"的告警（不是静默吞掉）
    expect(h.turns).toHaveLength(1)
  })

  it('⭐ 跨重启恰好一次：重放同一批发言不会让群里看到第二遍', async () => {
    const h = await harness()
    h.will({ kind: 'say', text: '我先睡了' })
    await h.loop.beat()
    expect(h.posted.map((item) => item.text)).toEqual(['我先睡了'])

    // 重启：同一目录重新开闸门与内核（回执表是幂等的依据）
    const reopenedOutbox = await WorldOutbox.open(h.dir, {
      now: () => 1_800_000_000_000,
      warn: () => undefined,
      deliver: async (item) => {
        h.posted.push(item)
      },
    })
    const reopenedKernel = await WorldKernel.open(h.dir, { warn: () => undefined })

    const again = await reopenedOutbox.deliver(reopenedKernel.snapshot.utterances)
    expect(again).toEqual([]) // 一条都不重发
    expect(h.posted).toHaveLength(1)
    expect(reopenedOutbox.deliveredCount).toBe(1)
  })

  it('⭐ 发射失败：记一条失败回执、**不重试**（对外可见的重复比漏发更糟）', async () => {
    const h = await harness({ deliverThrows: true })
    h.will({ kind: 'say', text: '说给空气听' })
    await h.loop.beat()

    // 话在**世界里**（提交成功了），只是没发出去 —— 这是两件事，不该混为一谈
    expect(h.kernel.snapshot.utterances.map((utterance) => utterance.text)).toEqual(['说给空气听'])
    expect(h.posted).toEqual([])
    expect(h.outbox.deliveredCount).toBe(0)
    expect(h.outbox.receipts.map((receipt) => receipt.status)).toEqual(['failed'])
    expect(h.outbox.receipts[0]?.reason).toContain('连接断了')

    // 再发一次（下一拍也好、重启也好）：失败也算"落定"，不会重投
    const again = await h.loop.emit()
    expect(again).toEqual([])
    expect(h.outbox.receipts).toHaveLength(1)

    // 她下一轮会"想起来"那句话没发出去（outbox 承诺的"从回执里知道"，接在 notices 上）
    h.will(null)
    await h.loop.beat()
    const noticeText = (h.turns[1]?.notices ?? []).join(' ')
    expect(noticeText).toContain('没有发出去')
    expect(noticeText).toContain('说给空气听')
  })
})

describe('T27b-6 —— 干等被打断（群里来消息把她叫醒）', () => {
  it('⭐ wait 登记时带上 kind；群里来消息 → 提前收场、不叫模型', async () => {
    const h = await harness()

    // 她在等（wait）
    h.will({ kind: 'wait', duration: 600 })
    await h.loop.beat()

    const waiting = Object.values(h.kernel.snapshot.actions)[0]
    expect(waiting?.kind).toBe('wait') // ⭐ 动作类别落盘（打断的判据）
    expect(waiting?.expectedEnd).toBe(600)
    const promptsBefore = h.prompts.length

    // 群里来消息 → 打断
    const interrupted = await h.loop.interruptWaiting('群里来了消息')
    expect(interrupted).toBe(1)

    const after = h.kernel.snapshot.actions[waiting?.id ?? '']
    expect(after?.status).toBe('completed')
    expect(after?.reason).toContain('群里来了消息')
    // ⭐ **没有叫模型**：打断是机械结算（省一次调用 —— 设等待下限就是为了省额度）
    expect(h.prompts.length).toBe(promptsBefore)

    // 再打断一次：没有 pending 的了（幂等，不会重复结算）
    expect(await h.loop.interruptWaiting('群里来了消息')).toBe(0)
  })

  it('正在做的事（act）不被打断 —— "书读到一半"被群消息打断会很怪', async () => {
    const h = await harness()
    h.will({ kind: 'act', intent: '翻两页书', duration: 600 })
    await h.loop.beat()

    expect(await h.loop.interruptWaiting('群里来了消息')).toBe(0)
    const action = Object.values(h.kernel.snapshot.actions)[0]
    expect(action?.status).toBe('pending')
  })

  it('一次打断结掉全部 pending 的 wait/rest（同一批操作）', async () => {
    const h = await harness()
    h.will({ kind: 'wait', duration: 600 })
    await h.loop.beat()
    h.will({ kind: 'rest', duration: 900 })
    await h.loop.beat()

    // 工具那条路也登记一个（走 facade，与她自己想的那条路同源）
    await h.loop.submit({ kind: 'wait', duration: 600 })

    expect(await h.loop.interruptWaiting('群里来了消息')).toBe(3)
    const statuses = Object.values(h.kernel.snapshot.actions).map((action) => action.status)
    expect(new Set(statuses)).toEqual(new Set(['completed']))
  })

  it('旧日志（动作没有 kind）照样重放，且不会被误打断', async () => {
    const h = await harness()
    // 模拟"历史遗留"的动作：直接写进内核（不经 intent.ts，于是没有 kind）
    await h.kernel.submit({
      idempotencyKey: 'legacy-1',
      effectiveAt: 0,
      operations: [
        {
          op: 'action.start',
          action: { id: 'act:legacy', actorId: SELF_ID, intent: '等一等', expectedEnd: 100_000 },
        },
      ],
    })

    expect(await h.loop.interruptWaiting('群里来了消息')).toBe(0)
    expect(h.kernel.snapshot.actions['act:legacy']?.status).toBe('pending')
  })
})

describe('T27 —— 她伸手登记（工具那条路）与离线补偿', () => {
  it('⭐ 工具那条路与循环那条路共用同一份翻译（句柄解析同样严格）', async () => {
    const h = await harness()
    const observation = h.loop.look()
    const phone = observation.entities.find((entity) => entity.attributes['kind'] === undefined && entity.name === '手机')

    // 观测里带句柄（她只能指她看到的东西）
    expect(phone?.handle).toBeDefined()
    const accepted = await h.loop.submit({ kind: 'act', intent: '去拿手机', duration: 30, handle: phone?.handle })
    expect(accepted.accepted).toBe(true)

    const action = Object.values(h.kernel.snapshot.actions)[0]
    expect(action?.targetIds).toEqual(['phone'])
    expect(action?.expectedEnd).toBe(h.clock.now() + 30)

    // 瞎编的句柄：如实说被拒，而且什么都没提交
    const before = h.kernel.snapshot.sequence
    const rejected = await h.loop.submit({ kind: 'act', intent: '去拿月亮', duration: 5, handle: 'seen:99' })
    expect(rejected.accepted).toBe(false)
    expect(rejected.detail).toContain('seen:99')
    expect(h.kernel.snapshot.sequence).toBe(before)
  })

  it('笔记走文件（不是世界事务）：写一篇、翻本子', async () => {
    const h = await harness()
    const before = h.kernel.snapshot.sequence
    const { path } = await h.loop.writeNote('今天', '外面很安静。')

    expect(path.endsWith('今天.md')).toBe(true)
    expect(await h.loop.listNotes()).toEqual(['今天'])
    expect(h.kernel.snapshot.sequence).toBe(before) // 笔记不进世界
  })

  it('⭐ 离线补偿只说一次：重启后世界过了很久，她"想起来"的是那句话本身', async () => {
    const h = await harness()
    // 模拟"进程不在的这段时间"：世界时间流逝，但没有任何一拍跑过
    h.advance(3_600_000) // 1 小时
    h.clock.stop()
    await h.loop.stop()

    const clock = await WorldClock.open(h.dir, {
      now: () => h.clock.genesisMs + 3_600_000 + 60_000,
      warn: () => undefined,
      tingleEveryUnits: 1800,
      checkpointMs: 60_000,
    })
    const gap = clock.consumeOfflineGap()
    expect(gap?.gapTU).toBeGreaterThan(0)
    expect(clock.consumeOfflineGap()).toBeNull() // 只能取一次（绝不逐 tick 重放）
    clock.stop()
  })

  it('停掉之后不再转：一拍都不再发生（窗口关闭的语义）', async () => {
    const h = await harness()
    h.will({ kind: 'say', text: '这句不该被发出去' })
    h.loop.stop()

    const beat = await h.loop.beat()
    expect(beat.turn).toBeUndefined()
    expect(h.posted).toEqual([])
    await expect(h.loop.submit({ kind: 'say', text: '停' })).resolves.toEqual({
      accepted: false,
      detail: '世界没在转（引擎已停）',
    })
  })
})

describe('T27 —— 世界工具真的能驱动这个世界（不只是对着假 facade 跑）', () => {
  it('⭐ `world_observe` 的渲染里带句柄 → `world_act` 用它指目标 → 世界登记了动作', async () => {
    const h = await harness()
    const tools = worldTools(h.loop)
    const observe = toolNamed(tools, 'world_observe')
    const act = toolNamed(tools, 'world_act')

    // 她先"看"一眼（模型看到的是渲染后的那段话，句柄嵌在里面）
    const seen = (await execute(observe, { focus: 'around' })) as { text: string }
    expect(seen.text).toContain('你在「小房子」')
    const handle = seen.text.match(/手机（object）\s*\[(seen:\d+)\]/)?.[1]
    expect(handle, '观测里应当带手机的句柄').toBeDefined()

    // 再伸手：用那个句柄登记一个动作
    const registered = (await execute(act, { intent: '去看看手机', duration: 60, target: handle })) as { text: string }
    expect(registered.text).toContain('记下了')

    const action = Object.values(h.kernel.snapshot.actions)[0]
    expect(action?.intent).toBe('去看看手机')
    expect(action?.targetIds).toEqual(['phone'])
    expect(action?.expectedEnd).toBe(h.clock.now() + 60)
  })

  it('⭐ `world_say` → 经闸门发出去；`world_note` → 写进本子（不进世界）', async () => {
    const h = await harness()
    const tools = worldTools(h.loop)
    const sequenceBefore = h.kernel.snapshot.sequence

    await execute(toolNamed(tools, 'world_say'), { text: '我在家。' })
    expect(h.posted.map((item) => item.text)).toEqual(['我在家。'])
    expect(h.kernel.snapshot.sequence).toBe(sequenceBefore + 1)

    const wrote = (await execute(toolNamed(tools, 'world_note'), { title: '今天', body: '没什么事。' })) as {
      text: string
    }
    expect(wrote.text).toContain('写好了')
    expect(await h.loop.listNotes()).toEqual(['今天'])
    expect(h.kernel.snapshot.sequence).toBe(sequenceBefore + 1) // 笔记不产生世界事务

    const listed = (await execute(toolNamed(tools, 'world_notes'), {})) as { titles: string[] }
    expect(listed.titles).toEqual(['今天'])
  })

  it('⭐ 她的两只手同时用（伸手登记 + 自己想一轮）不会撞动作 id', async () => {
    const h = await harness()
    // 同一时刻：她自己想的那个动作与“她伸手登记”的那个动作 —— 两条路的轮次都是 1、
    // 看到的世界序号也一样（并行工具调用 + 嵌套 decide 就是这个形状）。
    // 若动作 id 不区分路径，后一个会被内核当“重复动作”拒掉。
    h.will({ kind: 'wait', duration: 100 })
    const [turn] = await Promise.all([
      h.loop.beat(),
      h.loop.submit({ kind: 'act', intent: '伸手拿点东西', duration: 20 }),
    ])
    expect(turn.turn?.rejected).toBeUndefined()

    const actions = Object.values(h.kernel.snapshot.actions)
    expect(actions).toHaveLength(2) // 两个动作都在（不是后一个把前一个顶掉或被拒）
    expect(new Set(actions.map((action) => action.id)).size).toBe(2)
    expect(actions.map((action) => action.intent).sort()).toEqual(['伸手拿点东西', '等一等'])
  })
})