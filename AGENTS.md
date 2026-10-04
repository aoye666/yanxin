# AGENTS.md — 研心 (YanXin) agent 操作约定

> 面向 AI agent 的精简指引。完整规格见 `docs/spec.md`（本包**不含** `docs/decisions/`，
> 那些 ADR 编号在这里只是历史线索，结论都已写进 spec）。

## 项目形态

研心是一个 DeepSeek Harness (DSH) bundle：TypeScript 源码在 `src/`，测试在 `tests/`，
三个 agent preset（群聊 / 管理员 / 世界）在 `presets/`，人格源文件在 `persona/`，
部署层模板在 `deploy/`，容器形态在 `Dockerfile` + `docker/`（记忆后端 ReMe 的源树 vendored 在
`third_party/reme/`）。

**它不是一个独立可跑的程序** —— 它靠 `dsh plugin --profile <名字> add ./` 挂进 DSH 运行时
（公开 npm 包 `@deepseek-ai/dsh`，本仓按 `0.1.5-rc.3` 写）。入口是 `lib/`，不是 `src/`。

## 构建与验证

```bash
pnpm run typecheck   # tsc — 类型安全（strict + noUncheckedIndexedAccess）
pnpm run lint        # oxlint — 正确性 = error，可疑 = warn
pnpm run test        # vitest run — 单元 + 集成（71 个 spec 文件，1303 个用例）
pnpm run build       # tsc -p tsconfig.build.json → lib/
```

顺序：**typecheck → lint → test**。typecheck 最快且拦截最多，lint 补充运行时规则，
test 验证行为。build 仅在需要部署产物时运行 —— **但 DSH 加载的就是 `lib/`，改了 `src/` 不 build 等于没改**。

附加：`pnpm run lint:fix` 自动修复；`pnpm run test:watch` 开发模式；
`pnpm run presets` 重新生成三个 preset；`pnpm run deploy -- --self-id <号>` 部署（见 `scripts/install.mjs --help`）。

**提交门控**：pre-commit 钩子（lefthook）跑 typecheck + lint + test 三项，任一失败即拦截提交；
紧急跳过用 `LEFTHOOK=0 git commit`。⚠️ 钩子**不是自动装上的** —— 先跑一次 `pnpm exec lefthook install`。

**两处环境依赖**（在别人机器上会红，不是代码坏了）：
- `tests/integration/shell-tier1.spec.ts` 要 `bash` 在 PATH 上（Windows 需 Git Bash）。
- `tests/unit/patch-semantics.spec.ts` 要一份 DSH monorepo 检出，设 `YANXIN_DSH_MONOREPO=<路径>`；
  没设就整组 skip（这是有意的：它断言的是上游 `applyEntryPatches` 的行为）。

## Preset 生成

三个 preset 的 `agent.cordis.yml` 是**生成产物**——由 `scripts/build-presets.mjs`
从 `persona/*.md` 生成。**不要手改生成的 yml**：有一条测试专门盯 preset 与 persona 漂移。

```bash
# 修改 persona/base.md 或 persona/profile.md 后：
pnpm run presets
```

这会同时更新 `presets/xiaoyan-agent/`、`presets/xiaoyan-admin/`、`presets/xiaoyan-world/`
的 `agent.cordis.yml` 和 `preset.yml`。

⚠️ 人格文本所在的键是 **`prefix`**，不是 `text` —— 发布版 `@deepseek-ai/dsh-persona` 的 Config 是
`{prefix, suffix, complete, includeRuntimeContext}`。写成 `text` 时三个 preset 全部挂在
`$.prefix missing required value` 上，症状是**她人格掉光、不回话**。键名常量的唯一来源是
`src/preset/persona-embed.ts` 的 `PERSONA_TEXT_KEY`（生成器和控制台写入路径共用它）。

`persona/` 出厂是**空模板**：章节结构与说话纪律是通用的，人格内容留空给你写。
判"有没有人写过"看的是**模板里的 TODO 行**（`src/preset/render.ts`），不是文件非空 ——
空模板有一大堆标题和说明，看非空会误判"人格已装好"。

## cordis.patch.yml 分层纪律

`cordis.patch.yml` 是 DSH 装配树的插件行，遵循严格分层（spec §6.2）：

- **只放结构与行级开关**（insert / disable / 覆盖整行 config）
- **没有深度合并**——改一个键也要把整个 config 重写
- **运行时配置走 settings**（LLM 路由、管理员名单等）
- 部署配置（端口、access token、cwd、群号）走 profile 的 `cordis.patch.yml`
  （`$DSH_HOME/profiles/<name>/`，由 `deploy/profile.example.cordis.patch.yml` 渲染，**不入库**）
- ⚠️ 一个例外：**OneBot 的 `host`/`port`/`path`/`token` 在 patch 里只是初值** ——
  settings 的 `yanxin-onebot` 一旦写过值就盖掉 patch 中对应项（控制台 OneBot 连接页改，不用重启）。
  改了不生效先查 settings，别在 patch 上来回改。`accounts`（selfId → preset）**不在**这个例外里 ——
  它决定哪个号的会话挂哪套能力，属于能力构成，仍然只在 patch。

