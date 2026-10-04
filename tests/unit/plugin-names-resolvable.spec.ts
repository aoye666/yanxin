/**
 * 装配里引用的每个第三方插件名，**必须有人在运行时提供它**。
 *
 * 为什么值得钉一条断言：`name:` 写一个解析不到的包，不是"这行不生效"，而是
 * **挂载时才炸**（`ERR_MODULE_NOT_FOUND`），本机往往看不出来 —— 2026-10-04 就撞了两次：
 *   · `@deepseek-ai/cordis-plugin-logger-console`：base 不带（只有 `session-log-deepseek`），
 *     要靠 `dsh plugin add` 装进 **profile**（它的 import 上下文是 profile 目录）；
 *   · `@deepseek-ai/dsh-tool-subagent-report`：发布版 0.1.5-rc.3 这条线上**没有这个包**，
 *     已从 admin preset 删掉。
 *
 * 三份清单的来源都不是记忆：
 *   · PROVIDER_PACKAGES 取自镜像里 `dsh` 的 node_modules 与 `/app/node_modules` 的实测列表
 *     （`docker run --entrypoint sh yanxin:local -c 'ls …'`，2026-10-04）；
 *   · 本仓依赖取自 `package.json`；
 *   · PROFILE_INSTALLED 是 `Dockerfile` 的 seed 步骤与 `scripts/install.mjs` 显式装进 profile 的包。
 * ⚠️ 换 dsh 版本时**重新导一次 PROVIDER_PACKAGES**：它变了而清单没跟着改，这条断言就会红，
 *      那是要的 —— 逼人对一遍装配树，而不是等容器起不来。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..')

/** 装配里出现过的第三方名字来自这几份文件（preset 是生成产物，但行是模板里的）。 */
const SOURCES = [
  'cordis.patch.yml',
  'presets/xiaoyan-agent/agent.cordis.yml',
  'presets/xiaoyan-admin/agent.cordis.yml',
  'presets/xiaoyan-world/agent.cordis.yml',
]

/** 发布版 `@deepseek-ai/dsh@0.1.5-rc.3` 的树里实测存在的包。 */
const PROVIDER_PACKAGES = new Set([
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-web-fetch-http',
])

/** 由安装步骤显式装进 profile 的（base 不带，运行时上下文也只认 profile 目录）。 */
const PROFILE_INSTALLED = new Set(['@deepseek-ai/cordis-plugin-logger-console'])

/** `@scope/pkg/subpath` → `@scope/pkg`：子路径导出由父包提供，不单独算一个包。 */
function packageName(name: string): string {
  const parts = name.split('/')
  return parts.length >= 2 ? `${parts[0]}/${parts[1] ?? ''}` : name
}

function referencedNames(): string[] {
  const out = new Set<string>()
  for (const file of SOURCES) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    for (const m of text.matchAll(/name: '(@deepseek-ai\/[a-z0-9._/-]+)'/g)) out.add(packageName(m[1] ?? ''))
  }
  return [...out].sort()
}

describe('装配引用的第三方插件名都得有人提供（不然挂载时才炸）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, unknown>
    devDependencies?: Record<string, unknown>
  }
  const ours = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
  const referenced = referencedNames()

  it('确实扫到了名字（别跑成空气）', () => {
    expect(referenced.length).toBeGreaterThanOrEqual(15)
  })

  it('每个名字都在「base 树 / 本仓依赖 / 装进 profile」三者之一里', () => {
    const orphan = referenced.filter((n) => !PROVIDER_PACKAGES.has(n) && !ours.has(n) && !PROFILE_INSTALLED.has(n))
    expect(orphan, `这些包运行时没人提供：${orphan.join(', ')}`).toEqual([])
  })

  it('三条清单本身不与镜像脱节（PROVIDER_PACKAGES 里的名字都真的被引用）', () => {
    // 反向也钉：清单里留着上游已经拿掉的包，等于给自己埋一条"改了基线没人知道"的债。
    const used = new Set(referenced)
    const stale = [...PROVIDER_PACKAGES].filter((n) => !used.has(n)).sort()
    expect(stale, `PROVIDER_PACKAGES 里这些名字装配已不再引用，删掉或确认基线：${stale.join(', ')}`).toEqual([])
  })
})
