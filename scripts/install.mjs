#!/usr/bin/env node
/**
 * 研心的部署脚本 —— 把"从零到能说话"收成一条命令。
 *
 * 四件事，每件都幂等，可以反复重跑：
 *   1. 检查环境（node / pnpm / `dsh` CLI / bash 在不在 PATH 上 / lib 是否已构建）
 *   2. `dsh plugin --profile <名字> add <本仓>` —— 建 profile 并把 bundle link 进去
 *   3. 写 `$DSH_HOME/profiles/<名字>/cordis.patch.yml`（由 `deploy/profile.example.cordis.patch.yml` 生成）
 *   4. 建 `$DSH_HOME/yanxin/workspace`
 *
 * 三条纪律：
 *   · **不提问**：值全部来自开关或环境变量。缺了就报"该加哪个开关"后退出，不卡在 stdin 上。
 *   · **不覆盖你已有的部署配置**：存在就停（`--force` 也先备份成 `.bak-<时间戳>`）。
 *   · **不碰你的密钥**：OneBot token 缺省时随机生成、只打印一次；LLM key 由 DSH 自己从
 *     `.credentials.yaml` 读，本脚本不写那个文件，也不做全局安装。
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 本仓的装配是按这一版 DSH 写的；换版要先重核 spec（ADR 0002 的版本策略）。 */
const DSH_VERSION = '0.1.5-rc.3'
const argv = process.argv.slice(2)

const HELP = `用法：node scripts/install.mjs --self-id <QQ号> [其它开关]

必给
  --self-id <QQ>     小研的 QQ 号（OneBot accounts[].selfId）；也可用环境变量 YANXIN_SELF_ID
默认值可覆盖
  --profile <名字>   DSH profile 名（默认 yanxin）
  --port <n>         OneBot 反向 WS 监听端口（默认 8080，只绑回环）
  --web-port <n>     控制台与 webServer 端口（默认 3080）
  --group-id <QQ>    她的世界群号（默认 0 = 先不启用世界线；装完可在控制台世界页改）
  --provider <id>    世界模型走的那条 LLM 路由 id（默认 example-llm，改成你 settings 里真实存在的）
  --model <id>       上面那条路由的模型 id（默认 example-model）
  --token <串>       OneBot access token（缺省时随机生成并打印一次）
行为
  --force            已存在的 profile patch 先备份再重写
  --dry-run          只打印将要做什么，不写文件、不调 dsh
`

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}

/** 开关优先，其次环境变量，最后默认值。 */
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return String(argv[i + 1])
  const env = process.env[`YANXIN_${name.toUpperCase().replace(/-/g, '_')}`]
  if (env !== undefined && env !== '') return env
  return argv.includes(`--${name}`) ? true : fallback
}
const dryRun = argv.includes('--dry-run')

const config = {
  profile: String(opt('profile', 'yanxin')),
  port: String(opt('port', '8080')),
  webPort: String(opt('web-port', '3080')),
  path: '/onebot/v11',
  selfId: String(opt('self-id', '') ?? ''),
  groupId: String(opt('group-id', '0')),
  provider: String(opt('provider', 'example-llm')),
  model: String(opt('model', 'example-model')),
  token: String(opt('token', '') ?? ''),
}
config.tokenWasGenerated = config.token === ''
if (config.tokenWasGenerated) config.token = randomToken()

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const workspace = join(dshHome, 'yanxin', 'workspace')
const profilePatch = join(dshHome, 'profiles', config.profile, 'cordis.patch.yml')
config.workspace = workspace.replace(/\\/g, '/')

