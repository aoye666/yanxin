#!/usr/bin/env node
/**
 * 研心镜像的入口 —— 一个容器里的两个进程（ReMe + dsh），加两件首启的落盘动作。
 *
 * 它做四件事，顺序是硬的：
 *   1. 读环境变量（缺关键值就**说清缺哪个**后退出 —— 容器里没有第二次机会问人）
 *   2. 首启写 `$DSH_HOME/.credentials.yaml`（扁平格式，0600，**在位就不覆盖**）
 *   3. 渲染 profile patch；**起 ReMe 并等它健康**，健康了才把 `provider` 写成 `reme`
 *   4. 确认 profile 里链着本仓（种子在镜像里，这里只兜底），起 dsh，
 *      并把 SIGTERM/SIGINT 转发给 ReMe（任一进程退出，容器就退出 —— 不留半个）
 *
 * ## 三条不成文的规矩
 *
 *   · **不提问**：所有值来自环境变量。Docker 的 stdout 不是 tty，问了三句也答不了。
 *   · **密钥只进 `.credentials.yaml`，永不进 YAML**：`dsh --dump-config` 会明文打印 patch
 *     （spec §7.4-D）。OneBot 的 access token 例外 —— 它是协议层的共享口令，
 *     本来就要发给对端；所以它只能从环境变量来，绝不写进这份文件。
 *   · **ReMe 起不来不算致命**：留 `provider: none` 照样起 dsh，她照常说话、召回为空。
 *     这是把"记忆是增强不是依赖"这条设计兑现到启动路径上，不是兜底装饰。
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLoopbackAddress, normalizePath } from '../src/console/logic.ts'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = join(PACKAGE_ROOT, 'deploy', 'profile.docker.cordis.patch.yml')

const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '/home/node', '.dsh')
const remeWorkspace = process.env.YANXIN_REME_WORKSPACE ?? '/data/reme'
const remePort = Number(process.env.YANXIN_REME_PORT ?? '2333')
const webPort = Number(process.env.YANXIN_WEB_PORT ?? '3080')
const onebotPort = Number(process.env.YANXIN_ONEBOT_PORT ?? '8080')
const onebotPath = normalizePath(process.env.YANXIN_ONEBOT_PATH ?? '/onebot/v11')
const selfId = (process.env.YANXIN_SELF_ID ?? '').trim()
const onebotToken = (process.env.YANXIN_ONEBOT_TOKEN ?? '').trim()
const consoleToken = (process.env.YANXIN_CONSOLE_TOKEN ?? '').trim()
const llm = {
  key: (process.env.LLM_API_KEY ?? '').trim(),
  baseUrl: (process.env.LLM_BASE_URL ?? '').trim(),
  model: (process.env.LLM_MODEL_NAME ?? '').trim(),
}

// ── 1. 缺什么就说出来 ───────────────────────────────────────────────────────
const missing = []
if (llm.key === '') missing.push('LLM_API_KEY')
if (llm.baseUrl === '') missing.push('LLM_BASE_URL')
if (llm.model === '') missing.push('LLM_MODEL_NAME（必须是那条网关上真实存在的模型 id：写错时 auto_memory 回 404，而 HTTP 状态仍是 200）')
if (missing.length > 0) {
  console.error(`❌ 起不来：缺 ${missing.join(' / ')}。`)
  console.error('   docker run -e LLM_API_KEY=… -e LLM_BASE_URL=… -e LLM_MODEL_NAME=… yanxin')
  process.exit(1)
}

// 绑地址：控制台与 OneBot 都要能被容器外访问，所以默认 0.0.0.0。
// ⚠️ 认不出的一律按对外处理（fail-closed）—— 与 `src/onebot/transport.ts` 的
//    `isPublicBindHost` 同一套想法：写错地址的人不该被静默当成"只在本机"。
const webHost = pickHost(process.env.YANXIN_WEB_HOST, '0.0.0.0')
const onebotHost = pickHost(process.env.YANXIN_ONEBOT_HOST, '0.0.0.0')

if (!isLoopbackish(onebotHost) && onebotToken === '') {
  console.error(`❌ OneBot 监听在 ${onebotHost}，但 YANXIN_ONEBOT_TOKEN 是空的。`)
  console.error('   那条端口上没有别的东西在守：token 一空，任何能连上它的人都能冒充她的客户端')
  console.error('   （推假事件、拿到回发目标），而 URL 守卫管不到那条路。')
  console.error('   要么给 token：-e YANXIN_ONEBOT_TOKEN=<串>；要么只绑回环：-e YANXIN_ONEBOT_HOST=127.0.0.1')
  process.exit(1)
}

// 没给 token 就生成一个并**只打印一次**（与 scripts/install.mjs 同一个做法）：
// 它不在镜像里、不在 YAML 里，只在容器的日志里出现一行。
const tokenWasGenerated = onebotToken === ''
const effectiveOnebotToken = tokenWasGenerated ? randomToken() : onebotToken

// ── 2. 凭据文件（首启写，之后不动）──────────────────────────────────────────
mkdirSync(dshHome, { recursive: true })
const credentialsFile = join(dshHome, '.credentials.yaml')
if (existsSync(credentialsFile)) {
  note(`${credentialsFile} 已存在 —— 保留你那份（要换 key 就改这个文件，或删掉它重启）`)
} else {
  writeFileSync(
    credentialsFile,
    `LLM_API_KEY: ${llm.key}\nLLM_BASE_URL: ${llm.baseUrl}\nLLM_MODEL_NAME: ${llm.model}\n`,
    'utf8',
  )
  chmodSync(credentialsFile, 0o600)
  console.log(`✔ 已写 ${credentialsFile}（扁平格式、0600；键名就是环境变量名）`)
}

// ── 3. ReMe 先起来（记忆后端）───────────────────────────────────────────────
const reme = startReMe()
const memoryReady = reme !== undefined ? await waitHealthy(reme) : false
if (!memoryReady) {
  note(
    '记忆后端没能就绪 —— 以 provider=none 启动：她照常说话，只是召回为空。' +
      '（等 25s 没看到健康；日志见 ReMe 的输出，或删掉 volume 重来）',
  )
}

// ── 4. 渲染 profile patch ───────────────────────────────────────────────────
const profileDir = join(dshHome, 'profiles', 'yanxin')
mkdirSync(profileDir, { recursive: true })
const profilePatch = join(profileDir, 'cordis.patch.yml')
const values = {
  '{{WEB_HOST}}': webHost,
  '{{WEB_PORT}}': String(webPort),
  '{{ONEBOT_HOST}}': onebotHost,
  '{{ONEBOT_PORT}}': String(onebotPort),
  '{{ONEBOT_PATH}}': esc(onebotPath),
  // 模板里这一行渲染成空 = 不覆盖 onebot 那一整段 config（profile 层没写就是缺省）；
  // 我们**总是**给一个值，所以这里永不为空。
  '{{ONEBOT_TOKEN}}': esc(effectiveOnebotToken),
  // 绑号那两行整段生成。**没绑号就一个字都不写 selfId**：留一条 `selfId` 为空的
  // accounts 条目会被 cordis 的 schema 判成 `$.accounts[0].selfId missing required value`，
  // 那不是"她听不到"，是整个 profile 挂载失败 —— 而首启恰恰还没绑号
  // （2026-10-04 真机验收第一次跑容器就是死在这上面）。
  // ⚠️ selfId 与 token 都得**带引号**：QQ 号与手打的 token 天生纯数字，裸插进 YAML 会被
  //    读成 number，而 schema 要 string → `$.token expected string but got 123456`，
  //    整个 profile 装不起来、容器 exit 1（2026-10-04 服务器上第一次公网部署就撞在这）。
  '{{IDENTITY_LINES}}':
    selfId === ''
      ? '    # 还没绑号（绑号在控制台的初始化向导里做）：不写 selfId，accounts 留空表\n    accounts: []'
      : `    selfId: "${esc(selfId)}"\n    # 注册表：这个 QQ 号的会话挂哪套能力\n    accounts:\n      - selfId: "${esc(selfId)}"\n        preset: xiaoyan-agent`,
  '{{WORKSPACE}}': esc(join(dshHome, 'yanxin', 'workspace').replace(/\\/g, '/')),
  '{{MEMORY_PROVIDER}}': memoryReady ? 'reme' : 'none',
  // 世界群号：**不是世界线的开关** —— 留空也落到 '0'，而 0 只是个不存在的群，
  // 引擎一被装载，她的每句主动发言都会在发射通道上失败并记 failed（不重试）。
  // 管装载与否的是窗口时段（bundle 里 `yanxin-world-engine` 行缺省 disabled: true）
  // + 控制台世界页那个暂停开关（写 `yanxin-window.paused`）。
  '{{WORLD_GROUP_ID}}': esc((process.env.YANXIN_WORLD_GROUP_ID ?? '0').trim() || '0'),
}
writeFileSync(profilePatch, render(readFileSync(TEMPLATE, 'utf8'), values), 'utf8')
console.log(`✔ profile patch：${profilePatch}（memory=${values['{{MEMORY_PROVIDER}}']}，web=${webHost}:${webPort}，onebot=${onebotHost}:${onebotPort}）`)

mkdirSync(join(dshHome, 'yanxin', 'workspace'), { recursive: true })

// 控制台放宽远程访问 —— 这是**安全边界的放宽**，控制台自己在启动时会打 WARN 说明这件事，
// 这里再补一句"唯一凭据是 token"，因为容器里没人看代码。
if (!isLoopbackish(webHost)) {
  process.env.YANXIN_CONSOLE_ALLOW_REMOTE = '1'
  console.log(
    consoleToken === ''
      ? '⚠️ 控制台对远程可达，但 YANXIN_CONSOLE_TOKEN 没配 —— 所有写操作与实时日志流一律被拒（fail-closed，聊天不受影响）'
      : `⚠️ 控制台对远程可达，写操作与日志流只认 YANXIN_CONSOLE_TOKEN —— http://<这台机>:${webPort}/yanxin/`,
  )
}

if (tokenWasGenerated) {
  console.log(`OneBot access token：${effectiveOnebotToken}`)
  console.log('  （随机生成的，只打印这一次。NapCat / SnowLuma 的「鉴权 Token」填同一个值）')
}
if (selfId === '') {
  note('没给 YANXIN_SELF_ID —— accounts[] 是空的，任何连接都会被注册表拒掉。绑号请在控制台的初始化向导里做')
}

// ── 5. 保证 profile 里链着本仓，然后起 dsh ──────────────────────────────────
// 正常路径下这一步**什么都不做**：profile 是构建期就烘进镜像的（Dockerfile 里
// "把 profile 烘进镜像"那一段），命名卷首启会带上它。
// 只有把 `$DSH_HOME` bind 成一个空目录时才拿不到种子 —— 那种情形现场补链一次，
// 代价是要有 pnpm（runtime 阶段装了）+ 可达的 npm 源。
const profilePkg = join(dshHome, 'profiles', 'yanxin', 'package.json')
const linked = existsSync(profilePkg) && /"yanxin"\s*:\s*"link:/.test(readFileSync(profilePkg, 'utf8'))
if (linked) {
  console.log('✔ profile 已带本仓（镜像里的种子），不必补链')
} else {
  const link = spawnSync('dsh', ['plugin', '--profile', 'yanxin', 'add', PACKAGE_ROOT], { encoding: 'utf8' })
  if (link.status !== 0) {
    // 这里**不退让**。链不上本仓时，插件树会缺 `shell` 服务，dsh 以 exit 1 收场，
    // 而症状是一句和真实原因毫无关系的 "entries did not activate"
    // —— 2026-10-04 第一次真跑容器就是这样，排查全被那句误导。宁可在这里说清。
    console.error(`❌ profile 里没有本仓，补链也失败了（exit ${link.status}）：`)
    console.error(String(link.stderr ?? link.stdout ?? '').trim().slice(0, 400))
    console.error('   两个成因：镜像里没有 pnpm（`dsh plugin add` 内部调它），或这台机到 npm 源不通。')
    reme?.kill('SIGTERM')
    process.exit(1)
  }
  console.log(`✔ 已把本仓链进 profile：${PACKAGE_ROOT}`)
}

const dsh = spawn('dsh', ['--profile', 'yanxin'], { stdio: 'inherit' })
console.log('▶ dsh --profile yanxin')

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`← ${signal}：把信号转给 ReMe，等 dsh 自己收尾（记忆写回的缓冲会在这一步 flush）`)
    reme?.kill(signal)
  })
}

dsh.on('exit', (code, signal) => {
  reme?.kill('SIGTERM')
  process.exit(signal ? 0 : (code ?? 1))
})
dsh.on('error', (error) => {
  console.error(`❌ 起不了 dsh：${error.message}`)
  console.error('   镜像里应该有它：npm i -g @deepseek-ai/dsh@0.1.5-rc.3（Dockerfile 的 runtime 阶段）')
  reme?.kill('SIGTERM')
  process.exit(1)
})

// ── 小件 ────────────────────────────────────────────────────────────────────

/** 起 ReMe（同容器、只绑回环）。它的 HTTP 没有鉴权，所以这一步绝不能听对外地址。 */
function startReMe() {
  const endpoint = `http://127.0.0.1:${remePort}`
  mkdirSync(remeWorkspace, { recursive: true })
  console.log(`▶ ReMe：workspace=${remeWorkspace} endpoint=${endpoint}`)
  // ⚠️ cwd 必须是 workspace 本身：ReMe 自己的 `load_env()` 从**当前工作目录**及最多 5 层
  //    父目录找 `.env`（`reme start` 不读它，读的是进程环境变量 —— 我们已经传了）。
  //    但它的 workspace 解析与日志目录都跟着 cwd 走，这里保持同一个是本机踩过坑的做法（ADR 0014）。
  const child = spawn(
    'reme',
    ['start', `workspace_dir=${remeWorkspace}`, `service.host=127.0.0.1`, `service.port=${remePort}`],
    { cwd: remeWorkspace, env: { ...process.env, REME_WORKSPACE_DIR: remeWorkspace, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'inherit', 'inherit'] },
  )
  child.on('error', (error) => {
    console.error(`⚠️ ReMe 起不来（${error.message}）—— 记忆线降级为空召回`)
  })
  return child
}

