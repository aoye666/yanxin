/**
 * 管理员判定逻辑的验收（T3）。
 *
 * 重点在 **fail-closed**：空名单必须一律拒绝，不能因为"没配"就默认放行 ——
 * 那是 fail-open，是权限系统最常见的致命错误。
 */
import { describe, expect, it } from 'vitest'
import { isAdminIn, normalizeAdminId, normalizeAdminList, withAdmin, withoutAdmin } from '../../src/admin/logic.ts'

const OWNER_QQ = '1000000001'
const OTHER = '2000000002'

describe('isAdminIn —— 基本判定', () => {
  it('名单内 → true；名单外 → false', () => {
    const admins = [OWNER_QQ]
    expect(isAdminIn(admins, OWNER_QQ)).toBe(true)
    expect(isAdminIn(admins, OTHER)).toBe(false)
  })

  it('多名单：任一命中即可', () => {
    const admins = [OWNER_QQ, OTHER]
    expect(isAdminIn(admins, OWNER_QQ)).toBe(true)
    expect(isAdminIn(admins, OTHER)).toBe(true)
    expect(isAdminIn(admins, '999')).toBe(false)
  })
})

describe('isAdminIn —— fail-closed（关键安全断言）', () => {
  it('⚠️ 空名单 → 一律 false，绝不因为"没配"而放行', () => {
    for (const candidate of [OWNER_QQ, OTHER, '', 'anything']) {
      expect(isAdminIn([], candidate), JSON.stringify(candidate)).toBe(false)
    }
  })

  it('无效 senderId 一律 false', () => {
    const admins = [OWNER_QQ]
    const invalid: unknown[] = [undefined, null, '', '   ', '\t\n', 123, 1000000001, {}, [], true]
    for (const bad of invalid) {
      expect(isAdminIn(admins, bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('isAdminIn —— 精确匹配，不做前缀或包含', () => {
  it('"123" 不应命中 "1234"，反之亦然', () => {
    expect(isAdminIn(['1234'], '123')).toBe(false)
    expect(isAdminIn(['123'], '1234')).toBe(false)
    expect(isAdminIn(['1000000001'], '158008968')).toBe(false)
    expect(isAdminIn(['1000000001'], '10000000010')).toBe(false)
  })

  it('查询方的前后空白会被规范化掉（OneBot 侧可能带来空格）', () => {
    expect(isAdminIn([OWNER_QQ], `  ${OWNER_QQ}  `)).toBe(true)
  })

  it('名单纯函数的契约：要求输入已规范化（名单侧的空白归 normalizeAdminList）', () => {
    // 刻意断言这个"不对称"，把分层写清楚：
    //   isAdminIn           = 输入已规范化时的精确匹配谓词
    //   normalizeAdminList  = 边界层，负责把名单规范化
    // 若在这里"顺手"也规范化名单，规范化就有了两处实现，边界层的必要性也被掩盖。
    // 这条曾经让我写错过测试 —— 见 ADR 0007。
    expect(isAdminIn([` ${OWNER_QQ} `], OWNER_QQ)).toBe(false)
  })
})

describe('normalizeAdminList —— 边界层的名单规范化', () => {
  it('trim 每一条', () => {
    expect(normalizeAdminList([` ${OWNER_QQ} `, `  ${OTHER}`])).toEqual([OWNER_QQ, OTHER])
  })

  it('丢弃无效项', () => {
    expect(normalizeAdminList([OWNER_QQ, '', '   ', 123, null, undefined, {}])).toEqual([OWNER_QQ])
  })

  it('去重（含 trim 之后才相同的）', () => {
    expect(normalizeAdminList([OWNER_QQ, ` ${OWNER_QQ} `, OWNER_QQ])).toEqual([OWNER_QQ])
  })

  it('规范化后能正确命中 —— 这就是它存在的理由', () => {
    const admins = normalizeAdminList([`  ${OWNER_QQ}  `])
    expect(admins).toEqual([OWNER_QQ])
    expect(isAdminIn(admins, OWNER_QQ)).toBe(true)
  })

  it('空名单仍是空名单（fail-closed 不被破坏）', () => {
    const admins = normalizeAdminList(['', '  ', 1, null])
    expect(admins).toEqual([])
    expect(isAdminIn(admins, OWNER_QQ)).toBe(false)
  })
})

describe('normalizeAdminId', () => {
  it('合法输入去空白；非法输入 undefined', () => {
    expect(normalizeAdminId('  1000000001 ')).toBe(OWNER_QQ)
    expect(normalizeAdminId(OWNER_QQ)).toBe(OWNER_QQ)
    for (const bad of [undefined, null, '', '   ', 123, {}, []]) {
      expect(normalizeAdminId(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

describe('withAdmin —— 追加', () => {
  it('追加到末尾并保持原顺序', () => {
    expect(withAdmin([OWNER_QQ], OTHER)).toEqual([OWNER_QQ, OTHER])
  })

  it('幂等：重复追加不产生重复项', () => {
    const once = withAdmin([OWNER_QQ], OTHER)
    expect(withAdmin(once, OTHER)).toEqual([OWNER_QQ, OTHER])
    expect(withAdmin(once, ` ${OTHER} `)).toEqual([OWNER_QQ, OTHER])
  })

  it('非法输入原样返回', () => {
    for (const bad of [undefined, null, '', '  ', 42]) {
      expect(withAdmin([OWNER_QQ], bad)).toEqual([OWNER_QQ])
    }
  })

  it('不改入参（返回新数组）', () => {
    const original = [OWNER_QQ]
    const next = withAdmin(original, OTHER)
    expect(original).toEqual([OWNER_QQ])
    expect(next).not.toBe(original)
  })
})

describe('withoutAdmin —— 移除', () => {
  it('移除命中的项，保留其余', () => {
    expect(withoutAdmin([OWNER_QQ, OTHER], OWNER_QQ)).toEqual([OTHER])
  })

  it('移除不存在的项是空操作', () => {
    expect(withoutAdmin([OWNER_QQ], OTHER)).toEqual([OWNER_QQ])
  })

  it('可移除全部（得到空名单 → 之后 isAdmin 全部 false）', () => {
    const emptied = withoutAdmin([OWNER_QQ], OWNER_QQ)
    expect(emptied).toEqual([])
    expect(isAdminIn(emptied, OWNER_QQ)).toBe(false)
  })

  it('不改入参（返回新数组）', () => {
    const original = [OWNER_QQ, OTHER]
    const next = withoutAdmin(original, OWNER_QQ)
    expect(original).toEqual([OWNER_QQ, OTHER])
    expect(next).not.toBe(original)
  })
})
