# AGENTS.md — 研心 (YanXin) agent 操作约定

> 面向 AI agent 的精简指引。完整规格见 `docs/spec.md`（本包**不含** `docs/decisions/`，
> 那些 ADR 编号在这里只是历史线索，结论都已写进 spec）。

## 项目形态

研心是一个 DeepSeek Harness (DSH) bundle：TypeScript 源码在 `src/`，测试在 `tests/`，
三个 agent preset（群聊 / 管理员 / 世界）在 `presets/`，人格源文件在 `persona/`，
部署层模板在 `deploy/`。

**它不是一个独立可跑的程序** —— 它靠 `dsh plugin --profile <名字> add ./` 挂进 DSH 运行时
（公开 npm 包 `@deepseek-ai/dsh`，本仓按 `0.1.5-rc.3` 写）。入口是 `lib/`，不是 `src/`。

## 构建与验证

```bash
pnpm run typecheck   # tsc — 类型安全（strict + noUncheckedIndexedAccess）
pnpm run lint        # oxlint — 正确性 = error，可疑 = warn
pnpm run test        # vitest run — 单元 + 集成（59 个 spec 文件）
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

`persona/` 出厂是**空模板**：章节结构与说话纪律是通用的，人格内容留空给你写。

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

完整推导与取证在 `docs/spec.md`（§7.4 安全约束、§6.10 shell、附录 A 被证伪假设）。

## 测试约定

- 测试框架：Vitest，配置在 `vitest.config.ts`
- 测试隔离：`tests/support/isolate-dsh-home.ts`（经 `setupFiles` 全局生效）把 `$DSH_HOME`
  接管到临时目录，防止落盘类代码（url-guard 审计、memory outbox）污染真实 `~/.dsh`
- 隔离靠 `setupFiles` 而不是各 spec 自己 import —— 落盘路径在**模块 import 时**就固化了
- 表驱动用例优先（参考 `tests/unit/url-guard.spec.ts`）
- **不要为了让 CI 变绿而删失败的测试**（spec §9 Never）

## 目录速查

```
src/          源码（net/ onebot/ admin/ memory/ world/ console/ setup/ audit/ window/）
tests/unit/   单元测试        tests/integration/   集成测试
presets/      三个 agent preset（生成产物）
persona/      人格源文件（base.md / profile.md / world.md）—— 出厂是空模板
deploy/       profile.example.cordis.patch.yml（部署层模板）
docs/         spec.md（单一事实源）、development-notes.md（开发注意事项与未修清单）
scripts/      install.mjs（部署）、build-presets.mjs（生成 preset）
cordis.patch.yml   DSH 装配 patch（结构 + 行级开关）
```
