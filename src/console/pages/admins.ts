/**
 * 管理员页（T32）—— `ctx.admin` 名单的增删。
 *
 * ## 三条纪律
 *
 *   · **不自己判身份**：名单与判定都问 `ctx.admin`（`isAdmin` 是它的事，权限强制点是
 *     preset 能力构成，不是这一页）
 *   · **写操作自动进审计**：控制台服务对所有非 GET 请求留痕（`console.jsonl`），
 *     这一页不需要自己写审计（写了反而会有两套）
 *   · **越权提示留在页面上**：这一页改的是"谁能拿到 shell"，所以它本身只绑回环 +
 *     要 token —— 那两道门在 `console/index.ts`，这一页不重复实现
 *
 * ## 为什么移除也要一个表单
 *
 * 表单区块只有文本/密码/勾选三种字段，没有按钮组。所以"每个管理员一行一个移除按钮"
 * 做不到；做法是**一个移除表单**填要摘掉的那个号 —— 与添加表单对称，且都能被
 * 表驱动地断言（`renderAdminsBlocks` 是纯函数）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Block } from '../logic.ts'
import { brief, missingService } from './support.ts'

/** 装配纪律（ADR 0004）：命名导出 + `inject`，**不写 default**。 */
export const name = 'yanxin-console-admin-page'
export const inject = ['console']

/** 管理员服务在本页用到的最小面。 */
interface AdminLike {
  readonly admins: readonly string[]
  add(senderId: unknown): Promise<void>
  remove(senderId: unknown): Promise<void>
}

/** 号码规范化：去掉空白；这里**只查形态**，是不是"真的管理员"由服务判定。 */
export function normalizeSenderId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value === '') return undefined
  return /^\d{5,12}$/.test(value) ? value : undefined
}

/** 名单的区块（纯函数，便于断言）。 */
export function renderAdminsBlocks(admins: readonly string[], base: string): readonly Block[] {
  const blocks: Block[] = []

  blocks.push(
    admins.length === 0
      ? {
          kind: 'notice',
          tone: 'warn',
          text: '名单是空的 —— 现在**没有任何人是管理员**（fail-closed：认不出就当普通人）。要给她下指令就先加一个。',
        }
      : { kind: 'p', text: `当前 ${admins.length} 位管理员（私聊里能拿到 shell 的只有他们）。` },
  )

  if (admins.length > 0) {
    blocks.push({
      kind: 'table',
      caption: '名单',
      head: ['QQ 号'],
      rows: admins.map((id) => [id]),
    })
  }

  blocks.push({
    kind: 'form',
    action: `${base}/api/admins/add`,
    submit: '加入名单',
    fields: [{ name: 'senderId', label: 'QQ 号', hint: '10 位左右的数字；加入后立刻生效（她下一句就按新名单判）' }],
  })
  blocks.push({
    kind: 'form',
    action: `${base}/api/admins/remove`,
    submit: '移出名单',
    fields: [{ name: 'senderId', label: 'QQ 号', hint: '摘掉之后那个人在私聊里就只剩普通能力' }],
  })
  blocks.push({
    kind: 'p',
    text: '名单存在 settings 的 `yanxin-admin` 命名空间（即 `$DSH_HOME/settings.yaml`）；服务会热重载。',
  })
  return blocks
}

/** 装页与接口。 */
export function apply(ctx: Context): void {
  ctx.console.page({
    slug: 'admins',
    title: '管理员',
    render({ base }) {
      const admin = ctx.get('admin') as AdminLike | undefined
      if (admin === undefined) return missingService('管理员')
      return renderAdminsBlocks(admin.admins, base)
    },
  })

  for (const verb of ['add', 'remove'] as const) {
    ctx.console.api({
      route: `admins/${verb}`,
      method: 'POST',
      async handler({ body }) {
        const admin = ctx.get('admin') as AdminLike | undefined
        if (admin === undefined) return { error: '管理员服务不在（`admin` 行没装载）' }

        const senderId = normalizeSenderId((body as { senderId?: unknown } | undefined)?.senderId)
        if (senderId === undefined) return { error: '没给有效的 QQ 号（5–12 位数字）' }

        try {
          await admin[verb](senderId)
        } catch (error) {
          return { error: `改名单失败：${brief(error instanceof Error ? error.message : error, 200)}` }
        }
        const action = verb === 'add' ? '已加入' : '已移出'
        return { detail: `${action} ${senderId}；现在名单是 ${admin.admins.join('、') || '（空）'}` }
      },
    })
  }
}