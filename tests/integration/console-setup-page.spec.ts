/**
 * 初始化向导页的验收（T34，spec §6.11）。
 *
 * 这一页是**唯一的人工入口**（CLI 只有 `ctx.setup.run(...)`），所以验收重点不是"好不好看"，
 * 而是三件会真的挡住运营者的事：
 *
 *   · **不再自己判状态**：一律问 `ctx.setup.progress()`（两份判定必然漂移）
 *   · **下一步的按钮只在该跑的时候出现**，且带上那一步需要的输入
 *     （accounts 要 QQ 号；world 要"重建"的显式勾选）
 *   · **失败时说人话**：`SetupError.summary` 原样回给页面（它是"一句话 + 可操作细节"）
 */
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ConsoleService from '../../src/console/index.ts'
import { renderSetupBlocks } from '../../src/console/pages/setup.ts'
import { TOKEN_ENV } from '../../src/console/logic.ts'
import { emptyRecord, reconcile, type SetupEvidence } from '../../src/setup/logic.ts'
import { SetupError, type SetupProgress } from '../../src/setup/types.ts'

const opened: Context[] = []
let savedToken: string | undefined

beforeEach(() => {
  savedToken = process.env[TOKEN_ENV]
  process.env[TOKEN_ENV] = 's3cret'
})

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
  if (savedToken === undefined) delete process.env[TOKEN_ENV]
  else process.env[TOKEN_ENV] = savedToken
})

/** 一份"全新"的进度（四步都没做）。 */
function freshProgress(): SetupProgress {
  const evidence: SetupEvidence = {
    persona: { base: false, profile: false, world: false },
    presets: { installed: 0, total: 3 },
    world: { transactions: 0, clock: false },
    accounts: { registered: [], connected: [] },
  }
  const result = reconcile(emptyRecord(0), evidence)
  const completed = new Set<string>()
  return {
    status: result.status,
    next: result.next,
    steps: result.steps.map((state) => ({
      step: state.step,
      completed: completed.has(state.step),
      satisfied: state.satisfied,
      runnable: state.step === 'persona',
      missing: state.missing,
    })),
    reverted: result.reverted,
    warnings: ['她还没上线：协议端（NapCat/SnowLuma）还没有反连过来'],
  }
}

/** 一份"就差账号"的进度（前三步成立，accounts 可跑）。 */
function awaitingAccount(): SetupProgress {
  return {
    status: 'world',
    next: 'accounts',
    steps: [
      { step: 'persona', completed: true, satisfied: true, runnable: true, missing: [] },
      { step: 'background', completed: true, satisfied: true, runnable: true, missing: [] },
      { step: 'world', completed: true, satisfied: true, runnable: true, missing: [] },
      {
        step: 'accounts',
        completed: false,
        satisfied: false,
        runnable: true,
        missing: ['还没指定她的 QQ 号（accounts 步要选定一个 selfId）'],
      },
    ],
    reverted: [],
    warnings: [],
  }
}

/** 一份"世界已存在、要重建"的进度。 */
function readyProgress(): SetupProgress {
  return {
    status: 'ready',
    next: null,
    steps: [
      { step: 'persona', completed: true, satisfied: true, runnable: true, missing: [] },
      { step: 'background', completed: true, satisfied: true, runnable: true, missing: [] },
      { step: 'world', completed: true, satisfied: true, runnable: true, missing: [] },
      { step: 'accounts', completed: true, satisfied: true, runnable: true, missing: [] },
    ],
    reverted: [],
    warnings: [],
  }
}

describe('T34 —— 页的区块（纯函数，表驱动）', () => {
  it('⭐ 全新：状态一句话 + 四步表 + 告警 + 第一步的表单', () => {
    const blocks = renderSetupBlocks(freshProgress(), '/yanxin')
    const text = JSON.stringify(blocks)

    expect(text).toContain('还没开始')
    expect(text).toContain('缺什么') // 表头
    expect(text).toContain('协议端') // 告警照原样显示
    // 第一步的表单：只带 step 一个字段（人格步不需要别的输入）
    const form = blocks.find((block) => block.kind === 'form')
    expect(form).toMatchObject({ action: '/yanxin/api/setup/run' })
    expect(JSON.stringify(form)).toContain('"value":"persona"')
  })

  it('⭐ 就差账号：表单带上 QQ 号输入，且提示里带着"缺什么"', () => {
    const blocks = renderSetupBlocks(awaitingAccount(), '/yanxin')
    const form = blocks.find((block) => block.kind === 'form')

    expect(JSON.stringify(form)).toContain('accountId')
    expect(JSON.stringify(blocks)).toContain('还没指定她的 QQ 号')
  })

  it('⭐ 已就绪：不给任何表单（没有下一步），也不说"没有可跑的步骤"得难听', () => {
    const blocks = renderSetupBlocks(readyProgress(), '/yanxin')

    expect(blocks.some((block) => block.kind === 'form')).toBe(false)
    expect(JSON.stringify(blocks)).toContain('已就绪')
  })

  it('世界里"重建"必须是显式勾选（防手滑推倒她的世界）', () => {
    const progress: SetupProgress = {
      ...readyProgress(),
      status: 'background',
      steps: readyProgress().steps.map((step) =>
        step.step === 'world' ? { ...step, completed: false, satisfied: false, runnable: true } : step,
      ),
    }
    const blocks = renderSetupBlocks(progress, '/yanxin')
    const form = JSON.stringify(blocks.find((block) => block.kind === 'form'))

    expect(form).toContain('rebuild')
    expect(form).toContain('checkbox')
  })
})

