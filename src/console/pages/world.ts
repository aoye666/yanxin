/**
 * 世界页（T33）—— 她现在在哪儿、世界过了多久、本子上写了什么 + 两个**运营开关**。
 *
 * ## "只读世界内容"仍是纪律，"运营开关"是另一回事
 *
 * spec §6.7 的纪律：**改世界只能走"提案 → 校验 → 提交"那条路**（内核是唯一入口）。
 * 这一页依旧**没有**任何改世界内容的按钮 —— 那不是省事，是边界：控制台不该是绕过内核的后门。
 * 页上的两个写入口都不是"改世界"：引擎开关（`yanxin-window.paused`）与响应群号
 * （`yanxin-world.worldGroupId`）是**运营配置**，等同于改时段（时段页先例），
 * 都走 settings 的持久化写路径，且各自动进控制台审计。
 *
 * ## 引擎开关为什么必须在引擎卸下时仍然可见
 *
 * 手动暂停后引擎行被卸下（`ctx.get('world')` 变 undefined）—— 如果那时开关也跟着
 * 消失，想恢复的人就找不到开关（死锁）。所以开关的状态从**窗口服务**读（它常驻），
 * 引擎在不在都渲染。
 *
 * ## 纪元那条为什么值得单独显示
 *
 * T=0 锚在一个**现实时刻**上（`clock.json` 的 `genesisMs`），世界时间与真实时间 1:1。
 * 显示它有两个实际用处：知道"她的一天从什么时候开始算"，以及在时间对不上时能一眼看出
 * 锚点被换过（重建世界会换锚点 —— T29 的重建就是这么做的）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Block } from '../logic.ts'
import { formatElapsed } from '../../world/life.ts'
import type { WorldStatus } from '../../world/engine.ts'
import { brief, clockText, missingService } from './support.ts'

/** 装配纪律（ADR 0004）：命名导出 + `inject`，**不写 default**。 */
export const name = 'yanxin-console-world-page'
export const inject = ['console']

/** 一次观测投影在本页用到的最小面（`src/world/observe.ts` 的 `Observation`）。 */
export interface ObservationLike {
  entities: readonly { handle: string; name: string; kind: string; self: boolean; distant?: boolean }[]
  placeHandle?: string
}

/** 世界服务在本页用到的最小面。 */
interface WorldLike {
  status(): WorldStatus
  listNotes(): Promise<string[]>
  look(options?: { focus?: 'around' | 'phone' }): ObservationLike
}

/** 页面要显示的一切（服务与投影都摘好了，纯函数只管排版）。 */
export interface WorldView {
  status: WorldStatus
  /** 她所在的地方（名字）。 */
  place: string | null
  /** 身边看得见的东西（名字 + 种类；她自己标注出来）。 */
  visible: readonly string[]
  /** 笔记本上的标题（最近的在前）。 */
  notes: readonly string[]
  /** 世界引擎是否被**手动暂停**（控制台开关；窗口开着也不装载）。 */
  paused: boolean
}

/** 把一次观测投影摘成"她在哪儿 / 看得见什么"。 */
export function viewFrom(
  status: WorldStatus,
  observation: ObservationLike,
  notes: readonly string[],
  paused: boolean,
): WorldView {
  const entities = observation.entities ?? []
  const place = entities.find((entity) => entity.handle === observation.placeHandle)
  return {
    status,
    place: place?.name ?? null,
    visible: entities
      .filter((entity) => entity.distant !== true)
      .map((entity) => `${entity.name}（${entity.kind}）${entity.self ? ' ← 她自己' : ''}`),
    notes,
    paused,
  }
}