/**
 * 等 ReMe 健康。
 *
 * ⚠️ 判据是 **POST** `/health_check`：它是 job，GET 会 405（本机实测）。
 * 而"HTTP 200"本身也不足以说明它在工作 —— ReMe 会把内部异常吞进自己的日志、
 * 状态码照样 200（ADR 0014 决策六）。这里能做的只有在启动阶段确认它**在听**，
 * 真正的"记忆有没有沉下去"要看 `/yanxin/memory` 页的检索结果。
 */
async function waitHealthy(child) {
  const url = `http://127.0.0.1:${remePort}/health_check`
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false
    try {
      const res = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      // 还没起来 / 正在绑定：下一拍再问
    }
    await sleep(700)
  }
  return false
}

/** 绑地址：没给就用默认（对外），给了就照给的值走（判回环由 `isLoopbackish` 负责）。 */
function pickHost(value, fallback) {
  const raw = (value ?? '').trim()
  return raw === '' ? fallback : raw
}

/**
 * 这个绑地址是不是**回环**。
 *
 * 只认 `127.*` / `::1` / `localhost`；`0.0.0.0`、`::`、网卡地址、以及任何认不出形态的写法
 * 一律按**对外**处理（fail-closed）。私网地址不算回环 —— 容器里的 `172.17.0.1` 恰恰是
 * 宿主机连进来的那个地址，把它当"本机"就等于把 token 要求跳过去了。
 */
function isLoopbackish(host) {
  const value = host.trim().toLowerCase()
  if (value === 'localhost' || value === '::1') return true
  return isLoopbackAddress(value)
}

/**
 * 双引号 YAML 标量的**内部**转义 —— 模板已经把占位符包在引号里（`token: "{{…}}"`），
 * 这里只处理值本身含有的反斜杠与双引号。裸插值会被 YAML 按类型读：纯数字变成 number，
 * 而我们的 schema 要 string，症状是整个 profile 挂载失败而不是"这一项没生效"。
 */
function esc(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function render(text, table) {
  let out = text
  for (const [token, value] of Object.entries(table)) out = out.split(token).join(value)
  const left = out.match(/\{\{[A-Z_]+\}\}/g)
  if (left !== null) throw new Error(`模板里有渲染器不认识的值：${[...new Set(left)].join(' ')} —— 两份清单必须一起改`)
  return out
}

function randomToken() {
  // 可读字符子集：运维要能把它抄进客户端输入框，不含 `/?%+` 这类会被 URL 或 shell 吃掉的字符
  return randomBytes(24).toString('base64url').replace(/[+/]/g, '-')
}

function note(message) {
  console.log(`⚠️  ${message}`)
}

async function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