// ── 1. 环境 ────────────────────────────────────────────────────────────────
const blockers = []
if (config.selfId === '') blockers.push('缺 selfId：加 --self-id <她的 QQ 号>（onebot.accounts[] 空着的话任何连接都会被注册表拒掉）')
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 22) blockers.push(`Node 需要 ≥22.19（或 ≥24），现在是 ${process.versions.node}`)
if (!existsSync(join(PACKAGE_ROOT, 'lib', 'index.js'))) blockers.push('lib/ 还没构建 —— DSH 加载的是 lib/，先跑 pnpm build')
if (!existsSync(join(PACKAGE_ROOT, 'deploy', 'profile.example.cordis.patch.yml'))) blockers.push('找不到 deploy/profile.example.cordis.patch.yml（打包漏了？）')
if (run('dsh', ['--version']) === null) {
  blockers.push(`没找到 dsh CLI —— 它是公开 npm 包：pnpm add -g @deepseek-ai/dsh@${DSH_VERSION}（或 npm i -g）`)
}
const bashOk = run('bash', ['--version']) !== null
if (!bashOk) note('PATH 上没有 bash：管理员私聊的 shell 会不可用。Windows 需要 Git Bash，且 DSH 要在 Git Bash 里启动（ADR 0001）')

if (blockers.length > 0) {
  console.error('❌ 还不能部署：')
  for (const line of blockers) console.error(`   · ${line}`)
  process.exit(1)
}

console.log(`✔ 环境 OK（node ${process.versions.node}，dsh ${run('dsh', ['--version'])}，bash ${bashOk ? '在 PATH 上' : '不在'}`)
console.log(`  profile ${config.profile} ｜ $DSH_HOME ${dshHome}`)

// ── 2. profile + bundle link ───────────────────────────────────────────────
console.log('\n── 建 profile 并把本仓 link 进去 ──')
step(`dsh plugin --profile ${config.profile} add ${PACKAGE_ROOT}`, () => {
  const out = spawnSync('dsh', ['plugin', '--profile', config.profile, 'add', PACKAGE_ROOT], { shell: true, stdio: 'inherit' })
  if (out.status !== 0) fail(`dsh plugin add 失败。常见原因：DSH 版本对不上（本仓按 ${DSH_VERSION} 写的）、profile 名冲突`)
})

// ── 2b. 装上 base 没带的那个 provider ──────────────────────────────────────
// `logger-console` 不在发布版 `dsh-base` 的依赖树里（base 只带 `session-log-deepseek`），
// 而 `cordis.patch.yml` 的 logger-console 行要用它。它的 import 上下文是 **profile 目录**
// （解析失败时的原文是 `imported from $DSH_HOME/profiles/<名字>/`），所以塞进本仓的
// node_modules 不算解决 —— 必须装进 profile。少了它的表现不是"日志少一行"，
// 是挂载时报 ERR_MODULE_NOT_FOUND、整个 profile 起不来。
// 版本钉 **1.0.2**：peer 对得上本基线（cordis ^4.0.2 / schemastery ^3.18.2）的最后一版；
// 1.0.3 要 ^4.0.3、1.0.4 要 ~4.0.4，装了就又是"两份 cordis 实例"那个坑（见 .npmrc 的记录）。
const LOGGER_PLUGIN = '@deepseek-ai/cordis-plugin-logger-console@1.0.2'
console.log('\n── 装上 base 没带的 provider ──')
step(`dsh plugin --profile ${config.profile} add ${LOGGER_PLUGIN}`, () => {
  const out = spawnSync('dsh', ['plugin', '--profile', config.profile, 'add', LOGGER_PLUGIN], { shell: true, stdio: 'inherit' })
  if (out.status !== 0) fail(`装 ${LOGGER_PLUGIN} 失败 —— 没有它，patch 里的 logger-console 行会在挂载时解析不到`)
})

// ── 3. 工作目录 ────────────────────────────────────────────────────────────
console.log('\n── 工作目录 ──')
step(`mkdir ${workspace}`, () => {
  mkdirSync(workspace, { recursive: true })
  console.log(`✔ ${workspace}`)
})

// ── 4. 部署配置 ────────────────────────────────────────────────────────────
console.log('\n── 部署配置（profile patch）──')
if (existsSync(profilePatch) && !argv.includes('--force')) {
  note(`已存在 ${profilePatch} —— 不覆盖。要重写加 --force（会先备份）`)
} else {
  const rendered = render(readFileSync(join(PACKAGE_ROOT, 'deploy', 'profile.example.cordis.patch.yml'), 'utf8'), config)
  step(`写 ${profilePatch}`, () => {
    if (existsSync(profilePatch)) {
      const backup = `${profilePatch}.bak-${Date.now()}`
      renameSync(profilePatch, backup)
      console.log(`  旧的备份到 ${backup}`)
    }
    mkdirSync(dirname(profilePatch), { recursive: true })
    writeFileSync(profilePatch, rendered, 'utf8')
    console.log(`✔ ${profilePatch}`)
  })
  console.log(`  OneBot token：${config.token}`)
  if (config.tokenWasGenerated) console.log('  （随机生成的，只打印这一次。NapCat/SnowLuma 的「鉴权 Token」填同一个值）')
}