describe('T34 —— 页与接口真的挂得上', () => {
  /** 起真 webServer + 真控制台 + 向导页（`setup` 用假服务）。 */
  async function makePage(run: (step: string, input: unknown) => Promise<unknown>) {
    const ctx = new Context()
    opened.push(ctx)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const provide = (ctx as unknown as { provide: (name: string, value: unknown) => unknown }).provide.bind(ctx)
    provide('setup', { progress: async () => freshProgress(), run })

    await ctx.plugin(ConsoleService, {})
    await ctx.plugin(await import('../../src/console/pages/setup.ts'))
    return { ctx, base: `http://127.0.0.1:${ctx.webServer.port}/yanxin` }
  }

  it('⭐ `/api/page/setup` 给出那一页（标题 + 区块），并进导航', async () => {
    const { base } = await makePage(async () => ({ progress: freshProgress() }))
    const payload = (await (await fetch(`${base}/api/page/setup`)).json()) as {
      ok: boolean
      data: { title: string; pages: { slug: string }[]; blocks: unknown[] }
    }

    expect(payload.ok).toBe(true)
    expect(payload.data.title).toBe('初始化')
    expect(payload.data.pages.map((page) => page.slug)).toEqual(['setup'])
    expect(payload.data.blocks.length).toBeGreaterThan(2)
  })

  it('⭐ 跑一步：POST 带 token → 调 `ctx.setup.run` 并把结果说回页面', async () => {
    const calls: { step: string; input: unknown }[] = []
    const { base } = await makePage(async (step, input) => {
      calls.push({ step, input })
      return { status: 'persona', detail: '人格源已就位：base.md；已安装 3 个 preset' }
    })

    const response = await fetch(`${base}/api/setup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
      body: JSON.stringify({ step: 'persona' }),
    })
    const payload = (await response.json()) as { ok: boolean; data: { detail: string } }

    expect(response.status).toBe(200)
    expect(calls).toEqual([{ step: 'persona', input: {} }])
    expect(payload.data.detail).toContain('人格源已就位')
  })

  it('⭐ 失败时说人话：`SetupError.summary` 原样回来（不是"500 内部错误"）', async () => {
    const { base } = await makePage(async () => {
      throw new SetupError('STEP_BLOCKED', '还不能做「world」——先把它前面的步骤补上', ['世界定义还没导入'])
    })

    const response = await fetch(`${base}/api/setup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
      body: JSON.stringify({ step: 'world' }),
    })
    const payload = (await response.json()) as { ok: boolean; data: { error: string } }

    expect(response.status).toBe(200) // 业务失败不是传输失败
    expect(payload.ok).toBe(true)
    expect(payload.data.error).toContain('先把它前面的步骤补上')
    expect(payload.data.error).toContain('世界定义还没导入')
  })

  it('accounts 的 QQ 号与 world 的重建勾选都传到服务（且只传该传的）', async () => {
    const calls: { step: string; input: unknown }[] = []
    const { base } = await makePage(async (step, input) => {
      calls.push({ step, input })
      return { status: 'ready', detail: '好了' }
    })

    await fetch(`${base}/api/setup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
      body: JSON.stringify({ step: 'accounts', accountId: ' 3000000001 ' }),
    })
    await fetch(`${base}/api/setup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
      body: JSON.stringify({ step: 'world', rebuild: 'true' }),
    })

    expect(calls[0]).toEqual({ step: 'accounts', input: { accountId: '3000000001' } })
    expect(calls[1]).toEqual({ step: 'world', input: { rebuild: true } })
  })

  it('没给 step → 明确报错（不猜"你想跑哪一步"）', async () => {
    const { base } = await makePage(async () => ({ status: 'init', detail: 'x' }))
    const response = await fetch(`${base}/api/setup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yanxin-token': 's3cret' },
      body: JSON.stringify({}),
    })
    const payload = (await response.json()) as { data: { error: string } }
    expect(payload.data.error).toContain('没给 step')
  })

  it('向导服务不在时：页面降级成一句可操作的话（不是崩）', async () => {
    const ctx = new Context()
    opened.push(ctx)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(ConsoleService, {})
    await ctx.plugin(await import('../../src/console/pages/setup.ts'))
    const base = `http://127.0.0.1:${ctx.webServer.port}/yanxin`

    const payload = (await (await fetch(`${base}/api/page/setup`)).json()) as { data: { blocks: { text: string }[] } }
    expect(JSON.stringify(payload.data.blocks)).toContain('初始化服务不在')
  })
})