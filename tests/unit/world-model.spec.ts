/**
 * 世界模型适配器的验收（T27b，spec §6.7）。
 *
 * 这一层很薄但**不能出错**：它是"模型的话"进入世界的唯一入口。所以验收盯三条语义承诺：
 *
 *   · **模型没调工具** → 不抛，返回文本（上层用反馈重试）—— 这是 T25 的纪律，
 *     在这里变成"降级而不是异常"
 *   · **参数不是合法 JSON** → 同上（脏数据不该穿透到运行时）
 *   · **流本身报错**（网络 / 鉴权 / 额度）→ **抛出去**（重试的地方在运行时与心跳；
 *     在这里吞掉会让"这次裁不了"看起来像"世界什么都没发生"）
 *
 * 另有两条装配事实：请求里带的 provider/model 来自路由；工具 schema 原样传下去。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PROPOSE_WORLD } from '../../src/world/arbiter.ts'
import WorldModelService, { worldModelCaller, type ModelRoute } from '../../src/world/model.ts'

/** 一段"模型回了什么"的剧本 → 假的流。 */
function fakeStream(script: StreamChunk[] | (() => never)): {
  stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  seen: GenerateOptions[]
} {
  const seen: GenerateOptions[] = []
  return {
    stream: (options) => {
      seen.push(options)
      return (async function* () {
        if (typeof script === 'function') script()
        else for (const chunk of script) yield chunk
      })()
    },
    seen,
  }
}

