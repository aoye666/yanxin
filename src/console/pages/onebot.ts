/**
 * OneBot 传输层页（`/yanxin/onebot`）—— 监听地址、端口、access token、路径、超时。
 *
 * ## 这一页存在的理由
 *
 * 这几项原本只在 **profile 的部署 patch** 里（`deploy/profile.example.cordis.patch.yml`），
 * 改一次要动文件 + 重启实例。而其中最典型的两个动作恰恰是"要快"的：
 *   · token 泄漏了要立刻换掉 —— 多一分钟，多一分钟能被冒充；
 *   · 端口撞了要挪走。
 * 所以它们提到了 settings 的 `yanxin-onebot` 命名空间（`src/onebot/transport.ts`），
 * 写完 `scope.watch` 触发重听，**不用重启**。
 *
 * ## 为什么 `accounts` 不在这里改
 *
 * 账号注册表决定"这个 QQ 号的会话挂哪个 preset" —— 那是**能力构成**（谁拿得到 shell），
 * 不是运营参数。改它等于改权限边界，所以本页只读显示，要改仍然走 profile patch。
 *
 * ## 安全门（服务端判据，不是给浏览器看的提示）
 *
 * 把监听地址从回环改成 `0.0.0.0` / 一个网卡地址，等于**在本机之外开一个入口**。
 * 这个端口没有别的服务在守：token 一空，任何能连上它的人都能冒充她的客户端
 * （推假事件、拿到回发目标），而 §7.4-A 那个 URL 守卫**管不到** —— 它只管 harness
 * 自己主动发起的请求。所以两条硬规则：
 *   1. 非回环 **必须有 token**；
 *   2. 非回环 **必须显式勾选确认**。
 * 缺一即拒保存（`validateTransportInput`）。换回回环不需要确认 —— 不要把安全门做成
 * 双向摩擦，否则人会绕过它去改文件。
 *
 * ⚠️ token 的**当前值永不回显**：这一页是免凭据可读的（§6.12 的只读页规则），
 *    把值渲染出去等于把它给任何本机进程看。只显示"已设置 / 未设置"。
 *
 * ⚠️ 装配纪律（ADR 0004）：命名导出，不写 default。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Block } from '../logic.ts'
import { brief, missingService } from './support.ts'
import { isPublicBindHost, validateTransportInput, type Transport, type TransportOverride } from '../../onebot/transport.ts'
import type { AccountConfig } from '../../onebot/service.ts'
import type { ClientRole } from '../../onebot/protocol.ts'

export const name = 'yanxin-console-onebot-page'
export const inject = ['console']

/** 本页用到的 onebot 服务面（软查询：onebot 行没装载时页面要能降级）。 */
interface OneBotLike {
  readonly transport: Transport
  readonly listenPoint: { host: string; port: number }
  readonly accounts: readonly AccountConfig[]
  connectionsOf(selfId: string): ClientRole[]
  updateTransport(patch: TransportOverride): Promise<void>
}

/** 监听地址的可读注解 —— 页面上"127.0.0.1"这种字符串看不出风险在哪。 */
function bindHint(host: string): string {
  if (!isPublicBindHost(host)) return `${host}（回环：只有本机进程能连）`
  if (host === '0.0.0.0' || host === '::') return `${host}（**所有网卡** —— 同网络的机器都能连这个端口）`
  return `${host}（非回环：外部可达）`
}

/**
 * 组装本页的区块。纯函数，所以"当前状态怎么呈现"与"改了会怎样"都能单独测。
 *
 * ⚠️ 表单里 `token` 字段**故意没有 value**：预填就等于把秘密渲染出去了。
 */
