/**
 * `cordis.patch.yml`（bundle 层 patch）的断言。
 *
 * 这里守两条**不可变式**，都不是功能性的：
 *
 *   1. **logger-console 的级别阈值必须放开** —— 否则 `warn` 会被静默丢弃，
 *      而我们的串号检测告警走 `warn`。安全告警静默是不该发生的（ADR 0010 附录坑二）。
 *   2. **入库的 patch 里不许出现密钥与账号** —— token / accounts 属于部署配置，
 *      必须放 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（ADR 0004 的分层）。
 *      本文件在版本库里，一旦有人把 token 写进来就会入库。
 *
 * T16 会把 patch 的*语义*回归断言（整字段覆盖）也加到这里。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const PATCH_PATH = join(import.meta.dirname, '..', '..', 'cordis.patch.yml')
const RAW = readFileSync(PATCH_PATH, 'utf8')

interface Row {
  id?: string
  name?: string
  disabled?: unknown
  config?: Record<string, unknown>
}

/** 展平 patch 文件里所有 `insert` 出来的行。 */
function insertedRows(): Row[] {
  const patches = parse(RAW) as Array<{ insert?: Row[] }>
  const rows: Row[] = []
  for (const patch of patches) {
    if (Array.isArray(patch?.insert)) rows.push(...patch.insert)
  }
  return rows
}

const ROWS = insertedRows()
const byId = new Map(ROWS.map((r) => [r.id ?? '', r]))

/**
 * patch 的**两种写法**都在用：`- insert:` 里的是新增行，顶层直接 `- id:` 的是
 * 覆盖 / 禁用 base 已有的行。只看 insert 会漏掉后者（2026-10-04 把抓取 provider
 * 从"我们插一行"改成"覆盖 base 的 web-fetch-http"之后就是这个形状）。
 */
function allRows(): Row[] {
  const patches = parse(RAW) as Array<Row & { insert?: Row[] }>
  const rows: Row[] = []
  for (const patch of patches) {
    if (Array.isArray(patch?.insert)) rows.push(...patch.insert)
    else if (patch?.id) rows.push(patch)
  }
  return rows
}
const byIdAll = new Map(allRows().map((r) => [r.id ?? '', r]))

describe('bundle patch —— logger-console 必须放开级别阈值', () => {
  it('存在 logger-console 行', () => {
    expect(byId.has('logger-console')).toBe(true)
  })

  it('⚠️ levels.default ≥ 3，否则 warn 会被静默丢弃', () => {
    // cordis 的过滤：`if ((levels?.default ?? this.level ?? 1) < level) continue;`
    // 级别数值 ERROR=0 < INFO=1 < WARN=2 < DEBUG=3，默认阈值 1 会把 warn(2) 丢掉。
    const levels = byId.get('logger-console')?.config?.levels as { default?: number } | undefined
    expect(levels?.default, 'logger-console 必须配置 levels.default（见 ADR 0010 附录）').toBeDefined()
    expect(Number(levels?.default)).toBeGreaterThanOrEqual(3)
  })

  it('用这条阈值语义做一次反证：阈值 1 确实会丢掉 warn', () => {
    const LEVEL = { error: 0, info: 1, warn: 2, debug: 3 } as const
    const skipped = (threshold: number, level: number): boolean => threshold < level

    expect(skipped(1, LEVEL.info)).toBe(false) // 默认阈值下 info 通过
    expect(skipped(1, LEVEL.warn)).toBe(true) // 但 warn 被丢 ← 这就是坑
    expect(skipped(3, LEVEL.warn)).toBe(false) // 放到 3 之后通过
  })
})

