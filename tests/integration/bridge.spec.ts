/**
 * bridge 的集成验收（T11）—— 接线与政策，用假装配体跑真链路。
 *
 * 这里测的是 live 验证**测不动**的东西：
 *   - **模式分流**：管理员私聊 → `xiaoyan-admin`（唯一带 shell 的 preset）是安全边界，
 *     名单为空时又必须 fail-closed。这两侧都要钉住。
 *   - **不串台**：同一 session 串行、不同 session 并行 —— 并发是真实群聊的常态，
 *     串台的表现是"回复张冠李戴"，最难在 live 里复现。
 *   - **冷路径分支**：resume / create / 无 persistence 三支（ADR 0011）。
 *   - **两条 session 事件形态**：npm 的 `snapshotEvents` 与 monorepo 的 `events`。
 *
 * live 验证（三轮场景 + 新群 create）覆盖的是另一面：真实 NapCat、真实 LLM、真实持久化。
 * 两者互补，缺一不可 —— 当初只做静态检查才会漏掉 `snapshotEvents` 那个 bug。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageStats } from '../../src/onebot/stats.ts'
import {
  OWNER_QQ,
  BOT,
  GROUP,
  makeBridgeEnv,
  messageFrame,
  type BridgeEnv,
} from '../support/fake-bridge-env.ts'

const OTHER = '2991064865'

const opened: BridgeEnv[] = []

async function env(options?: Parameters<typeof makeBridgeEnv>[0]): Promise<BridgeEnv> {
  const built = await makeBridgeEnv(options)
  built.onebot.accounts.set(BOT, { selfId: BOT, preset: 'xiaoyan-agent' })
  opened.push(built)
  return built
}

afterEach(async () => {
  while (opened.length) await opened.pop()?.dispose()
})

// ── 模式分流：能力边界 ────────────────────────────────────────────────

describe('bridge —— 模式分流（安全边界：只有 admin 模式带 shell）', () => {
  it('管理员私聊 → preset 走 xiaoyan-admin，session 落 admin: 命名空间', async () => {
    const e = await env()
    e.admin.admins.add(OWNER_QQ)

    e.emit(messageFrame({ messageType: 'private', userId: OWNER_QQ, text: '帮我看看磁盘' }))
    await e.settle()

    expect(e.presets.mounts).toEqual(['xiaoyan-admin'])
    expect(e.agents.created.map((c) => c.sessionId)).toEqual([`admin:${OWNER_QQ}`])
    expect(e.agents.created[0]?.agentPreset).toBe('xiaoyan-admin')
  })

  it('⚠️ 名单为空时 fail-closed：管理员 id 也走 xiaoyan-agent', async () => {
    const e = await env()
    // 刻意不加名单 —— 空名单必须一律 false，不能"认不出就当管理员"
    e.emit(messageFrame({ messageType: 'private', userId: OWNER_QQ, text: '在吗' }))
    await e.settle()

    expect(e.presets.mounts).toEqual(['xiaoyan-agent'])
    expect(e.agents.created[0]?.sessionId).toBe(`agent:${BOT}:private:${OWNER_QQ}`)
  })

  it('非管理员私聊 → xiaoyan-agent', async () => {
    const e = await env()
    e.admin.admins.add(OWNER_QQ)

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '你好' }))
    await e.settle()

    expect(e.presets.mounts).toEqual(['xiaoyan-agent'])
    expect(e.agents.created[0]?.sessionId).toBe(`agent:${BOT}:private:${OTHER}`)
  })

  it('⚠️ 群聊里即使是管理员也不走 admin（admin 只属于私聊通道）', async () => {
    const e = await env()
    e.admin.admins.add(OWNER_QQ)

    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OWNER_QQ, at: BOT, text: '大家好' }))
    await e.settle()

    expect(e.presets.mounts).toEqual(['xiaoyan-agent'])
    expect(e.agents.created[0]?.sessionId).toBe(`agent:${BOT}:group:${GROUP}`)
  })
})

// ── 触发策略 ──────────────────────────────────────────────────────────

describe('bridge —— 触发策略（行为政策）', () => {
  it('群消息不带 @ 被略过，且不创建任何 agent', async () => {
    const e = await env()
    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, text: '游戏好玩' }))
    await e.settle()

    expect(e.agents.created).toEqual([])
    expect(e.onebot.calls).toEqual([])
  })

  it('群消息带 @ 回应，且回复带 at 段回给发送者', async () => {
    const e = await env()
    e.agents.reply = '在的'
    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toHaveLength(1)
    const call = e.onebot.calls[0]
    expect(call?.action).toBe('send_group_msg')
    const params = call?.params as { group_id: number; message: unknown[] }
    expect(params.group_id).toBe(Number(GROUP))
    expect(params.message).toEqual([
      { type: 'at', data: { qq: OTHER } },
      // 带 at 时文本前面会加一个空格，免得 `@某人你好` 粘在一起
      { type: 'text', data: { text: ' 在的' } },
    ])
  })

  it('groupTrigger: never 时群里永不回应（只私聊测试时用）', async () => {
    const e = await env({ config: { groupTrigger: 'never' } })
    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '在吗' }))
    await e.settle()

    expect(e.agents.created).toEqual([])
  })

  it('私聊一律回应，且落 send_private_msg', async () => {
    const e = await env()
    e.agents.reply = '在'
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls[0]?.action).toBe('send_private_msg')
    const params = e.onebot.calls[0]?.params as { user_id: number } | undefined
    expect(params?.user_id).toBe(Number(OTHER))
  })

  it('dryRun 时不真的发（只看日志）', async () => {
    const e = await env({ config: { dryRun: true } })
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toEqual([])
  })

  it('模型这轮没产出文本时不发（不是发一条空消息）', async () => {
    const e = await env()
    e.agents.reply = undefined
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toEqual([])
  })

  it('未注册的 selfId 的事件被忽略', async () => {
    const e = await env()
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗', selfId: '10000' }))
    await e.settle()

    expect(e.agents.created).toEqual([])
  })
})

// ── 冷路径分支（ADR 0011）─────────────────────────────────────────────

describe('bridge —— 冷路径：磁盘上有日志就恢复，没有才新建', () => {
  it('磁盘上已有该 session 的日志 → resume（不 create）', async () => {
    const e = await env()
    const sessionId = `agent:${BOT}:private:${OTHER}`
    e.persistence?.ids.add(sessionId)

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.agents.resumed).toEqual([sessionId])
    expect(e.agents.created).toEqual([])
  })

  it('磁盘上没有 → create', async () => {
    const e = await env()
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.agents.created.map((c) => c.sessionId)).toEqual([`agent:${BOT}:private:${OTHER}`])
    expect(e.agents.resumed).toEqual([])
  })

  it('⚠️ resume 时也要 mount preset（resume 组合的是 fresh scoped world）', async () => {
    const e = await env()
    e.persistence?.ids.add(`agent:${BOT}:private:${OTHER}`)

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.presets.mounts).toEqual(['xiaoyan-agent'])
  })

  it('没有 persistence 服务 → create（没有持久化就不可能有磁盘日志）', async () => {
    const e = await env({ withPersistence: false })
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.agents.created).toHaveLength(1)
    expect(e.agents.resumed).toEqual([])
  })

  it('同一 session 的第二条消息复用内存里的 agent（不重复 create/resume）', async () => {
    const e = await env()
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '第一句' }))
    await e.settle()
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '第二句' }))
    await e.settle()

    expect(e.agents.created).toHaveLength(1)
    expect(e.onebot.calls).toHaveLength(2)
    expect(e.agents.get(`agent:${BOT}:private:${OTHER}`)?.asked).toHaveLength(2)
  })
})

// ── 不串台 ────────────────────────────────────────────────────────────

describe('bridge —— 不串台（并发是真实群聊的常态）', () => {
  it('同一 session 的两条消息**串行**：第二条在第一条发完之后才开始', async () => {
    const e = await env()
    e.agents.idleWaitMs = 10

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '第一句' }))
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '第二句' }))
    await e.settle()

    const sessionId = `agent:${BOT}:private:${OTHER}`
    const firstCall = e.order.indexOf('call:send_private_msg')
    const secondFollowup = e.order.lastIndexOf(`followup:${sessionId}`)

    expect(e.order.filter((step) => step === `followup:${sessionId}`)).toHaveLength(2)
    // 若并行，两次 followup 会挤在一起（都在第一次 call 之前）→ 这条断言就会失败
    expect(firstCall).toBeGreaterThanOrEqual(0)
    expect(secondFollowup).toBeGreaterThan(firstCall)
  })

  it('不同 session **并行**：慢会话还没发完，快会话已经开始了', async () => {
    const e = await env()
    e.agents.idleWaitMs = 15

    // 群会话先进入（慢），私聊紧接着进入 —— 若并行，私聊的 followup 会落在群的 call 之前
    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '群里问' }))
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '私下问' }))
    await e.settle()

    const groupFollowup = e.order.indexOf(`followup:agent:${BOT}:group:${GROUP}`)
    const privateFollowup = e.order.indexOf(`followup:agent:${BOT}:private:${OTHER}`)
    const groupCall = e.order.indexOf('call:send_group_msg')

    expect(groupFollowup).toBeGreaterThanOrEqual(0)
    expect(privateFollowup).toBeGreaterThanOrEqual(0)
    // 私聊的回合在群的回合还没发出去时就已经开始了 → 两条链真的在并行
    expect(privateFollowup).toBeLessThan(groupCall)
  })

  it('串行的两条消息各自读到自己的那一轮（不会互相覆盖回复）', async () => {
    const e = await env()
    e.agents.reply = '第一次回'
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: 'A' }))
    await e.settle()

    e.agents.reply = '第二次回'
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: 'B' }))
    await e.settle()

    const texts = e.onebot.calls.map(
      (call) => (call.params as { message: { data: { text: string } }[] }).message.at(-1)?.data.text,
    )
    expect(texts).toEqual(['第一次回', '第二次回'])
  })
})

// ── 两条 session 事件形态（ADR 0011）─────────────────────────────────

describe('bridge —— session 事件的两种运行时形态都要能读', () => {
  it('monorepo 形态（`get events()`）能读到回复', async () => {
    const e = await env()
    e.agents.sessionApi = 'events'
    e.agents.reply = '走 events 也读得到'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toHaveLength(1)
  })

  it('npm 形态（`snapshotEvents`）能读到回复', async () => {
    const e = await env()
    e.agents.sessionApi = 'snapshotEvents'
    e.agents.reply = '走 snapshotEvents 也读得到'

    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.onebot.calls).toHaveLength(1)
  })

  it('flush 在回发之前被调用（output commit 纪律）', async () => {
    const e = await env()
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    expect(e.sessions.flushed).toHaveLength(1)
  })
})

// ── 溯源（T12）────────────────────────────────────────────────────────

describe('bridge —— 溯源随消息走（不是自定义 session 事件）', () => {
  it('群消息：source 带群号与 mode=agent', async () => {
    const e = await env()
    e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, at: BOT, text: '在吗' }))
    await e.settle()

    const agent = e.agents.get(`agent:${BOT}:group:${GROUP}`)
    expect(agent?.sources).toEqual([
      { kind: 'qq', userId: OTHER, groupId: GROUP, mode: 'agent', account: BOT },
    ])
  })

  it('管理员私聊：source 是 mode=admin 且**没有 groupId 键**', async () => {
    const e = await env()
    e.admin.admins.add(OWNER_QQ)

    e.emit(messageFrame({ messageType: 'private', userId: OWNER_QQ, text: '在吗' }))
    await e.settle()

    const agent = e.agents.get(`admin:${OWNER_QQ}`)
    const source = agent?.sources[0] as Record<string, unknown>
    expect(source).toMatchObject({ kind: 'qq', userId: OWNER_QQ, mode: 'admin', account: BOT })
    expect('groupId' in source).toBe(false)
  })

  it('非管理员私聊：source 是 mode=agent', async () => {
    const e = await env()
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    const agent = e.agents.get(`agent:${BOT}:private:${OTHER}`)
    const source = agent?.sources[0] as { mode?: string } | undefined
    expect(source?.mode).toBe('agent')
  })

  it('⚠️ source 里没有任何自定义事件类型 —— 不会碰持久化的已知类型白名单', async () => {
    const e = await env()
    e.emit(messageFrame({ messageType: 'private', userId: OTHER, text: '在吗' }))
    await e.settle()

    // 假 session 的日志里只应有 DSH 已知的事件类型；`yanxin/provenance` 这类
    // 自定义类型一旦出现，持久化读取路径会硬拒（ADR 0012）
    const agent = e.agents.get(`agent:${BOT}:private:${OTHER}`)
    expect(agent?.session.observedTypes()).toEqual(['turn/start', 'assistant/message', 'turn/end'])
  })
})

// ── 消息统计（SQLite）：仪表盘的记账点 ─────────────────────────────────

describe('bridge —— 消息统计（控制台仪表盘的数据源）', () => {
  it('⭐ 收到记 in（触发与否如实）、回复成功记 out；@ 触发一条全链', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yanxin-bridge-stats-'))
    const dbPath = join(dir, 'stats.db')
    const closer = MessageStats.open(dbPath)
    try {
      const e = await env({ config: { stats: true, statsPath: dbPath } })
      // 一条没触发的（群里没人 @ 她也没叫名字）+ 一条 @ 触发并成功回复的
      e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OTHER, text: '游戏好玩' }))
      await e.settle()
      e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: OWNER_QQ, at: BOT, text: '大家好' }))
      await e.settle()

      const overview = closer.overview()
      expect(overview.todayIn).toBe(2)
      expect(overview.todayTriggered).toBe(1)
      expect(overview.todayOut).toBe(1)
      expect(overview.groups[0]).toEqual({ groupId: GROUP, count: 2 })
    } finally {
      closer.close()
      // ⚠️ 先拆桥（dispose 关掉它的库连接）再删目录 —— Windows 上句柄没放就 rm 是 EBUSY
      while (opened.length) await opened.pop()?.dispose()
      await new Promise((resolve) => setTimeout(resolve, 50))
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('自己的消息不记账（那是回声，不是流量）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yanxin-bridge-stats-'))
    const dbPath = join(dir, 'stats.db')
    const closer = MessageStats.open(dbPath)
    try {
      const e = await env({ config: { stats: true, statsPath: dbPath } })
      e.emit(messageFrame({ messageType: 'group', groupId: GROUP, userId: BOT, text: '（她自己的话的回声）' }))
      await e.settle()

      expect(closer.overview().totalIn).toBe(0)
    } finally {
      closer.close()
      while (opened.length) await opened.pop()?.dispose()
      await new Promise((resolve) => setTimeout(resolve, 50))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