export function renderOnebotBlocks(onebot: OneBotLike, base: string): readonly Block[] {
  const t = onebot.transport
  const bound = onebot.listenPoint
  const online = onebot.accounts.map((a) => onebot.connectionsOf(a.selfId))

  const blocks: Block[] = [
    {
      kind: 'notice',
      tone: 'info',
      text:
        '改这里**不用重启**：写完会立刻生效（token / 路径 / 超时是下一条连接握手时就按新值判；' +
        '监听地址或端口变了会**换绑** —— 已经连上的连接不断开，只拒新连）。',
    },
    {
      kind: 'table',
      caption: '现在生效的监听',
      head: ['项', '值'],
      rows: [
        ['监听地址', bindHint(t.host)],
        // 端口显示**真实绑上的**那个：配置写 0 = 系统分配，这时页面上必须显示实际端口号，
        // 不然运维拿"0"去填 NapCat 的 URL，会连不上而且看不出为什么。
        ['监听端口', `${bound.port}`],
        ['升级路径', t.path === '' ? '（不限：任何路径都接受升级请求）' : t.path],
        ['access token', t.token === '' ? '未设置（不校验）' : '已设置（值不回显）'],
        ['ping 间隔', `${t.pingIntervalMs} ms`],
        ['API 调用超时', `${t.callTimeoutMs} ms`],
      ],
    },
  ]

  if (isPublicBindHost(t.host)) {
    blocks.push({
      kind: 'notice',
      tone: 'warn',
      text:
        `现在监听在 **${t.host}** —— 这台机器之外的地址也能连这个端口。` +
        (t.token === ''
          ? '而且**没有 access token**：任何能连上它的人都可以冒充她的客户端。建议立刻填 token，或把地址改回 127.0.0.1。'
          : '有 token 挡着。确认这个 token 没有泄漏到任何公开地方（它同时出现在 NapCat 侧的配置里）。'),
    })
  }

  blocks.push({
    kind: 'table',
    caption: '账号注册表（只读）',
    head: ['selfId', 'preset', '在线角色'],
    rows:
      onebot.accounts.length === 0
        ? [['—', '—', '（profile patch 里没注册任何账号 —— 所有连接都会被拒 403）']]
        : onebot.accounts.map((a, i) => [
            a.selfId,
            a.preset,
            online[i]?.length ? online[i].join(' / ') : '（没连上）',
          ]),
  })
  blocks.push({
    kind: 'p',
    text: '账号注册表决定"这个号的会话挂哪套能力"（谁拿得到 shell），属于**能力构成**而不是运营参数，所以这一页改不了 —— 要改走 profile 的 `cordis.patch.yml`。',
  })

  blocks.push({
    kind: 'form',
    action: `${base}/api/onebot/listen`,
    submit: '改监听地址与端口',
    fields: [
      {
        name: 'host',
        label: '监听地址',
        value: t.host,
        hint: '回环 = 127.0.0.1 或 ::1；本机之外要用 0.0.0.0 或一个具体网卡 IPv4。改这里会触发换绑。',
      },
      {
        name: 'port',
        label: '监听端口',
        value: `${bound.port}`,
        hint: '0 = 交给系统分配（分配结果会显示在上面这张表里，拿去填 NapCat 的 URL）。',
      },
      {
        name: 'confirm_public',
        type: 'checkbox',
        label: '我确认这台机器的这个端口要对外可访问',
        value: 'false',
        hint: '只有改成非回环时才需要勾。勾了仍然要求已有 access token —— 两条缺一都会拒。',
      },
    ],
  })

  blocks.push({
    kind: 'form',
    action: `${base}/api/onebot/credentials`,
    submit: '改鉴权与调优',
    fields: [
      {
        name: 'token',
        type: 'password',
        label: 'access token（留空 = 不改）',
        hint: '要与 NapCat/SnowLuma 的「鉴权 Token」填同一个值。**当前值不显示也不回填**，只能整体替换。',
      },
      {
        name: 'path',
        label: '升级路径（留空 = 不改）',
        value: t.path,
        hint: `当前：${t.path === '' ? '不限' : t.path}。填一个以 / 开头的路径可以收窄"谁能连"。`,
      },
      { name: 'pingIntervalMs', label: 'ping 间隔（毫秒，留空 = 不改）', value: `${t.pingIntervalMs}` },
      { name: 'callTimeoutMs', label: 'API 调用超时（毫秒，留空 = 不改）', value: `${t.callTimeoutMs}` },
    ],
  })

  blocks.push({
    kind: 'p',
    text: '取值顺序是 **settings → profile patch 的行 config → 代码默认**。也就是说这一页改过的项，会盖掉 patch 里写的值；想回到 patch 的基线，把 settings 的 `yanxin-onebot` 段删掉即可（`$DSH_HOME/settings.yaml`）。',
  })

  return blocks
}