/** 页面的区块（纯函数）。 */
export function renderWorldBlocks(view: WorldView, base: string): readonly Block[] {
  const { status } = view
  const blocks: Block[] = []

  if (!status.ready) {
    blocks.push({
      kind: 'notice',
      tone: 'info',
      text: view.paused
        ? '世界引擎已被**手动暂停**（下面的开关）：窗口开着也不会装载 —— 她不主动过日子，但被动回话照常。'
        : '世界现在**没打开**：要么不在开放时段（见「时段」页），要么世界还没创世（见「初始化」页）。世界时间与事务数因此是空的。',
    })
  } else {
    blocks.push({ kind: 'p', text: `世界在转：世界时间 ${status.tu ?? 0} TU（约 ${formatElapsed(status.tu ?? 0)}）。` })
  }

  blocks.push({
    kind: 'form',
    action: `${base}/api/world/switch`,
    submit: '保存开关',
    fields: [
      {
        name: 'paused',
        type: 'checkbox',
        label: `暂停世界引擎（当前：${view.paused ? '已暂停' : '运行中'}）`,
        // checkbox 的 value 同时是"渲染时是否勾上"的开关（客户端脚本按它 set checked）
        value: view.paused ? 'true' : 'false',
        hint: '勾上并提交 = 手动按停：窗口开着她也不装载（省额度）。取消勾选 = 交还给时段表自动管。',
      },
    ],
  })

  blocks.push({
    kind: 'form',
    action: `${base}/api/world/group`,
    submit: '保存群号',
    fields: [
      {
        name: 'worldGroupId',
        label: '她的世界群号（她主动说的话发到这里）',
        value: status.groupId,
        hint: '改完**下一句话就生效**，不用重启。留空提交会被拒 —— 要她闭嘴用上面的开关。',
      },
    ],
  })

  blocks.push({
    kind: 'table',
    caption: '世界',
    head: ['项', '值'],
    rows: [
      ['响应群号', status.groupId === '' ? '—（没配：她对外说不出话）' : status.groupId],
      ['世界时间（TU）', status.tu === null ? '—' : `${status.tu}`],
      ['纪元（T=0 的现实时刻）', clockText(status.era)],
      ['已提交事务', status.sequence === null ? '—' : `${status.sequence}`],
      ['实体 / 动作', status.entities === null ? '—' : `${status.entities} / ${status.actions ?? 0}`],
      ['报活心跳', `${status.ticks}`],
      ['本进程收到的事件', `${status.inbound}`],
    ],
  })

  if (status.ready) {
    blocks.push({
      kind: 'table',
      caption: '她此刻',
      head: ['项', '值'],
      rows: [
        ['所在', view.place ?? '（投影里没有地点）'],
        ['看得见', view.visible.length === 0 ? '（什么都没有）' : view.visible.join('；')],
      ],
    })
  }

  blocks.push({
    kind: 'table',
    caption: `她的笔记（${view.notes.length} 篇）`,
    head: ['标题'],
    rows: view.notes.length === 0 ? [['（本子上还是空的）']] : view.notes.map((title) => [title]),
  })
  blocks.push({
    kind: 'p',
    text: '笔记正文是 `$DSH_HOME/yanxin/world/notes/<标题>.md`（人机共用，用编辑器看即可）。改**世界内容**只能走"提案 → 校验 → 提交"（内核那条路）；本页的两个表单改的是**运营配置**（引擎开关 / 群号），走 settings，与内核边界无关。',
  })
  blocks.push({ kind: 'link', href: `${base}/talk`, text: '去看她说过的话（对话页）' })
  return blocks
}

/**
 * 世界服务不在时说什么。
 *
 * 两种情形**完全不是一回事**，页面必须分开说 ——
 *   · 在**关闭时段**：引擎那一行被窗口服务卸下了（设计如此），窗口一开自动装回来
 *   · 其它：patch 里那一行真的没装载（配置问题）
 * 清晨打开这一页的人看到的正是第一种，含糊地说"服务不在"会把人引向错误的方向。
 */
export function worldMissingBlocks(windowOpen: boolean | undefined): readonly Block[] {
  if (windowOpen === false) {
    return [
      {
        kind: 'notice',
        tone: 'info',
        text: '世界引擎现在是**卸下的**：现在不在开放时段（见「时段」页）。窗口一开它会自动装回来 —— 这不是故障。',
      },
    ]
  }
  return missingService('世界')
}

