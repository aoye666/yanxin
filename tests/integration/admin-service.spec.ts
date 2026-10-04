/**
 * `AdminService` 的服务层验收（T3）。
 *
 * 纯判定逻辑已在 `admin-logic.spec.ts` 覆盖；这里测的是**接线**：
 *   - 服务能否注册起来、`ctx.admin` 是否可用
 *   - 名单能否经 `ctx.settings` 读写（`update` → `get` 反映新值）
 *   - 变更是否发出 `yanxin/admin-updated` 事件
 *   - **空名单经服务仍 fail-closed**（不是只在纯函数里 fail-closed）
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AdminService from '../../src/admin/index.ts'
import MemorySettings from '../support/memory-settings.ts'

const ALOYE = '2000000001'
const OTHER = '3000000001'

const opened: Context[] = []

async function makeCtx(): Promise<Context> {
  const ctx = new Context()
  opened.push(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(AdminService)
  return ctx
}

afterEach(async () => {
  while (opened.length) await opened.pop()?.fiber.dispose()
})

describe('AdminService —— 接线', () => {
  it('挂载后 ctx.admin 可用，且默认名单为空', async () => {
    const ctx = await makeCtx()
    expect(ctx.admin).toBeDefined()
    expect(ctx.admin.admins).toEqual([])
  })

  it('⚠️ 空名单经服务仍 fail-closed', async () => {
    const ctx = await makeCtx()
    for (const candidate of [ALOYE, OTHER, '', undefined, 123]) {
      expect(ctx.admin.isAdmin(candidate), JSON.stringify(candidate)).toBe(false)
    }
  })
})

describe('AdminService —— 增删与持久化', () => {
  it('add 后 isAdmin 为真，且 get 反映新值', async () => {
    const ctx = await makeCtx()
    await ctx.admin.add(ALOYE)
    expect(ctx.admin.admins).toEqual([ALOYE])
    expect(ctx.admin.isAdmin(ALOYE)).toBe(true)
    expect(ctx.admin.isAdmin(OTHER)).toBe(false)
  })

  it('重复 add 不产生重复项', async () => {
    const ctx = await makeCtx()
    await ctx.admin.add(ALOYE)
    await ctx.admin.add(ALOYE)
    await ctx.admin.add(` ${ALOYE} `) // 带空白也应去重
    expect(ctx.admin.admins).toEqual([ALOYE])
  })

  it('remove 后 isAdmin 为假；移除不存在项是空操作', async () => {
    const ctx = await makeCtx()
    await ctx.admin.add(ALOYE)
    await ctx.admin.add(OTHER)
    await ctx.admin.remove(ALOYE)
    expect(ctx.admin.admins).toEqual([OTHER])
    expect(ctx.admin.isAdmin(ALOYE)).toBe(false)

    await ctx.admin.remove('999')
    expect(ctx.admin.admins).toEqual([OTHER])
  })

  it('名单变更会写入 settings 文档（不是只留在内存里）', async () => {
    const ctx = await makeCtx()
    await ctx.admin.add(ALOYE)
    const provider = ctx.settings as unknown as { snapshot(): Record<string, unknown> }
    expect(provider.snapshot()).toHaveProperty('yanxin-admin')
    expect(provider.snapshot()['yanxin-admin']).toEqual({ admins: [ALOYE] })
  })

  it('清空全部管理员后回到 fail-closed', async () => {
    const ctx = await makeCtx()
    await ctx.admin.add(ALOYE)
    await ctx.admin.remove(ALOYE)
    expect(ctx.admin.admins).toEqual([])
    expect(ctx.admin.isAdmin(ALOYE)).toBe(false)
  })
})

describe('AdminService —— 变更事件', () => {
  it('名单提交后发出 yanxin/admin-updated，参数是新名单', async () => {
    const ctx = await makeCtx()
    const seen: string[][] = []
    ctx.on('yanxin/admin-updated', (admins) => {
      seen.push([...admins])
    })

    await ctx.admin.add(ALOYE)
    await ctx.admin.add(OTHER)

    // watch 的回调是异步的（文档：invocations run asynchronously, one at a time, in commit order）
    await new Promise((r) => setTimeout(r, 50))

    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.at(-1)).toEqual([ALOYE, OTHER])
  })
})