/** onebot 行没装载时说什么（与"装载了但没账号"是两件事）。 */
function onebotMissingBlocks(): readonly Block[] {
  return [
    ...missingService('OneBot'),
    {
      kind: 'p',
      text: '传输参数（host / port / token）属于 `yanxin-onebot` 命名空间；服务不在时改了也没人读，所以这一页不提供写入口。',
    },
  ]
}

/** 装页与接口。 */
export function apply(ctx: Context): void {
  ctx.console.page({
    slug: 'onebot',
    title: 'OneBot 连接',
    render({ base }) {
      const onebot = ctx.get('onebot') as OneBotLike | undefined
      if (onebot === undefined) return onebotMissingBlocks()
      return renderOnebotBlocks(onebot, base)
    },
  })

  // ── 改监听（host / port）：走同一套校验，非回环要 token + 确认 ────────────
  ctx.console.api({
    route: 'onebot/listen',
    method: 'POST',
    async handler({ body }) {
      return writeTransport(ctx, body, ['host', 'port', 'confirm_public'], '监听')
    },
  })

  // ── 改鉴权与调优（token / path / 超时）──────────────────────────────────
  ctx.console.api({
    route: 'onebot/credentials',
    method: 'POST',
    async handler({ body }) {
      return writeTransport(ctx, body, ['token', 'path', 'pingIntervalMs', 'callTimeoutMs'], '鉴权与调优')
    },
  })
}

/**
 * 两个写接口共用的一条路：取 onebot → 校验 → 落 settings → 回一句"什么时候生效"。
 *
 * `allowed` 是**这张表单允许改的字段白名单**：表单与接口一一对应，
 * 不写白名单的话"改鉴权"那张表也能顺手把 host 换掉 —— 而换 host 是需要确认的那一类，
 * 绕过确认门就等于门没有。
 */
async function writeTransport(
  ctx: Context,
  body: unknown,
  allowed: readonly string[],
  label: string,
): Promise<unknown> {
  const onebot = ctx.get('onebot') as OneBotLike | undefined
  if (onebot === undefined) return { error: 'OneBot 服务不在 —— 改了也没有读它的人' }

  const input = (body ?? {}) as Record<string, unknown>
  // 白名单外的一律不看（宁可拒，也不要"看起来只改了这一张表"却动了别的东西）
  const extras = Object.keys(input).filter((key) => !allowed.includes(key) && input[key] !== '' && input[key] !== undefined)
  if (extras.length > 0) {
    return { error: `这张表单不接受：${extras.join(' / ')}（换监听地址在另一张表里，那里要确认）` }
  }

  const verdict = validateTransportInput(input, onebot.transport)
  if (!verdict.ok) return { error: verdict.reason }

  const patch = verdict.patch
  if (Object.keys(patch).length === 0) return { error: '什么都没改 —— 表单里留空表示"不改这一项"' }

  // 监听点没变就别喊"正在换绑"（写了同样的 host/port 是常见误操作）。
  // ⚠️ 比的是**生效值**（settings → 行 config 算出来的那一份），不是 `listenPoint`：
  //    端口写 0 = 系统分配，`listenPoint.port` 是真实端口，拿它比会把"没改端口"判成换绑 ——
  //    服务内部的换绑门用的是同一个口径（`OneBotService.requested`）。
  const current = onebot.transport
  const willRebind =
    (patch.host !== undefined && patch.host !== current.host) ||
    (patch.port !== undefined && patch.port !== current.port)

  try {
    await onebot.updateTransport(patch)
  } catch (error) {
    return { error: `${label}没改成：${brief(error instanceof Error ? error.message : error, 200)}` }
  }

  const changed = Object.keys(patch)
  return {
    detail:
      `${label}已更新（${changed.join(' / ')}）` +
      (willRebind
        ? ' —— 正在换到新地址；**已经连上的连接不会断**，新连接按新端口进来。要是端口被占用，会保持原监听并在日志里留一行 WARN。'
        : ' —— 下一条连接握手起就按新值判。记得把 NapCat 侧的「鉴权 Token」改成同一个值，否则它会被 401 拒掉。'),
  }
}