// ── 5. 剩下的（脚本不代做，因为要碰密钥）──────────────────────────────────
console.log(`
──────── 还差三件事 ────────

1) LLM 密钥 →  ${join(dshHome, '.credentials.yaml')}
   扁平格式、键名就是环境变量名，例如：
       <ROUTER>_API_KEY: <你的 key>
   ⚠️ 不要把 key 内联进任何 YAML（含 URL 查询参数）—— dsh --dump-config 会明文打印它（spec §7.4-D）。

2) 控制台凭据（写操作与实时日志流都要）：
       export YANXIN_CONSOLE_TOKEN='<你自己设一个串>'
   没配 = 一律 403 拒写拒流（fail-closed），聊天不受影响。

3) 启动并打开向导：
       dsh --profile ${config.profile}
       http://127.0.0.1:${config.webPort}/yanxin/setup
   四步：人格 → 背景 → 创世 → 绑号。
   QQ 那侧（NapCat / SnowLuma）反向 WS 填：ws://127.0.0.1:${config.port}${config.path}

想先验证装配对不对：dsh --profile ${config.profile} --dump-config（记得别把输出贴到公开地方）
`)

/**
 * 模板里的 `{{占位}}` 换成值；渲染完还剩占位就报错，不写半份配置出去。
 *
 * ⚠️ 两个坑都在这函数里，别改回去：
 *   · 值一律过 `esc` —— 模板把字符串占位符包在 `" "` 里，而裸插的纯数字值
 *     （她的 QQ 号、手打的 token）会被 YAML 读成 number，schema 要 string，
 *     症状是**整个 profile 挂载失败**而不是"这一项没生效"。
 *   · 替换用**函数**而不是字符串 —— `String.replaceAll` 会把替换串里的 `$&` / `$1`
 *     当特殊序列展开，token 里带一个 `$` 就能把占位符本身插进值里。
 */
function render(text, a) {
  const fill = (token, value) => text.replaceAll(token, () => esc(value))
  let out = text
  out = fill('{{SELF_ID}}', a.selfId)
  out = out.replaceAll('{{ONEBOT_PORT}}', a.port)
  out = fill('{{ONEBOT_PATH}}', a.path)
  out = fill('{{ONEBOT_TOKEN}}', a.token)
  out = out.replaceAll('{{WEB_PORT}}', a.webPort)
  out = fill('{{WORKSPACE}}', a.workspace)
  out = fill('{{WORLD_GROUP_ID}}', a.groupId)
  out = fill('{{WORLD_PROVIDER}}', a.provider)
  out = fill('{{WORLD_MODEL}}', a.model)
  const left = out.match(/\{\{[A-Z_]+\}\}/g)
  if (left !== null) fail(`这些值没填上：${[...new Set(left)].join(' ')} —— 用对应开关重跑`)
  return out
}

/** 双引号 YAML 标量的内部转义（模板已经把占位符包在引号里）。 */
function esc(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function randomToken() {
  // 可读字符子集：运维要能把它抄进客户端输入框，不含 `/?%+` 这类会被 URL 或 shell 吃掉的字符
  return randomBytes(24)
    .toString('base64url')
    .replace(/[+/]/g, '-')
}
function run(cmd, args) {
  const out = spawnSync(cmd, args, { shell: true, encoding: 'utf8' })
  return out.status === 0 ? String(out.stdout ?? '').trim() : null
}
function step(label, fn) {
  if (dryRun) {
    console.log(`（dry-run）${label}`)
    return
  }
  fn()
}
function note(message) {
  console.log(`⚠️  ${message}`)
}
function fail(message) {
  console.error(`\n❌ ${message}`)
  process.exit(1)
}
