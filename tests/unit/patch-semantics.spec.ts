/**
 * DSH 的 **patch 语义**回归测试（spec §8 的 T16）。
 *
 * ## 要防的是什么
 *
 * patch 只有两种操作：**`insert`** 与**按 id 整字段覆盖** —— **没有深度合并**。
 * 后来者极易写出"只想改 config 里一个键"的 patch，而它会**静默踢掉**同一 config
 * 里的其它键。真正的受害者是 `agent-presets` 那种"DSH 自己也配了 config"的行：
 * 我们写 `config: { default: xiaoyan-agent }` 时，base 的 config 就整个没了。
 *
 * ## 为什么直接测 DSH 的函数而不是我们的 patch 文件
 *
 * `applyEntryPatches` 是**权威实现** —— 它的文档原话：
 *
 * > THE patch semantics of this include, shared by mounting and query-less config
 * > tooling (`dsh --dump-config`) so a dump can never drift from what boots.
 *
 * 测它 = 测"我们的理解"，而不是测"我们的文件长什么样"。文件会被改，语义不会。
 *
 * ⚠️ 它 import 的是 **DSH monorepo 的源码**（`vendor/include/src/index.ts`）——
 * 这个函数没有以 npm 包的形式发布。所以路径可配（`YANXIN_DSH_MONOREPO` 环境变量），
 * 找不到时**整组 skip**，而不是让不在这台机器上的检出硬失败。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * monorepo 位置**只从环境变量来**：`YANXIN_DSH_MONOREPO=<DSH 检出目录>`。
 *
 * 为什么不写死默认路径，也不改成本地 `node_modules` 里那份已发布的包：
 *   · 写死 = 在别人机器上永远指着一个不存在的目录，skip 得有理由，而"忘了设"不是理由；
 *   · 引 `@deepseek-ai/cordis-plugin-include` 会让 pnpm 装出**第二份 cordis**（它钉 ~4.0.4，
 *     而 `dsh-*` 钉 4.0.2），同进程两份 cordis 会让 symbols 身份判定全错 —— 见 spec §9 Never。
 * 没设这个变量时整组 skip：这组断言的对象是**上游** `applyEntryPatches` 的行为，
 * 本地没有上游源码就没得断言，跳过比假装通过诚实。
 */
const MONOREPO = process.env.YANXIN_DSH_MONOREPO ?? ''
const PATCH_SOURCE = MONOREPO === '' ? '' : join(MONOREPO, 'vendor', 'include', 'src', 'index.ts')
const HAS_SOURCE = PATCH_SOURCE !== '' && existsSync(PATCH_SOURCE)

/** patch 应用函数的最小签名（类型来自 monorepo 源码，不引它的包）。 */
type ApplyPatches = (
  data: Record<string, unknown>[],
  patches: Record<string, unknown>[] | undefined,
  warn: (message: string, ...args: unknown[]) => void,
) => Record<string, unknown>[]

const loaded = HAS_SOURCE
  ? ((await import(pathToFileURL(PATCH_SOURCE).href)) as { applyEntryPatches: ApplyPatches })
  : undefined

/** 只在源码存在时运行 —— 否则这组测试没有意义（也跑不了）。 */
const suite = describe.skipIf(!HAS_SOURCE)

suite('T16 —— patch 只有 insert + 整字段覆盖，没有深度合并', () => {
  const apply = (data: Record<string, unknown>[], patches: Record<string, unknown>[]) =>
    (loaded as { applyEntryPatches: ApplyPatches }).applyEntryPatches(data, patches, () => {})

  it('⚠️ 只改 config 里一个键 → 整个 config 被替换（其它键静默消失）', () => {
    const data = [{ id: 'x', name: 'some-pkg', config: { keep: 1, change: 2, also: 3 } }]

    const out = apply(data, [{ id: 'x', config: { change: 99 } }])

    expect(out[0]?.config).toEqual({ change: 99 })
    // 这两条才是重点：它们**没了**，而且没有任何警告
    expect(out[0]?.config).not.toHaveProperty('keep')
    expect(out[0]?.config).not.toHaveProperty('also')
  })

  it('对照：**行上的**其它字段未提及则保留 —— 只有 config 是整字段替换', () => {
    const data = [{ id: 'x', name: 'some-pkg', config: { a: 1 } }]

    const out = apply(data, [{ id: 'x', config: { b: 2 } }])

    expect(out[0]?.name, 'name 未被 patch 提及 → 保留原值').toBe('some-pkg')
    expect(out[0]?.config, 'config 被提及 → 整个替换').toEqual({ b: 2 })
  })

  it('目标 id 拼错 → warn 并跳过（不抛错、不影响其它行）', () => {
    const warnings: string[] = []

    const out = (loaded as { applyEntryPatches: ApplyPatches }).applyEntryPatches(
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'typo-does-not-exist', disabled: true }],
      (message, ...args) => {
        warnings.push(`${message} ${args.map(String).join(' ')}`)
      },
    )

    expect(warnings.length, '拼错 id 应当产生诊断').toBeGreaterThan(0)
    expect(warnings.join('\n')).toContain('typo-does-not-exist')
    expect(out.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('`insert` 追加到根列表末尾', () => {
    const out = apply([{ id: 'a' }], [{ insert: [{ id: 'b' }, { id: 'c' }] }])

    expect(out.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('同一条 patch 列表里，**后面的 patch 能命中前面 insert 的行**', () => {
    // 文档："Inserted entries are indexed as they are added, so a later patch in the
    // same list can target a row an earlier patch inserted."
    // 这条支撑了我们的用法：bundle patch 里 insert 一行、同一文件后面再覆盖它。
    const out = apply([], [{ insert: [{ id: 'fresh' }] }, { id: 'fresh', disabled: true }])

    expect(out[0]?.disabled).toBe(true)
  })

  it('⚠️ 不修改输入 —— 共享对象会把早先的 patch 值烤进缓存', () => {
    // 文档："The input is never mutated and the result is always detached from it
    // (even with no patches): patching or mounting shared entry objects would bake
    // earlier values into the cached parse, so repeated application (config
    // hot-reloads) could never revert a removed or changed patch."
    const data = [{ id: 'x', config: { a: 1 } }]

    const out = apply(data, [{ id: 'x', config: { a: 2 } }])

    expect(data[0]?.config, '原对象必须原封不动').toEqual({ a: 1 })
    expect(out[0]?.config, '返回的是新对象').toEqual({ a: 2 })
  })
})