/** 一次"只说了话、没调工具"的回复（`index` 可挪，好与工具块并存）。 */
function textOnly(text: string, index = 0): StreamChunk[] {
  return [
    { type: 'block-start', index, blockType: 'text' },
    { type: 'text-delta', index, text },
    { type: 'block-end', index, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 一次工具调用（参数以 delta 形式流式到达 —— 真实适配器的形态）。 */
function toolCall(name: string, json: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-1' as never, name, argumentsDelta: json.slice(0, 4) },
    { type: 'tool-call-delta', index: 0, id: 'call-1' as never, argumentsDelta: json.slice(4) },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-1' as never, name, arguments: json },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const ROUTE: ModelRoute = { provider: 'agnes', model: 'agnes-3.0-flash' }

function caller(script: StreamChunk[] | (() => never), over: { warn?: (m: string) => void } = {}) {
  const fake = fakeStream(script)
  const warnings: string[] = []
  const call = worldModelCaller({
    stream: fake.stream,
    route: () => ROUTE,
    warn: over.warn ?? ((message) => warnings.push(message)),
  })
  return { call, fake, warnings }
}

describe('T27b —— 工具调用被如实取回', () => {
  it('⭐ 参数（流式 delta 拼起来的 JSON）被解析成值，文本也一起带回', async () => {
    const operation = [{ op: 'action.finish', id: 'act:1.1', status: 'completed', reason: '看完了' }]
    const { call, fake } = caller([
      ...toolCall('propose_world', JSON.stringify({ operations: operation })),
      // ⚠️ 第二个块要用**新的 index**：同一个 index 在 block-end 之后再来 delta
      //    被装配器当作畸形流忽略（它的容错策略，不是缺陷）
      ...textOnly('（顺带一句）', 1),
    ])

    const reply = await call({ prompt: '结算这个动作', tool: PROPOSE_WORLD })

    expect(reply.arguments).toEqual({ operations: operation })
    expect(reply.text).toBe('（顺带一句）')

    // 请求形状：路由 + 一个用户消息 + 那个工具
    const request = fake.seen[0]
    expect(request?.provider).toBe('agnes')
    expect(request?.model).toBe('agnes-3.0-flash')
    expect(request?.tools?.map((tool) => tool.name)).toEqual(['propose_world'])
    expect(request?.tools?.[0]?.parameters).toMatchObject({ type: 'object' })
    expect(request?.messages).toHaveLength(1)
    expect(request?.messages[0]?.role).toBe('user')
    // 提示词原样进去（一字不改 —— 裁定者看到的"世界现状"就是这段）
    expect(JSON.stringify(request?.messages[0]?.content)).toContain('结算这个动作')
  })

  it('默认不给 system（提示词自带身份说明，重复注入只会打架）', async () => {
    const { call, fake } = caller(toolCall('propose_world', '{"operations":[]}'))
    await call({ prompt: 'x', tool: PROPOSE_WORLD })
    expect(fake.seen[0]?.system).toBeUndefined()
  })
})

describe('T27b —— 模型不给结构化输出时：降级，不抛', () => {
  it('⭐ 只回了文本 → arguments 缺省、text 带回，并告警（上层会反馈重试）', async () => {
    const { call, warnings } = caller(textOnly('我觉得它应该完成了吧'))
    const reply = await call({ prompt: '结算', tool: PROPOSE_WORLD })

    expect(reply.arguments).toBeUndefined()
    expect(reply.text).toBe('我觉得它应该完成了吧')
    expect(warnings.join()).toContain('没有调用 propose_world')
    // 告警里要带上她实际回了什么 —— 不然这条告警回答不了"为什么没调工具"
    expect(warnings.join()).toContain('我觉得它应该完成了吧')
    expect(warnings.join()).toContain('10 字符')
  })

  // 2026-10-01 现场：43/43 全被报成"只回了文本"，实际是模型调了工具、但回复在
  // max-tokens 处被截断，`BlockAssembler.blocks()` 按规矩丢掉截断的 tool-call。
  // 装配器没错（截断的参数不是合法 JSON），错的是我们把"被丢了"报成"没给"。
  it('⭐ 工具调用被 max-tokens 截断丢掉 → 说清楚是"丢了"，不是"没调用"', async () => {
    const { call, warnings } = caller([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'call-1' as never,
        name: 'propose_world',
        argumentsDelta: '{"operations": [{"op": "action.fin',
      },
      { type: 'usage', usage: { inputTokens: 1200, outputTokens: 4096, reasoningTokens: 4090 } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])

    const reply = await call({ prompt: '结算', tool: PROPOSE_WORLD })

    expect(reply.arguments).toBeUndefined()
    expect(warnings.join()).toContain('被丢弃')
    expect(warnings.join()).toContain('max-tokens 截断')
    // 思考占了多少是这条链上最值钱的数字，必须出现在告警里
    expect(warnings.join()).toContain('思考 4090')
    expect(warnings.join()).not.toContain('模型没有调用')
  })

  it('⭐ finish=error（流带着失败结束）→ 报"这次调用失败了"并带上 code/http，不报成"模型没调用"', async () => {
    const { call, warnings } = caller([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'Connection reset by peer', code: 'transport-error', status: 502 } as never,
        },
      },
    ])

    const reply = await call({ prompt: '结算', tool: PROPOSE_WORLD })

    expect(reply.arguments).toBeUndefined()
    expect(warnings.join()).toContain('这次调用失败了')
    expect(warnings.join()).toContain('code=transport-error')
    expect(warnings.join()).toContain('http=502')
    expect(warnings.join()).toContain('Connection reset by peer')
    expect(warnings.join()).not.toContain('模型没有调用')
  })

  it('⭐ 参数不是合法 JSON → 当作"没给提案"，同样不抛', async () => {
    const { call, warnings } = caller(toolCall('propose_world', '{operations: 这不是 JSON'))
    const reply = await call({ prompt: '结算', tool: PROPOSE_WORLD })

    expect(reply.arguments).toBeUndefined()
    expect(warnings.join()).toContain('不是合法 JSON')
  })

  it('什么都没回（空流）→ 空回复，不崩', async () => {
    const { call } = caller([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(await call({ prompt: '结算', tool: PROPOSE_WORLD })).toEqual({})
  })
})

describe('T27b —— 流本身出错：抛出去（重试在别处）', () => {
  it('⭐ 网络/鉴权错误原样穿透（吞掉会让"这次裁不了"看起来像"世界什么都没发生"）', async () => {
    const boom = (): never => {
      throw new Error('401 unauthorized')
    }
    const { call } = caller(boom, { warn: () => undefined })

    await expect(call({ prompt: '结算', tool: PROPOSE_WORLD })).rejects.toThrow('401 unauthorized')
  })
})

describe('T27b —— 装配：服务形态与路由解析', () => {
  /** 起一个带假 `llm` 与假 `agentDefaultModel` 的上下文。 */
  function env(setup: {
    defaultRoute?: ModelRoute | undefined
    config?: { provider?: string; model?: string }
  }): { ctx: Context; requests: GenerateOptions[] } {
    const ctx = new Context()
    const requests: GenerateOptions[] = []
    ;(ctx as unknown as { provide: (name: string, value: unknown) => unknown }).provide('llm', {
      stream: (request: GenerateOptions) => {
        requests.push(request)
        return (async function* () {
          for (const chunk of toolCall('propose_world', '{"operations":[]}')) yield chunk
        })()
      },
    })
    if (setup.defaultRoute !== undefined) {
      ;(ctx as unknown as { provide: (name: string, value: unknown) => unknown }).provide('agentDefaultModel', {
        currentSelection: () => setup.defaultRoute,
      })
    }
    return { ctx, requests }
  }

  it('⭐ 缺省路由走 agent-default-model（与桥同一处口径）', async () => {
    const { ctx, requests } = env({ defaultRoute: ROUTE })
    const service = new WorldModelService(ctx, {})

    await service.call({ prompt: 'x', tool: PROPOSE_WORLD })
    expect(requests[0]?.model).toBe('agnes-3.0-flash')
  })

  it('行 config 显式给了 provider/model 时优先（部署要指定"世界用哪个模型"）', async () => {
    const { ctx, requests } = env({ defaultRoute: ROUTE })
    const service = new WorldModelService(ctx, { provider: 'suotianyi', model: 'deepseek-flash' })

    await service.call({ prompt: 'x', tool: PROPOSE_WORLD })
    expect(requests[0]?.provider).toBe('suotianyi')
    expect(requests[0]?.model).toBe('deepseek-flash')
  })

  it('两处都没有路由 → 错误信息可操作（说清去哪配）', async () => {
    const { ctx } = env({})
    const service = new WorldModelService(ctx, {})

    await expect(service.call({ prompt: 'x', tool: PROPOSE_WORLD })).rejects.toThrow(/agent-default-model/)
  })

  it('温度压低调（裁定与提取是照章办事，创意不是这一侧的事）', async () => {
    const { ctx, requests } = env({ defaultRoute: ROUTE })
    const service = new WorldModelService(ctx, {})

    await service.call({ prompt: 'x', tool: PROPOSE_WORLD })
    expect(requests[0]?.temperature).toBeLessThanOrEqual(0.5)
  })
})