加新工具时的纪律：**在 preset 里声明工具行，不要依赖 host 平面行**。
provider 放 host 平面（进程级单例），工具行由 preset 声明——反了会撞服务名，
而 host 平面的工具行会**泄漏**进每个 agent（spec §7.4-B 与附录 A #16）。

⚠️ **键要挂在对的行上**。`onebot`（传输层）与 `onebot-bridge`（策略层）是两行：
`dryRun` / `contextMessages` / `groupTrigger` / `maxReplyChars` / 分段那几项属于**桥**，
写进 `onebot` 行既不报错也不生效 —— patch 没有深度合并、行 id 对不上也不报，症状是
"配置看着在，实际一路静默落回代码缺省"。机械守卫读两个插件**自己声明的 config schema**
来断言键的行归属（`tests/unit/deploy-profile.spec.ts`），所以加了新键不用去测试里抄名单。

## 关键结论索引（原 ADR 的一句话版）

| 编号 | 主题 | 一句话 |
|-----|------|--------|
| 0001 | Win32 shell 路径 | 不硬编码盘符，DSH 须在 Git Bash 中启动 |
| 0004 | 装配经验 | 配置分层：bundle patch 只管结构，settings 管内容 |
| 0005 | 能力裁剪 & SSRF | preset 裁剪工具，url-guard 守 SSRF，**MCP 会绕过裁剪** |
| 0008 | 三模式 preset | 人格单一来源（persona/*.md），三个 preset 共享基底 |
| 0013 | 工具平面泄漏 | host 平面工具会泄漏到 agent，必须显式 disable + preset 声明 |
| 0014 | 记忆接入 | ReMe 的协议是它自己定的：cwd 决定 `.env` 能否加载、失败藏在 200 里 |
| 0017 | URL 守卫收口 | 守卫只 own 起始 URL；IPv4-in-IPv6 四种封装都得按里面的 v4 判 |
| 0023 | OneBot 传输参数热改 | host/port/path/token 提到 settings；非回环要 token + 确认；换绑失败必须退回原监听 |

完整推导与取证在 `docs/spec.md`（§7.4 安全约束、§6.10 shell、附录 A 被证伪假设）。

## 测试约定

- 测试框架：Vitest，配置在 `vitest.config.ts`
- 测试隔离：`tests/support/isolate-dsh-home.ts`（经 `setupFiles` 全局生效）把 `$DSH_HOME`
  接管到临时目录，防止落盘类代码（url-guard 审计、memory outbox）污染真实 `~/.dsh`
- 隔离靠 `setupFiles` 而不是各 spec 自己 import —— 落盘路径在**模块 import 时**就固化了
- 表驱动用例优先（参考 `tests/unit/url-guard.spec.ts`）
- **不要为了让 CI 变绿而删失败的测试**（spec §9 Never）

三条这轮 newly 学到的纪律，改测试时照着做：

- **等异步链路不要猜宏任务**。入站是 `ctx.emit('onebot/event', …)`，emit 不返回 promise，
  所以"跑完了没有"要问实现自己：桥有 `drainQueues()`（配从 listener 进门就记的 `inFlight`），
  记忆侧有 `pendingRoundsTotal()`（写回是刻意挂在会话队列之外的，沉淀要跑十几秒不该挡下一轮，
  所以两个口径都得等）。假环境的 `settle()` 就是这两个口径的组合 —— 别再往 spec 里塞
  `setTimeout(0)` 循环，也不要给某条用例单独打"轮询到 n 条"的补丁。
- **测试不依赖这份包有没有真内容**。向导那两条线用 `tests/fixtures/package-root`
  （填好的夹具 persona + 三个形状与真产物一致的 preset），而不是仓库自己的 `persona/` ——
  本包的 `persona/` 按设计是空模板，拿它当"装备齐全"就必红。同理：**别把仓名、目录名写死**
  进断言（比对 `process.cwd()` 的最后一段）。
- **真实标识不进仓**。她的 QQ 号、主人的 QQ 号、真实群号一律占位（`3000000001` /
  `2000000001` / `3000000003`），真值只在 `$DSH_HOME`。黑名单在
  `tests/unit/source-hygiene.spec.ts` 末尾，且黑名单本身**拆成两段存** —— 那个文件也在扫描
  范围内，写成整串就是亲手把真值请回仓库（`no-useless-concat` 会劝你合并，别听它的）。

## 目录速查

```
src/          源码（net/ onebot/ world/ memory/ console/ setup/ admin/ audit/ window/ preset/）
tests/        unit/ integration/ support/ fixtures/（package-root 是向导测试的夹具包根）
presets/      三个 agent preset（生成产物 —— 改 persona 后要 pnpm run presets）
persona/      人格源文件（base.md / profile.md / world.md）—— 出厂是空模板
deploy/       profile.example（本机）与 profile.docker（容器）两份部署层模板
docker/       entrypoint.mjs：一个容器里两个进程的装配与首启落盘
third_party/  reme —— vendored 的 ReMe 源树（Apache-2.0；改动说明在 UPSTREAM.md）
docs/         spec.md（单一事实源）、development-notes.md（开发注意事项）
scripts/      install.mjs（部署）、build-presets.mjs（生成 preset）
.github/      workflows/image.yml —— 镜像构建 + 起容器冒烟（记忆线、远程可达、shell 边界）
Dockerfile    单镜像形态
cordis.patch.yml   DSH 装配 patch（结构 + 行级开关）
```