describe('bundle patch —— 其余必备行', () => {
  it('url-guard（出网 URL 守卫）', () => {
    expect(byId.get('url-guard')?.name).toBe('yanxin/src/net/url-guard.ts')
  })

  it('shell-audit（shell 审计，T36）', () => {
    expect(byId.get('shell-audit')?.name).toBe('yanxin/src/admin/shell-audit.ts')
    // 审计是横切关注点：放 host 平面（只有一行），不放 preset（三份会写三遍）。
    // 它不注册工具，所以不违反 ADR 0013 的"工具平面泄漏"纪律。
    expect(byId.get('shell-audit')?.config).toBeUndefined()
  })

  it('onebot（反向 WS 服务端）', () => {
    expect(byId.get('onebot')?.name).toBe('yanxin/src/onebot/service.ts')
  })

  it('setup（初始化向导状态机，T28）', () => {
    expect(byId.get('setup')?.name).toBe('yanxin/src/setup/index.ts')
    // `$DSH_HOME` 与包根都有代码内回退（装配事实），行 config 只该放"部署才需要改的东西" ——
    // 现在没有这类东西，所以不写 config
    expect(byId.get('setup')?.config).toBeUndefined()
  })

  it('world-model（世界模型适配器，T27b）', () => {
    expect(byId.get('world-model')?.name).toBe('yanxin/src/world/model.ts')
    // 路由缺省走 settings 的 agent-default-model —— 行 config 只在"世界要用另一个模型"时才写
    expect(byId.get('world-model')?.config).toBeUndefined()
  })

  it('console（控制台 `/yanxin`，T31）', () => {
    expect(byId.get('console')?.name).toBe('yanxin/src/console/index.ts')
    // 挂载路径有内置默认；token **只能**从环境变量来（所以行 config 里永远不该有它）
    expect(byId.get('console')?.config).toBeUndefined()
  })

  it('web-server（控制台的载体，T31）', () => {
    expect(byId.get('web-server')?.name).toBe('@deepseek-ai/dsh-host-webserver')
    // 只绑回环：控制台是本机运维界面（代码里还有第二道门——非回环一律 403）
    expect(byId.get('web-server')?.config).toEqual({ host: '127.0.0.1', port: 3080 })
  })

  it('web-fetch-http（覆盖 base 自带的抓取 provider，T35 的限额落在这行）', () => {
    // ⚠️ 2026-10-04：provider 行**不再由我们 insert**。发布版 dsh-base 0.1.5-rc.3 自带
    // `- id: web-fetch-http`，我们再插一份（旧写法叫 web-fetch-provider）就是同一个插件
    // 实例化两次 → `a web provider with id "http" is already registered` → 整棵树装不起来。
    expect(byId.has('web-fetch-provider'), '不许再插一份 web fetch provider —— base 已经有了').toBe(false)
    const config = byIdAll.get('web-fetch-http')?.config ?? {}
    expect(byIdAll.get('web-fetch-http')?.name).toBe('@deepseek-ai/dsh-web-fetch-http')
    // ⚠️ 上游默认 maxRedirects=5，spec §7.4-A 第 4 条要求 ≤3 —— 不写就是放行 5 跳
    expect(config.maxRedirects, '抓取跳数上限必须显式写进 config').toBeDefined()
    expect(Number(config.maxRedirects)).toBeLessThanOrEqual(3)
    // 体积与超时也要显式（patch 整字段覆盖，不能指望"没写的键还是默认值"这种印象）
    expect(Number(config.maxResponseBytes)).toBeGreaterThan(0)
    expect(Number(config.timeoutMs)).toBeGreaterThan(0)
  })

  it('每行都有 id 与 name', () => {
    for (const row of ROWS) {
      expect(row.id, '有行缺少 id').toBeTruthy()
      expect(row.name, `${row.id} 缺少 name`).toBeTruthy()
    }
  })
})

describe('⚠️ bundle patch 里不许有密钥与账号（ADR 0004 的分层）', () => {
  it('onebot 行不携带 config —— 端口/token/账号都是部署配置，放 profile patch', () => {
    expect(byId.get('onebot')?.config).toBeUndefined()
  })

  it('全文不含 access_token / token 赋值 / Bearer 字面量', () => {
    // 只查"看起来像值"的形态；注释里提到 token 这个词是允许的
    expect(RAW).not.toMatch(/access_token\s*[:=]\s*\S/)
    expect(RAW).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/)
  })

  it('全文不含 accounts / selfId 这类账号注册表内容', () => {
    expect(RAW).not.toMatch(/^\s*accounts\s*:/m)
    expect(RAW).not.toMatch(/^\s*-?\s*selfId\s*:/m)
  })

  it('全文不含 QQ 号形态的长数字串', () => {
    // 注释里可以出现 IDENTIFIER 之类的短数字，但 8 位以上的裸数字串不该出现
    const bareLongDigits = RAW.split('\n').filter((line) => !line.trimStart().startsWith('#') && /\b\d{8,}\b/.test(line))
    expect(bareLongDigits, `疑似硬编码的 QQ 号：${bareLongDigits.join(' | ')}`).toEqual([])
  })
})
