/**
 * 镜像里跑的是 **Node 的"擦类型"模式**，不是转译：patch 的插件行写的是
 * `yanxin/src/…ts`，运行时由 Node 直接吃掉类型（`Dockerfile` 的口径，Node ≥ 22.18）。
 *
 * 擦类型只允许**可擦除**的语法。这几样会**直接抛**
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 让整棵插件树装不起来：
 *   · 构造函数参数属性 `constructor(private readonly x: T)`  ← 2026-10-04 就是它把容器打死的
 *   · `enum` / `namespace`（要生成代码）
 *   · 装饰器
 *   · `import x = require()`
 *
 * ⚠️ 本机**永远看不见这个坑**：开发是 `node --import tsx/esm …`，tsx 做完整转译，
 *    上面全都跑得动。所以这条断言是"镜像能不能起"的第一道门，不是风格洁癖。
 *    要放开某条形态，先确认 Node 的 strip-only 模式真的支持它，并在 `Dockerfile` 一起说清。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', '..', 'src')

/** 递归收 src 下所有 .ts（排除 .d.ts 与测试文件）。 */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** 去掉注释行，避免 JSDoc 里的 `@param` / 中文说明误报。 */
function codeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
}

const FILES = tsFiles(SRC)

const FORBIDDEN: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'enum（要生成运行时代码）', re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+[\w$]/ },
  { label: 'namespace（要生成运行时代码）', re: /^\s*(?:export\s+)?(?:declare\s+)?namespace\s+[\w$]/ },
  {
    // ⚠️ 排除 CSS 的 at-rule：`src/console/client.ts` 里有内嵌样式串
    //    （`@media` / `@keyframes` 出现在字符串里，不是装饰器）。
    label: '装饰器',
    re: /^\s*@(?!media\b|keyframes\b|supports\b|layer\b|import\b|charset\b|page\b|font-face\b|container\b|property\b|scope\b|viewport\b)[A-Za-z_$][\w$]*/,
  },
  { label: 'import = require（TS 专属语法）', re: /^\s*import\s+[\w$]+\s*=\s*require\(/ },
]

/**
 * 构造函数参数属性。**必须整段抓签名**来看：签名常常跨行写，
 * 逐行正则看不见 —— 2026-10-04 第一版守卫就是这么漏掉 7 处，容器照样起不来。
 */
function parameterProperties(text: string): string[] {
  const hits: string[] = []
  for (const m of text.matchAll(/constructor\s*\(([^)]*)\)/gs)) {
    const params = m[1] ?? ''
    if (/\b(?:public|private|protected|readonly)\s+[\w$]+\s*[?!:]/.test(params)) {
      hits.push(params.replace(/\s+/g, ' ').trim().slice(0, 100))
    }
  }
  return hits
}

describe('src 必须是 Node 擦类型模式能直接跑的语法（镜像的硬要求）', () => {
  it('确实扫到了文件（别把这条断言跑成空气）', () => {
    expect(FILES.length).toBeGreaterThan(20)
  })

  it('构造函数参数属性（改成显式字段 + 构造函数里赋值）', () => {
    const hits: string[] = []
    for (const file of FILES) {
      for (const params of parameterProperties(readFileSync(file, 'utf8'))) {
        hits.push(`${relative(SRC, file)}: constructor(${params})`)
      }
    }
    expect(hits, `这些签名在镜像里会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX：\n${hits.join('\n')}`).toEqual([])
  })

  for (const { label, re } of FORBIDDEN) {
    it(label, () => {
      const hits: string[] = []
      for (const file of FILES) {
        for (const line of codeLines(readFileSync(file, 'utf8'))) {
          if (re.test(line)) hits.push(`${relative(SRC, file)}: ${line.trim().slice(0, 90)}`)
        }
      }
      expect(hits, `这些行在镜像里会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX：\n${hits.join('\n')}`).toEqual([])
    })
  }
})