/** 装页与接口（只读呈现 + 两个运营开关：引擎启停 / 响应群号）。 */
export function apply(ctx: Context): void {
  ctx.console.page({
    slug: 'world',
    title: '世界',
    async render({ base }) {
      const window = ctx.get('window') as { paused?: boolean; isOpen?: boolean } | undefined
      const world = ctx.get('world') as WorldLike | undefined
      const paused = window?.paused === true

      if (world === undefined) {
        // 引擎行没装载（窗口外 / 手动暂停 / 没配）。开关必须**照常显示** ——
        // 否则"手动暂停之后想恢复"的人找不到开关（那是死锁）。
        // 群号从 `yanxin-world` scope 读（console 服务惰性注册，行 config 挂成了
        // 静态层）—— 引擎卸下时它是唯一还能读到"配的哪个群"的地方。
        const consoleService = ctx.get('console') as
          | { ensureWorldScope(): { get(): { worldGroupId?: string } } | undefined }
          | undefined
        const groupId = consoleService?.ensureWorldScope()?.get().worldGroupId ?? ''
        return [
          ...worldMissingBlocks(window?.isOpen),
          ...renderWorldBlocks(
            {
              status: {
                ready: false,
                tu: null,
                era: null,
                sequence: null,
                entities: null,
                actions: null,
                ticks: 0,
                inbound: 0,
                groupId,
              },
              place: null,
              visible: [],
              notes: [],
              paused,
            },
            base,
          ),
        ]
      }

      const status = world.status()
      if (!status.ready) return renderWorldBlocks({ status, place: null, visible: [], notes: [], paused }, base)

      // 世界打开好了才敢 look()（没打开时它会抛 —— 那是"不返回空快照掩盖"的设计）
      let notes: string[] = []
      try {
        notes = await world.listNotes()
      } catch {
        notes = []
      }
      try {
        return renderWorldBlocks(viewFrom(status, world.look(), notes, paused), base)
      } catch (error) {
        const blocks = renderWorldBlocks({ status, place: null, visible: [], notes, paused }, base)
        return [
          ...blocks,
          {
            kind: 'notice',
            tone: 'warn',
            text: `投影没取到：${error instanceof Error ? error.message : String(error)}`,
          },
        ]
      }
    },
  })

  // ── 引擎开关：写窗口服务的 settings（`yanxin-window.paused`），watch 会立刻
  //    触发重裁决 —— 页面上按下去，引擎行同一拍装卸，不用重启。
  ctx.console.api({
    route: 'world/switch',
    method: 'POST',
    async handler({ body }) {
      const settings = ctx.get('settings') as { update(ns: string, patch: object): Promise<void> } | undefined
      if (settings === undefined) return { error: 'settings 服务不在 —— 改不了开关（它得持久化）' }
      const window = ctx.get('window') as { paused?: boolean } | undefined
      if (window === undefined) return { error: '窗口服务不在 —— 装配里 window 行没装载，开关无从谈起' }

      const raw = (body as { paused?: unknown } | undefined)?.paused
      const paused = raw === 'true' || raw === true
      try {
        await settings.update('yanxin-window', { paused })
      } catch (error) {
        return { error: `写开关失败：${brief(error instanceof Error ? error.message : error, 200)}` }
      }
      return {
        detail: paused
          ? '世界引擎已**手动暂停**：引擎行被卸下（窗口开着也不装载）。她被动回话照常。'
          : '世界引擎已恢复：交还给时段表自动管（窗口开着的话下一拍就装载）。',
      }
    },
  })

  // ── 响应群号：写 `yanxin-world`（console 服务注册的命名空间），引擎发射时读取
  //    —— 下一句话就生效，不用重启。
  ctx.console.api({
    route: 'world/group',
    method: 'POST',
    async handler({ body }) {
      const consoleService = ctx.get('console') as
        | { ensureWorldScope(): { update(patch: object): Promise<void>; get(): { worldGroupId?: string } } | undefined }
        | undefined
      const scope = consoleService?.ensureWorldScope()
      if (scope === undefined) return { error: 'settings 服务不在 —— 改不了群号（它得持久化）' }

      const raw = (body as { worldGroupId?: unknown } | undefined)?.worldGroupId
      const groupId = typeof raw === 'string' ? raw.trim() : ''
      // 群号形态与 normalizeSenderId 同一个口径：5–12 位数字。空串/坏形态一律拒 ——
      // "清空"在 settings 里没法表达（写了空串她反而说不出话且页面看不出原因），
      // 想让她闭嘴用引擎开关。
      if (!/^\d{5,12}$/.test(groupId)) {
        return { error: `群号要写成 5–12 位数字（收到了：${raw === undefined ? '什么都没给' : raw}）` }
      }
      try {
        await scope.update({ worldGroupId: groupId })
      } catch (error) {
        return { error: `写群号失败：${brief(error instanceof Error ? error.message : error, 200)}` }
      }
      return { detail: `世界群号已改为 ${groupId} —— 她**下一句话**就发到新群，不用重启。` }
    },
  })
}