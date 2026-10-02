# Spec: 研心 (YanXin) — 小研的双模式 Harness

> Bot 名：**小研**　|　Harness 名：**研心 / YanXin**
> 形态：**一个 DeepSeek Harness 的 profile + bundle**
> 状态：**beta**（聊天线与世界线都上线过；控制台八页；见 §10 与文末检查表）

## 读这份文档前（公开包说明）

- 本文由开发副本同步而来，**保留了作者的决策过程与未闭环事项**。文中出现的
  `ADR 00xx`（`docs/decisions/`）与 `T12` 这类任务号（`tasks/`）**在本包里指不到文件** ——
  那两处不在公开范围内，它们的结论都已经写进本文（尤其附录 A「被证伪的初始假设」）。
- 示例值都是**占位**：QQ 号 `1000000001` / `2000000002` / `3000000003`、
  路由 `example-llm` / `example-model`、网关 `api.example.com`。真实值属于部署层，
  在本仓之外（`$DSH_HOME/profiles/<名字>/cordis.patch.yml`，见 §5.2）。
- `persona/` 出厂是**空模板**（结构与纪律齐、人格内容留空），所以 §6.4 与附录里引用的
  那些人格原话在本文档里也可能已不存在——它们属于使用者自己要写的那部分。
- §11 的 **R1–R8** 是作者在 2026-10-02 复核时留下的未闭环项，其中几条（轮换 key、
  本机 `cwd` 验证）是**运维事项**而非代码缺陷；不影响部署，影响的是"这条 spec 不能自称全部验收"。

---

## 1. Objective

在 **DeepSeek Harness (DSH)** 上做一个 bot harness：**一个实例、两套运行模式、同一人格基底、共享长期记忆、双 QQ 账号物理隔离、带 Web 控制台与初始化向导。**

### 用户故事

1. 作为一个运营者，我希望**同一个人格**在两种生活方式下保持连续：白天在群里即时问答（Agent 模式），下午在自己的世界里持续生活（World 模式）。
2. 作为一个运营者，我希望两个模式**共享同一套长期记忆**——Agent 模式白天听到的事，World 模式醒来时能想起来；World 模式的经历，Agent 模式白天能引用。
3. 作为一个运营者，我希望**一个 QQ 账号按对话场景切换模式**（2026-09-26 修正，原为"双账号物理隔离"）：她在**群聊**里以 World 姿态生活（人性、当下感、主动性），在**我的私聊**里以 Agent 姿态做生活助理（全能力）；同一个人格，同一个号，两种生活方式保持连续。
4. 作为一个运营者，我希望 World 模式的**主动行为**（自主冒泡、日记、世界演化）**只在指定时间窗口发生**（默认下午 14:00–18:00，4 小时），窗口外不消耗主动行为的 LLM 额度；**被动响应不受窗口限制**——群里被 @ 时她总在（不然像死了）。
5. 作为一个运营者，我希望有一个 **Web 控制台**（`/yanxin`）来设置小研：人格、背景资料、世界定义、管理员名单、World 时段，并能查看世界状态、检索记忆、调试对话。
6. 作为一个运营者，我希望有一个**初始化向导**（人格导入 → 背景资料补充 → 世界构建），引导我完成从零到能跑起来的全过程。
7. 作为一个运营者，我希望**shell 命令只有管理员能触发**，且每一跳都有审计。
8. 作为一个开发者，我希望**不重启进程**就能启停 World 模式，且 Agent 模式的在线状态不受影响。

### 范围边界

**做**：DSH bundle（我们的插件集）、三个 agent preset（模式能力集）、World 引擎（双 LLM + TU 时钟 + 状态文件）、MemoryService + ReMe provider、OneBot 适配（单账号多会话路由）、窗口调度、outbox 发射闸门、setup 初始化流程、`/yanxin` 控制台页面、管理员名单与 shell 能力门。

**不做（v1）**：多租户、DSH 控制台原生槽位集成（`dsh.client` 半包）、NPU/NPC 生态、跨进程 broker、ReMe 之外的第二记忆后端（但接口必须预留）、DSH 上游改动（不接受外部 PR）。

---

## 2. 地基：DeepSeek Harness

### 2.1 为什么是 DSH（选型记录）

三个候选，逐条对比如下（全部逐字核实过源码/文档）：

| | A. `cordiverse/cordis` | **B. DeepSeek Harness** ✅ | C. `@deepseek-ai/cordis` 仅作库 |
|---|---|---|---|
| kernel | `cordis@4.0.0-rc.10` | `@deepseek-ai/cordis@4.0.4` | 同 B |
| agent loop | 自写 | ✅ `ReactLoopAgent` 现成 | 自写 |
| 工具集 | 自写 | ✅ bash/pwsh/fs/glob/grep/web/subagent/todo | 自写 |
| 工具门控 | 自写 | ✅ `ctx.tools.guard` + `tools/pre-execute` + `ctx.approval` | 自写 |
| 沙箱 | 无 | ✅ bwrap/Landlock/Seatbelt/**Windows-ACL** | 无 |
| session 日志 | 自写 | ✅ append-only 类型化事件 | 自写 |
| settings | 自写 | ✅ `ctx.settings` + `expectedRevision` | 自写 |
| LLM 适配 | 自写 | ✅ `dsh-llm-pi-ai`，含 OpenAI 兼容 | 自写 |
| MCP | 无 | ✅ stdio + streamable-http | 无 |
| Web 控制台 | ✅ 真·schema 自动表单 | ⚠️ 非 schema 驱动，需自建页面 | ❌ 生态不兼容 |
| 稳定度 | rc.10 预发布 | ⚠️ developer preview | 同 B |

**决定性理由**：无论选哪个地基，我们必须自建的部分（World 双 LLM 世界模拟、MemoryService、OneBot 适配、outbox 发射闸门、人格分叉、窗口调度）**完全相同**；而 DSH 白送的恰好是 boilerplate。A 唯一的优势（schema 自动表单）不足以抵消重写一个 coding-agent harness 的成本。C 被否决：`@cordisjs/plugin-webui` 生态 peer 的是 `cordis` 而非 fork，控制台拿不到，等于 A 少了控制台。

**已知代价（接受）**：

- DSH README 原话：**"DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. THERE WILL BE COMPATIBILITY-BREAKING CHANGES."**
- 无任何稳定版发布，全部 prerelease。
- 不接受外部 PR："We are sorry that we cannot accept external pull requests at the moment." → 遇到框架 bug 只能绕行或本地 patch。
- `redactSecrets` 官方自述 **"is not a proven wire boundary"**：走 union/intersection/transform 的 `role('secret')` 字段会被原样返回。

### 2.2 版本策略：pin `0.1.5-rc.3`（已修正）

**⚠️ 第 5 稿的决策（pin `0.1.0-rc.5`）已被推翻**：该版本**从未发布到 npm**（`rc.4`/`rc.5` 是 monorepo 内部版本号），而 DSH 的npm 发布是"部分发布且各包版本漂移"的。完整推导见 `docs/decisions/0002-version-strategy-and-layout.md`。

对 11 个必需包（`dsh-base` / `dsh-agent-presets` / `dsh-persona` / `dsh-tools` / `dsh-session` / `dsh-settings` / `dsh-llm-pi-ai` / `dsh-host-webserver` / `dsh-sandbox-local` / `dsh-tool-bash` / `dsh-web-app`）求版本交集：

| 版本 | 覆盖 | 通道 |
|---|---|---|
| **`0.1.5-rc.3`** | 11/11 | rc ✅ **采用** |
| `0.1.6-alpha.2` | 11/11 | alpha |
| `0.1.7-rc.2` | ❌ 不可用 | `dsh-agent-presets` 无此版本，而 preset 是本项目的模式原语 |

**决策：11 个 `dsh-*` 精确 pin `0.1.5-rc.3`；vendor 三包按各自版本线**（`@deepseek-ai/cordis@4.0.4`、`cordis-plugin-loader@1.0.5`、`cordis-plugin-include@1.0.9`）。

**⚠️ 本 spec 的 API 引用来源与运行时目标版本不一致**：§13 的源码索引取自本地 checkout 的 `0.1.0-rc.5`，而运行时是 `0.1.5-rc.3`，**隔了 5 个 prerelease**。因此**在写任何业务代码前必须逐项重核**（任务 T0-C2）。这是硬前置，不是可选项。

**⚠️ npm dist-tag 陷阱**：多数 `dsh-*` 包的 `latest` 停在 **`0.0.1-rc.1`（2026-08-10）**。裸 `npm i @deepseek-ai/dsh-tools` 会装到六周前的陈旧版本。**所有依赖必须写精确版本，禁用 `^` / `~` / `latest`。**

**升级纪律**：升级 DSH 版本 = 独立任务，必须：更新参照 checkout → 按目标版本重核本 spec 引用的每个 API → 更新 spec → 再改代码。**禁止只改版本号就开跑。**

### 2.3 平台约束（win32）

- Node `engines`: `^22.19.0 || >=24.0.0`。你本地 `v26.3.1` ✅。
- 包管理 `pnpm@11.7.0`（root `packageManager`）；你本地 `11.13.0` ✅。
- **DSH base profile 在 Windows 上禁用 bash、启用 pwsh**（`packages/bundle/base/cordis.patch.yml:178-186`）：

  ```yaml
  - id: bash-sandbox
    name: '@deepseek-ai/dsh-bash-sandbox'
    disabled: !!js process.platform === 'win32'
  - id: pwsh-sandbox
    name: '@deepseek-ai/dsh-pwsh-sandbox'
    disabled: !!js process.platform !== 'win32'
  ```

  **本项目决策：强制启用 Git Bash**（见 §6.10），在自己的 bundle patch 里覆盖这两行的 `disabled`。
- `native/landlock-run` 仅 Linux；Windows 沙箱走 `dsh-sandbox-windows-acl`（koffi FFI），`enforcement: 'partial'`。

---

## 3. Tech Stack

| 层 | 包 | 版本 | 备注 |
|---|---|---|---|
| kernel | `@deepseek-ai/cordis` | `4.0.2` | **精确钉死**（`dsh-*` 的 peer 就是这个精确值，不是范围） |
| 装配 | `@deepseek-ai/cordis-plugin-loader` | —— | **声明为宿主的，本仓不声明**（见 §9 的依赖纪律与 ADR 0006） |
| 装配 | `@deepseek-ai/cordis-plugin-include` | —— | 同上。它们钉 `cordis ~4.0.4`，而 `dsh-*` 钉 `4.0.2`，**声明它们会分裂出两份内核** |
| agent 循环 | `@deepseek-ai/dsh-agent-loop` | `0.1.5-rc.3` | `ReactLoopAgent` |
| 工具 | `@deepseek-ai/dsh-tools` | `0.1.5-rc.3` | `defineTool` |
| 工具 | `@deepseek-ai/dsh-tool-bash` / `-pwsh` / `-fs` / `-fs-search` / `-web` | `0.1.5-rc.3` | |
| 模式 | `@deepseek-ai/dsh-agent-presets` | `0.1.5-rc.3` | **模式原语** |
| 人格 | `@deepseek-ai/dsh-persona` | `0.1.5-rc.3` | `{{model}}`/`{{cwd}}` 模板 |
| 会话 | `@deepseek-ai/dsh-session` | `0.1.5-rc.3` | append-only |
| 设置 | `@deepseek-ai/dsh-settings` | `0.1.5-rc.3` | |
| LLM | `@deepseek-ai/dsh-llm-pi-ai` | `0.1.5-rc.3` | OpenAI 兼容路由 |
| HTTP | `@deepseek-ai/dsh-host-webserver` | `0.1.5-rc.3` | `ctx.webServer` |
| 沙箱 | `@deepseek-ai/dsh-sandbox-local` / `-windows-acl` | `0.1.5-rc.3` | |
| 校验 | `schemastery` | `^3.18` | `z.object` |
| 语言 | TypeScript | `^5.9` | ESM |
| 测试 | `vitest` | `^4` | 与 DSH 一致 |
| Lint | `oxlint` | `1.76.0` | 对齐 DSH 上游（单二进制、1 个依赖；不用 eslint + typescript-eslint 那 ~50 个包） |
| OneBot | `@imhelper/onebot-v11` + `imhelper` | `1.0.9` | ⚠️ 需 T0 spike，见 §11 |
| 记忆 | `reme-ai`（Python 侧，外部进程） | `0.4.1.12` | 独立进程，非内嵌 |

**不依赖 `@deepseek-ai/dsh-schedule`**：它 session-local、无 cron/日历（官方原话 "calendar or Cron expressions are not part of the protocol"）、最小 5 分钟固定间隔。窗口调度自写（§6.6）。

**不依赖 `@deepseek-ai/dsh-anonymous-user-id`**：其 group README 明确 "These values do not represent an authenticated account."，无账号模型。QQ 账号模型完全自建。

---

## 4. Commands

```bash
# ── 一次性：装运行时（本仓按这一版写的）
pnpm add -g @deepseek-ai/dsh@0.1.5-rc.3        # 公开 npm 包，不需要 clone monorepo

# ── 依赖 + 构建（⚠️ DSH 加载 lib/，改了 src/ 不 build 等于没改）
pnpm install
pnpm build

# ── 部署：建 profile + 写部署配置 + 建工作目录（幂等，可反复跑）
node scripts/install.mjs --self-id <她的 QQ 号>
node scripts/install.mjs --help                # 全部开关；加 --dry-run 只看不动
#   ↑ 它写的是 $DSH_HOME/profiles/yanxin/cordis.patch.yml（模板：deploy/profile.example.cordis.patch.yml）
#     那一层装着 token 与本机路径，**不入库**；手写也行，但 onebot.port 是必填，缺了启动即校验失败

# ── 密钥与凭据（这两件脚本不代做）
#   LLM key → $DSH_HOME/.credentials.yaml（扁平格式，键名 = 环境变量名；别内联进 YAML）
export YANXIN_CONSOLE_TOKEN='<你自己设一个串>'   # 没配 = 写操作与日志流一律 403（fail-closed）

# ── 启动
dsh --profile yanxin
# 浏览器开 http://127.0.0.1:3080/yanxin/setup —— 人格 → 背景 → 创世 → 绑号
# ⚠️ 启动日志里那句「控制台挂载在 /yanxin」是**无条件打印**的，不代表已初始化；
#    未 ready 时桥会拦住 agent（src/setup/guard.ts），向导才是入口

# ── 调试装配
dsh --profile yanxin --dump-config             # ⚠️ 会**明文打印**内联密钥，别把输出贴到任何公开地方

# ── 质量
pnpm typecheck        # tsc --noEmit
pnpm lint             # oxlint
pnpm test             # vitest run（59 个 spec；两处依赖本机环境，见 AGENTS.md）
pnpm build            # tsc -p tsconfig.build.json → lib/
pnpm presets          # 从 persona/ 重新生成三个 preset

# ── 记忆服务（可选，独立 Python 进程，只绑回环）
reme start workspace_dir="$HOME/.dsh/yanxin/reme" service.host=127.0.0.1 service.port=2333
# ⚠️ 必须 cd 到 .env 所在子树再启动（reme start 不读 .env，是它内部的 load_env 按 cwd 找）；
#    装不上就把 settings 的 yanxin-memory.provider 设成 none —— 记忆整条降级为空，其它照常

# ── QQ 通道（可选）：NapCat / SnowLuma 建一条反向 WS
#    URL ws://127.0.0.1:8080/onebot/v11   +   鉴权 Token = profile patch 里的 onebot.token
#    多号就在 profile patch 的 accounts[] 下多加几行（未注册的 selfId 会被拒 403）
```

> 单账号即可跑通：群聊与管理员私聊按场景切换 preset（§6.3、§6.5）。历史上的"双账号物理隔离"方案已退役。


---

## 5. Project Structure

### 5.1 Bundle 仓库（本项目）

```
yanxin/
├── package.json              # name: yanxin；"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml          # bundle 层 patch：插入我们的插件行、覆盖平台门、host 平面 disable 清单
├── src/
│   ├── net/                  # url-guard —— 出网 SSRF 守卫（§7.4-A）
│   ├── onebot/               # OneBot v11 适配（DSH 无 IM 概念，全自建，只依赖 ws）
│   │   ├── service.ts        # ctx.onebot —— 反向 WS 服务端 + 账号注册表
│   │   ├── transport.ts      # 传输参数的三级回退 + 控制台写入门（非回环要 token + 确认）
│   │   ├── protocol.ts       # 握手头 / 帧分类 / API 帧构造（纯函数层）
│   │   ├── bridge.ts         # 消息 → agent.followup → 读事件 → 回发（§6.5）
│   │   ├── session-trigger.ts# 群聊触发三档 mention/name/never + 最近上下文（§6.5）
│   │   └── provenance.ts     # MessageSource augment：溯源落进 session（§6.13）
│   ├── memory/               # MemoryService 抽象 + ReMe provider（§6.9）
│   │   ├── service.ts        # ctx.memory —— 契约（search/record/consolidate/health）
│   │   ├── reme.ts           # ReMe HTTP client（POST /<job>，净化 session id）
│   │   └── outbox.ts         # 写回缓冲（ReMe 挂了不丢记忆）
│   ├── world/                # 世界引擎（§6.7：模型提案 → 内核校验 → 原子提交）
│   │   ├── kernel.ts         # 内核：四校验 / 幂等 / 乐观并发 / 原子提交 / 重放恢复
│   │   ├── clock.ts          # TU 推进 + Tingle 心跳 + 离线补偿（只补一次）
│   │   ├── arbiter.ts        # World-LLM：到期裁定 + 提案（propose_world）
│   │   └── outbox.ts         # 发射闸门 + 回执（§6.8）
│   ├── window/               # 窗口调度（自写 timer 插件，§6.6）
│   ├── admin/                # 管理员名单 + shell 能力门 + shell 审计挂载（§6.10）
│   ├── audit/                # 审计的唯一出口：落盘 / 脱敏 / 危险等级 / shell 记录构造（§7.4-D）
│   ├── setup/                # 初始化状态机 persona→background→world→accounts→ready（§6.11）
│   └── console/              # /yanxin 八页 + HTTP 路由 + SSE 日志流（§6.12）
├── presets/                  # 三个 agent preset —— ⚠️ **生成产物**，由 build-presets.mjs 出
│   ├── xiaoyan-agent/        # 群聊 / 非管理员私聊：人格 + 网页工具，无 shell
│   ├── xiaoyan-admin/        # 管理员私聊：上一行 + shell + fs + subagent…（15 行）
│   └── xiaoyan-world/        # World 模式：世界姿态 + 世界工具，无 shell
├── persona/                  # 人格**源文件**（单一来源）：base.md / profile.md / world.md
│                             #   ⚠️ 本包出厂是空模板；改完跑 `pnpm presets`
├── deploy/                   # profile.example.cordis.patch.yml —— 部署层模板（install.mjs 的原料）
├── scripts/                  # install.mjs（部署）、build-presets.mjs（生成 preset）
├── tests/{unit,integration,support}/   # 59 个 spec；support 里接管 $DSH_HOME
└── docs/spec.md              # 本文件（ADR 与任务清单不在本包，见文首说明）
```

### 5.2 运行时数据（**不在仓库内**）

DSH 的惯例是运行时数据放 `$DSH_HOME`（`~/.dsh`），由 `dshHomePath()` 解析（`packages/util/home-paths/src/index.ts`）。**上一稿把数据放在仓库内 `data/` 是错的**，已修正：

```
$DSH_HOME/
├── cordis.patch.yml                    # 机器级 patch（层序第 3 层）
├── .agent-presets/                     # DSH 的 user preset root（includeUserRoot 默认 true）
│   ├── xiaoyan-agent/
│   ├── xiaoyan-admin/
│   └── xiaoyan-world/
├── profiles/
│   └── yanxin/                         # 我们的 profile（由 dsh plugin 创建/维护）
│       ├── package.json                # dsh.profile.bundles
│       ├── cordis.patch.yml            # profile 层 patch（层序第 2 层）
│       └── pnpm-workspace.yaml
├── yanxin/                             # 我们的运行时数据
│   ├── workspace/                      # shell / fs 工具的受限根
│   ├── world/                          # 世界引擎数据（§6.7：事务日志 + 快照 + 她的笔记）
│   ├── reme/                           # ReMe workspace_dir
│   ├── audit/                          # shell 审计日志
│   └── inbox/                          # 窗口外消息缓冲
└── settings/                           # ctx.settings 的用户文档
```

**理由**：`$DSH_HOME` 是 DSH 的既有约定（`resolveDshHome()`：显式配置 > `$DSH_HOME` > `~/.dsh`），我们的数据跟着走才能被 `dsh --dump-config`、备份、多机迁移一并覆盖。

---

## 6. 装配设计

### 6.1 四层装配（本地对话页实测后修正）

DSH 的层序（后者按行胜出，`apps/cli/reference/README.md:9`）：

```
1. 每个 bundle 的 patch          （按 dsh.profile.bundles 顺序，@deepseek-ai/dsh-base 在最前）
2. profile 自己的 cordis.patch.yml
3. $DSH_HOME/cordis.patch.yml    （机器级，压过 per-profile）
4. 每个 --patch <path>           （argv 顺序）
```

我们的分工：

| 层 | 放什么 | 谁改 |
|---|---|---|
| **bundle patch**（`yanxin/cordis.patch.yml`） | 我们的**插件行**（memory / onebot / world / window / admin / setup / console）、DSH 平台门覆盖（启用 Git Bash）、**工具行的启用与预算参数** | 开发者，随版本走 |
| **`$DSH_HOME/settings.yaml`** | **LLM provider 路由**（baseURL / api / apiKeyEnv / models）、默认模型、World 窗口时段、管理员名单 | 运营者 / 控制台 |
| **`$DSH_HOME/.credentials.yaml`** | 密钥值（`apiKeyEnv` 指向的键） | 运营者，owner-only |
| **user preset root**（`$DSH_HOME/.agent-presets/`） | 三个 preset（模式能力集） | setup 写入，控制台可改 |

**⚠️ 为什么 LLM 配置不在 bundle patch 里（实测教训，见 ADR 0004）**：
把 provider 路由写进 patch 的 `llm-pi-ai` entry config，`--dump-config` 会显示**合并成功**，但**UI 的模型列表里根本不出现**——`dsh-llm-pi-ai` 的模型注册表读的是 settings 层。写进 `settings.yaml` 才可见。

**推论（加强 AD-6）**：patch 只适合放**行结构与行级开关**；任何需要被运行时服务读取的**内容配置**都应走 settings。这是本 spec 最容易搞错的一点。

**为什么 preset 不放 bundle 里**：preset 的位置由 `@deepseek-ai/dsh-agent-presets` 的 `roots` 配置决定，而 **patch 是整字段覆盖、不深度合并**（§6.2）——若我们从 bundle patch 覆盖 `roots`，会踢掉 DSH 自己的 system root，也会被 `profile-boot.ts` 后追加的 overlay 反压。放到 DSH 的 **user root**（`$DSH_HOME/.agent-presets/`，`includeUserRoot` 默认 `true`）则完全不冲突。这是被 patch 语义逼出来的设计。

### 6.2 patch 语义与陷阱（必须记住）

`vendor/include/src/index.ts` 的 `applyEntryPatches` 是全部实现。**只有两种操作**：

1. **`insert`** —— 追加到根列表；若 `id` 指向一个 `group: true` 的行，则 push 进它的 `config`。
2. **按 id 整字段覆盖** —— 除 `id`/`insert` 外任意 key 被**整体赋值**。

```ts
for (const [key, value] of Object.entries(overrides)) {
  if (key === 'id') continue
  target[key] = value        // ← 整字段赋值，无深度合并
}
```

- **没有** `replace` / `delete` / `update` 操作键。
- `name` 只是「不匹配则跳过」的守卫，不是操作。
- 目标行不存在 → **warn 并跳过**（不是硬失败）。意味着拼错 id 会静默失效，只留一条警告。
- 官方中文确认："patch 会替换目标行的整个 `config` 值，而不是深度合并各键。"

**因此：任何想"只改 config 里一个键"的企图都不成立——必须把完整 config 重写一遍。** 这是最容易踩的坑，已列入 Boundaries。

### 6.3 模式 = preset（核心设计）

DSH 的 preset 是**一个目录**，内含 `agent.cordis.yml`（插件行清单，与 `cordis.yml` 同 dialect）+ 可选 `preset.yml`。挂载点：**`await ctx.agentPresets.mount(agentCtx, id?)`**（⚠️ 在 `0.1.5-rc.3` 上 `mount` / `list` / `resolve` **都返回 `Promise`**，见 ADR 0003），**只能在 agent factory 的 `setup(agentCtx)` 里调**。N 个 preset 在一个进程内共存，每个会话挂一个；preset 里的**根服务行冲突必须用 `isolate` realm 包起来**（否则 mount 被拒）。

**注意：preset 不含模型。** 模型来自 `AgentOptions`，不是 preset 的一部分（官方 "Known Limitations"）。所以两模式的模型在创建 agent 时给。

三个 preset（**场景划分 2026-09-26 修正：单账号按对话场景切换，群聊归 World**）：

| preset | 场景 | 能力集 |
|---|---|---|
| `xiaoyan-world` | **群聊**（她的"生活世界"） | 世界姿态人格 + 记忆召回 + World 工具（act/wait/rest/send…），**无 shell、无重工具** —— 一个"人"不需要工具面 |
| `xiaoyan-admin` | **Agent 模式落地：管理员私聊**（生活助理，只有运营者能触达） | 人格 + 记忆召回 + **全能力**：bash、文件系统、任务计划（todo/goal）、子代理与工作流 |
| `xiaoyan-agent` | 群聊**脚手架**（Phase 5 前 world 引擎未就绪时顶着）+ 非管理员私聊的兜底 | 人格 + 记忆召回 + 弱工具子集（web 二件套），无 shell |

**命名对照**（代码 mode 前缀 ≠ 用户口语，改会话 id 前缀会破坏已有会话的 resume，故不改名）：

| 代码/会话前缀 | 用户口语 | 落地 preset |
|---|---|---|
| `admin:<qq>` | "agent 模式"（生活助理） | `xiaoyan-admin` |
| `world:<qq>` | "world 模式"（群里生活的她） | `xiaoyan-world` |
| `agent:<qq>:…` | （脚手架，Phase 5 后退役） | `xiaoyan-agent` |

模式与场景的映射在 OneBot 驱动层完成（单账号）：**群消息 → `xiaoyan-world`（Phase 5 前暂由 `xiaoyan-agent` 顶着）；管理员私聊 → `xiaoyan-admin`；非管理员私聊 → `xiaoyan-agent`（弱能力兜底，Phase 5 后可换 world 姿态）**。同一账号、同一人格基底，姿态与能力随**对话场景**切换 —— 这比双账号更符合"同一个她"的连续性（用户故事 1、3）。

**`preset.yml` 的 `order` 取值规则**（实测，ADR 0004）：出厂的四个 preset 是 1/2/3/4（standard/code/minimal/cordis）。**`order: 0` 会排到列表最后**（0 大概被当作未设置），所以我们的 preset 用 **`order: 5` 起**。不影响功能，只影响可发现性。

**✅ preset 能力裁剪已验证有效**（ADR 0005）：读 session 的 `request/header` 事件取得发给模型的真实 `tools` 数组，确认 root 层组合的 `dsh-tool-bash` / `-fs` / `-fs-search` / `-todo` / `-web` 等**都没有**进入 `xiaoyan` preset 的工具表。这正是 §6.10 能力隔离得以成立的基础。

**⚠️ 但 MCP 工具绕过 preset 作用域**（ADR 0005，**未处理**）：组合在 root 层的 `@deepseek-ai/dsh-mcp-client` 会把 MCP 服务端的工具注册为**全局**工具，不参与 preset 裁剪。实测中 `xiaoyan` preset（一行工具都没声明）的工具表里出现了 5 个 `mcp__tavily__*`（含 `tavily_extract` / `tavily_crawl` / `tavily_research`，都能发起任意抓取）。

- 严重性：走 Tavily 服务器而非本机，**不是本机 SSRF**；但属**计划外能力面**。
- **处置前禁止把 Agent 模式接到公网 QQ。**
- 候选方案（见 todo 的 T38）：把 MCP 从 root 移入需要的 preset / 用工具裁剪显式排除 `mcp__*` / 在 `url-guard` 里一并检查 `mcp__*` 的 URL 参数。

### 6.4 人格基底

用 `@deepseek-ai/dsh-persona`（`config.text` 支持 `{{model}}` / `{{cwd}}` 模板）承载基底，两模式共享同一份文本：

```
templates/persona-base.md      → 不变的自我认知（共享）
templates/persona-profile.md   → 可变偏好（共享，控制台可编辑）
────────────────────────────────────────────
xiaoyan-agent preset 的 persona 行：基底 + profile + "你正在与群友即时对话"
xiaoyan-world preset 的 persona 行：基底 + profile + "你正在过自己的生活" + 世界定义
```

**分叉的是 prompt 模板与可用工具，不是人格本身。** 人格是两个 preset 都引用的同一份文本文件，所以不会"性格分裂"。

### 6.5 单账号、多场景与消息桥

DSH **没有任何 IM 概念**，也没有账号模型（`dsh-anonymous-user-id` 只是一个 per-home 随机 UUID，明确"不代表已认证账号"）。所以整条链路自建：

```
NapCat 实例 ×1  ──反连 WS──▶  ctx.onebot（反向 WS 服务端，常驻）
                                   │  按 X-Self-ID 头 + self_id 字段双重判定账号
                                   ▼
                             账号注册表查找 → 按**对话场景**选 preset（群聊 → world；管理员私聊 → admin）
                                   │
                                   ▼
                     ctx.agents.create/resume({ sessionId, meta: { agentPreset }, agentOptions: { provider, model }, setup })
                                   │
                                   ├─ agent.followup(createUserMessage({ content, source }))
                                   ├─ await agent.whenIdle()
                                   ├─ ctx.sessions.flush(agent.session)
                                   └─ 从 firstSeq 之后读 assistant/message 事件 → 经 OneBot 回发
```

**DSH 没有"发一条消息并等回复"的单一 API**，官方模式就是 `followup()` + `whenIdle()`（`packages/bundle/headless/src/index.ts:111-133`）。`whenIdle()` 在**静默时**解析，不是每条消息——所以必须用 `firstSeq = agent.session.seq` 划界再读新增事件。

session_id 命名空间（保证写回分离、召回共享；mode 前缀 = 上面的命名对照表）：

```
agent:QQ:group:123456        群会话（Phase 5 前的脚手架；之后由 world 姿态接管新会话）
agent:QQ:private:789         非管理员私聊（弱能力兜底）
admin:QQ                     管理员私聊（Agent 模式落地，唯一全能力）
world:QQ:group:123456        World 模式的群会话（Phase 5 起）
```

**群聊触发策略**（2026-10-01 增补，`decideTrigger` 三档）：`mention`（默认，只回应 @）、
`name`（被 @ **或**文本里出现她的名字也叫一次——运行时配置 `nameWords`）、`never`。
`name` 档的措辞纪律是**"叫的是去看一眼，说不说由她"**：别人互相提到她名字、或那句
不是说给她听的时候，接话就是插话——人格里同步写了这条社交规则。

**现形缓存（`RecentChat`）**：桥的闸门默认丢掉未触发的消息，她被叫到时其实**不知道
前面在聊什么**。按群分桶的内存环形缓冲（默认保留 10 句）在**触发判定之前**入桶，
调用时把"刚才听见的话"拼在当前消息前面——空缓冲逐字节不加，措辞像"你刚才听见
群里说"，不用工程词。它与记忆的分工：这是"刚才"，不是"历史"（长期记忆归 §6.9）。

**消息统计**：桥同时是收发的记账点（控制台仪表盘的数据源，见 §6.12）。

### 6.6 窗口调度（自写）

`@deepseek-ai/dsh-schedule` 不够用：session-local、无 cron/日历规则、最小 5 分钟固定间隔、只保留最新一次补偿。官方 cookbook 自己给的路子是"写一个带自己 timer 的插件"。

我们的 `window` 插件（root 级，常驻）：

```ts
// 概念形态：窗口启停的是 World 引擎的调度回路，不是 preset
// （被动响应不走引擎，永远在线；preset 按消息场景挂载，与窗口无关）
ctx.setInterval(() => {                     // 或 DSH timer 服务
  const open = withinAnyWindow(new Date(), config.windows)
  ctx.loader.update('yanxin-world-engine', { disabled: !open })
}, 60_000)
```

**必须放在 root 级**，不能放进 world 引擎分组内部——否则引擎被禁用时它自己的调度器也一起停了，永远醒不来。

默认窗口：**每天 14:00–18:00（下午 4 小时）**，可在 `/yanxin` 控制台修改；支持多窗口与跨天窗口。

**手动暂停压过窗口**（2026-10-02 增补）：settings 的 `yanxin-window.paused`（控制台世界页的
「世界引擎开关」写它）为 true 时，引擎行**恒被卸下**——窗口开着也不装载。与"关闭时段"
是两回事：关窗是时间到了，暂停是运营者明确的意志（典型动机：额度紧张时按一下停）。
暂停即时生效（窗口服务 watch 自己的命名空间，写入即重裁决），不用重启；页面把两种
"她没在过日子"分开说。

⚠️ **窗口约束的是主动行为，不是存在感**（2026-09-26 修正）：窗口内 World 引擎自主运转（观察群流、冒泡、日记、世界演化）；**窗口外她不主动产生任何行为，但被动响应照常**——群里被 @ 时她总在，只是不自主做事。因此窗口调度**不再启停 `xiaoyan-world` 这个 preset**（会话挂载是按消息来的），而是启停 **World 引擎的调度回路**（root 级服务）。

启停走 loader 的 `disabled`（patch 语义支持 `disabled: true | null` 整字段覆盖），是增量 reconcile，不重启进程。

### 6.7 World 引擎

> **2026-09-27 架构更新**（参照 YesImBotWorld 的**现形态**，见 ADR 0015）：
> 参照框架已把"World 先讲述结果、再后台改 Markdown"整条链路**删掉**，改成
> "**提出事务 → 内核校验 → 原子提交 → 角色观测**"。我们原先抄的是它的旧形态，
> 本节按新形态重写：**模型只提案，内核校验后才落盘**。

**闭环**：

```
Bot-LLM（她自己）
   │ ① observe —— 拿"她能感知的"投影（不是全知）
   ├─▶ act / wait / rest / send / note（工具调用，带期望耗时 duration）
   ▼
runtime（行动运行时）：登记 pending（含幂等键）→ 等世界时间到点
   │ ② 到期
   ▼
World-LLM（裁定者）：按**当前**状态判定成败 → propose_world（提案，不写文件）
   │ ③ 提案
   ▼
kernel（内核）：校验 → 乐观并发 → 原子追加进事务日志
   │ ④ 已提交事实
   ▼
observe（下一次感知）──▶ Bot-LLM
```

**三层分离**（这是与"让模型改 Markdown"的根本区别）：

| 层 | 载体 | 谁写 | 性质 |
|---|---|---|---|
| **权威状态** | `world-transactions.jsonl`（只追加）+ 由它重放的快照 | **只有内核** | 唯一真相：可重放、可校验、可回到任意序号 |
| **她的笔记** | `notes/*.md`（一篇一个文件，文件名即标题） | 她自己（`note` 工具） | 私人记录（日记 / 对群友的印象 / 备忘）。**人机共用同一介质**：你可以直接翻、也可以丢 `.md` 进去，她看得到 |
| **只读呈现** | `world-status.md` 等（由快照导出） | 内核导出 | 给人看的摘要。**不是**状态编辑入口 |

**内核校验什么**（我们规模下的最小集 —— 诚实列出，不多不少）：

- **引用完整性**：目标实体 / 位置必须存在（悬空引用直接拒，附机读诊断）
- **类目合法**：操作只允许 `create` / `update` / `move` / `action.start` / `action.finish` / `say`
- **幂等**：`idempotencyKey` 重复的提案**忽略**（防超时重试造成重复结算）
- **乐观并发**：提案携带 `expectedVersions`，与当前 `revision` 不符则拒（防"基于旧感知改新状态"）
- 校验失败 → 返回**机读诊断**（哪条操作的哪个字段、为什么、目标是什么）→ 模型可修正后重提，最多 N 轮

⚠️ **刻意不做**（参照框架有、我们不需要）：实体图 / 容器嵌套 / 寻路 / 能量守恒 / 跨主机联机。
我们的世界是**一个房间 + 一条街 + 一部手机**，校验集保持最小 ——
**不把提示词当物理引擎**（这是参照框架文档里的原话，值得抄的是这句态度）。

**观测投影**（她不是全知的）：

- `observe` 只返回"她在哪儿、那儿能感知到什么"：**在屋里** → 屋内的家具、窗、街上的光景；**在街上** → 街景（看不到屋里）；**看手机** → 群消息
- 观测返回**句柄**（`seen:…`）而不是内部 id —— 模型用句柄选目标，**不能猜数据库 id**
- 尚未被感知的事物**不进她的上下文** —— 这是"她的世界"与"一张数据库表"的区别

**动作三阶段**（接受 / 结算 / 交付，分开）：

- 开始时登记 `pending`（含 `expectedEnd` = 生成时刻 + duration）—— Bot-LLM **不等待结果**
- 抵达完成时刻才按**当前**状态裁定（世界可能已经变了）
- 结果以事件注入下一次感知；**失败不会作为成功回执返回**
- 单次 tool call 的合法性：走 OpenAI 兼容的 **`tool_choice: 'required'` + JSON Schema 严格模式**

**时钟**：`1 TU = 1 现实秒`（`syncRealTime: true`）。Tingle 心跳每 `tingleEveryUnits`
（默认 1800 TU = 30 分钟）唤醒 World-LLM。参照框架另有 `tingleMode: 'auto'`（让世界自己决定
下次间隔，带上限）—— 我们**默认 `fixed`**，够用；`auto` 留到有实际需要时再说。

**离线补偿（关键）**：窗口关闭跨越后重启，**只算一个离线区间、发一次补偿 tick，绝不逐 tick 重放**。
理由：否则一次 LLM 调用要经历二十小时的世界演化，额度爆炸且叙事崩坏。重新启用时按
`clock.json` 的 `lastTick` 计算 —— 语义与参照框架的 `consumeOfflineGap()` 一致：**只能取一次**。

**创世（世界怎么从零开始）**：`persona/world.md`（人工创作的世界定义）是**创世输入** ——
由 World-LLM 提取为结构化初始实体（房子 / 街道 / 手机…）→ 内核校验 → 提交。
规则照参照框架的迁移纪律：**只允许 `create`**；根地点用 `null`（不必无限补建外层地点）；
整批创建后统一校验引用；失败**保留旧状态并报错**，不悄悄以空世界替代。
`world.md` 里的正文仍是她的世界认知（进 prompt），结构化实体是它的**可执行投影**。

**窗口外消息（inbox）**：~~窗口关闭期间账号 B 的连接仍在……~~ **随双账号方案退役**（2026-09-26）：单账号下没有"窗口外收不到消息"的问题——群消息随时被处理（被动响应不受窗口限制），进程停机期间的消息由 OneBot 反连重连后的实时流兜底（不补历史）。原设计为"账号 B 窗口外不消费消息"而生，前提已不成立。

**与记忆的分工**（三处存储各司其职，别混）：

| 存储 | 装什么 | 谁产生 | 被谁读 |
|---|---|---|---|
| `world-transactions.jsonl` | 世界状态与已发生的事件 | 内核（校验后） | 观测投影、控制台 |
| `notes/*.md` | 她主动写下的记录 | 她自己（`note` 工具） | 她（下一次感知）、你（直接翻） |
| ReMe（§6.9） | 对话沉淀与检索 | 服务层（每轮写回） | 召回注入（两个模式共享） |

~~旧 `Bot_Definition.md` / `World_Definition.md`~~ → 分别由 `persona/base.md`+`profile.md` 与
`persona/world.md` 承担（人格源文件本来就是单一来源）；
~~`Bot_Status.md` / `News.jsonl` / `facts.jsonl`~~ → **不采用**：她的状态由上下文管、
世界事件在事务日志里、事实在 ReMe（参照框架已把前两者列为"迁移资料，不能作为状态编辑入口"）。

写入纪律：**追加型用 JSONL（永不原地改写），快照型用 JSON + 原子替换（临时文件 + rename）**。所有写入必须经内核，不允许多个插件各自 `writeFile`。

### 6.8 发射闸门（outbox）

DSH 的 `ctx.effect` 与 Cordis 论文 §6.1 同源：**不负责回滚"发射型"副作用**。能被系统独占修改并复原的位置在边界内（被追踪、可回滚）；否则在边界外，操作等同 `id`，**既不追踪也不回滚**。

发 QQ 消息正是 emission（跨出进程边界，第三方可见）→ **`ctx.effect` 撤不回已发出的消息**。

因此 World 模式的对外行为必须走 outbox：

```
LLM 决定 send ──▶ outbox 落盘（可回滚区）──▶ 世界事务提交 ──▶ 真正发出（不可回滚）
                                    ↑
                          若后续步骤失败，丢弃 outbox 条目即可
```

采用 output commit（**把发射推迟到产生它的状态确定持久化之后**），补偿（撤回消息）只作兜底，不作主要保证。

**回执纪律**（2026-09-27 补，参照框架的教训）：`send` 发出后的平台回执（成功 / 失败 / 超时）
必须与"她以为说了"**分开** —— 发送失败**不当作成功**（她下一次感知会知道那句话没说出去）；
发出后进程重启才回来的回执**只导入一次**（按事件 id 去重）。
我们规模下**不建独立收件箱**（参照框架的 `bot-receipts/` + epoch 轮换是为一停一启的多进程场景设计的），
outbox 条目 + 事务日志里的 `say` 记录够用；真出现"延迟回执"问题再加。

> Agent 模式的回复是会话内同步应答，天然满足 output commit，不需要 outbox。

### 6.9 记忆（MemoryService）

DSH **没有一等公民的记忆子系统**（全仓库 grep `reme` 零命中；`docs/subsystems/` 无 `memory.md`），所以自建。

```ts
export interface MemoryService {
  /** 召回：跨 session 全 workspace 检索 */
  search(query: string, options?: { limit?: number }): Promise<MemoryHit[]>
  /** 写回：不直接写，而是把轨迹交给 provider 自动沉淀 */
  record(trajectory: Trajectory, sessionId: SessionId): Promise<void>
  /** 主动整理：触发 provider 的固化流程（ReMe 的 auto_dream） */
  consolidate(): Promise<void>
  /** 健康检查，供降级判断 */
  health(): Promise<{ ok: boolean; detail?: string }>
}

export interface MemoryHit {
  content: string
  source: string                    // 文件路径
  lines?: [number, number]
  links?: string[]                  // wikilink 邻居
  score?: number
  sessionId?: string                // 溯源：来自哪个模式/会话
}
```

**设计要点**：

- **`record` 而非 `add`**：ReMe 没有 add 工具（写回靠 `auto_memory` 监听对话自动完成，且**每 session 每天最多沉淀一张卡**）。接口如实反映，避免抽象泄漏。
- **降级**：`health()` 失败时 `search` 返回空数组并记 warning，**不阻塞对话**。记忆是增强而非依赖。
- **契约测试**：同一套用例跑任何 provider（v1 只有 ReMe），兑现"可换后端"承诺。
- ⚠️ **`sessionId` 是"我们的 id"，provider 可能要再映射一次**：ReMe 把它当**文件名**用
  （写 `session/dialog/<session_id>.jsonl`），而 bridge 的 id 是 `agent:<qq>:group:<gid>`
  —— 含一堆冒号，会被 ReMe 拒绝。所以 provider 内部过一层 `remeSessionId()`（净化 + 边界兜底 hash）。
  **映射必须确定性**（同一 session → 同一 id），否则 ReMe 无法累积会话日志。
  契约这一层**不感知**映射：调用方给的是我们的 session id，变形是 provider 的实现细节。
  这也**不影响"两模式共享记忆"** —— ReMe 的 `search` 是全 workspace 检索，不按 session 过滤。
- ReMe 接入 = 本机 HTTP `POST /<job>`（默认 `127.0.0.1:2333`）。**ReMe HTTP 无鉴权 → 必须只绑回环，绝不对外暴露。**
- ⚠️ **ReMe 的失败常常是"HTTP 200 + 内部异常"**（`Msg` 校验失败、LLM 404 都是），
  且失败原因写在 `answer` 里、`metadata` 往往是无关统计。所以**判据不能只看状态码**，
  必须同时看 ReMe 日志。踩过的三个坑见 ADR 0014 决策六。
- 参考实现：ReMe 仓库自带 `integrations/dsh/src/reme/client.ts`（TypeScript，`fetch` POST `/<job>`），以及官方 `@agentscope-ai/reme-dsh-plugin@0.1.0`（配置键齐全）。**但两者都要求外部 ReMe HTTP 服务，不内嵌。** 我们按 MemoryService 契约自己写薄 client，以保住"可换后端"。

> ⚠️ **术语修正**：`facts.jsonl` / `World_Status.md` / `clock.json` / `stream.jsonl` / `News.jsonl` 属于 **YesImBot World**，**不是 ReMe 产物**。ReMe 实际落盘是 `session/dialog/<session_id>.jsonl`、`daily/<date>/<name>.md`、`digest/{personal,procedure,wiki}/*.md`、`metadata/`、`resource/`。本 spec §6.7 的状态文件是我们自己的定义。

### 6.10 shell 能力门：管理员私聊专用会话

> **✅ 本节描述的隔离已生效（2026-09-25 修复并实测，完整记录见 [ADR 0013](decisions/0013-tool-plane-leak.md)）**
>
> ⚠️ 但它**一度是失效的**，值得记住为什么：`dsh-base` 把 `tool-pwsh`/`tool-fs`/`tool-subagent`…
> 注册在 **host 平面**（root 作用域），而 preset 只能往 **agent 平面加**行、**减不掉** host 行。
> 曾经 `xiaoyan-agent`（群聊）实际拿到 **26 个工具**，含 PowerShell，且实测真的执行了。
>
> **现在的分工原则**（修好后固化下来的）：
>
> > **服务提供者（shell / web provider）放 host 平面，模型可见的工具行由 preset 声明。**
>
> 实测结果：群聊 **2 个**工具（`web_fetch`、`web_search`），管理员私聊 **3 个**（+ `bash`）。
>
> **验收方式也跟着改了**：只读 preset 文件证明不了运行时能力（那正是失效的根源）。
> 权威证据是 `request/header.tools`（本仓的取证断言在 `tests/unit/preset-capabilities.spec.ts`），
> 而 `tests/unit/preset-capabilities.spec.ts` 新增了一组 **host 平面护栏**看着这件事。

**为什么不能按"发言者 id"直接判定**：DSH 的 guard 拿不到发起者身份。`ToolExecution` 只有 `callId` / `name` / `arguments` / `agent` / `signal`；`Agent` 只有 `id: SessionId` / `options` / `session` / `inbox` / `status` / `ctx`。官方注释也确认 guard 只收到 "the identity-protected call"，而全仓库不存在 `RuntimeContext` 或任何 principal/credential/account 字段。

**因此采用 preset 级隔离**（DSH 官方唯一干净的"按账号给不同能力集"的接缝）：

- **群聊会话与普通私聊 → `xiaoyan-agent` preset，其 `agent.cordis.yml` 里根本没有 shell 工具行。** 非管理员永远进不了带 shell 的会话——不是"被拒绝"，而是**能力不存在**（这比拒绝更硬）。
- **管理员私聊 → `admin:<QQ>` 独立会话 + `xiaoyan-admin` preset（含 shell 行）。**

这是有意的取舍：**能力声明期就裁掉**，而不是运行期判定。

**shell 用 Git Bash（T0-A 已实测，结论见 `docs/decisions/0001-win32-shell-path.md`）**

实测结论：`dsh-bash-local` 的 README 声明 **"POSIX-only … Windows is unsupported"**，且源码里 `bash` 是**硬编码字面量**（`bash-local/src/index.ts:212`：`runArgv(spec, ['bash', '-c', spec.command])`）。但 `dsh-subprocess-local` 有 Windows 的 tree-kill 路径，且经验验证 `spawn('bash',['-c',...])` 在本机返回 `MINGW64_NT-10.0-26200 / Git Bash 5.3.15`。所以是**声明不支持、机制可行**。

因此采用**两级策略**：

**Tier 1（零代码，先试）**——patch 里启用 DSH 现成的 `dsh-bash-local`，**不用沙箱版**（`dsh-bash-sandbox` 在 Windows 无 runner）：

```yaml
- id: bash-sandbox
  disabled: true
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: !!js dshHomePath('yanxin', 'workspace')
    timeoutMs: 120000
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: pwsh-sandbox
  disabled: true             # 关掉 pwsh，避免两套语法混用
```

**⚠️ 上面这段是 2026-09-25 的**提案**，不是落地产物。两处按现在这样抄会出事（2026-10-02 复核）：**

1. **`cwd: !!js dshHomePath(...)` 从未核实**：`dshHomePath` 在本仓与已安装的 `@deepseek-ai/*` 包里**都查不到**，`cordis.patch.yml` 也从未用过 `!!js` 标签（base 里用过 `!!js process.platform`，但那是上游的文件）。落地时 `cwd` 被推给了 profile 的 patch（`cordis.patch.yml:306`："`cwd` 属于部署配置，ADR 0004"），**bundle 里的 `bash` 行只有 `timeoutMs` 与 `maxOutputBytes`**。
2. **`- id: bash-sandbox / disabled: true` 这一行本仓从来没写过**。真实生效的是 base 的**平台门**（`disabled: !!js process.platform === 'win32'`，base `cordis.patch.yml:178-181`）—— 见 §7.4-C。

**因此 `ctx.shell` 的落点现在无人可证**：执行器的取值是
`workdir: request.workdir ?? this.config.cwd ?? process.cwd()`（`dsh-bash-local/lib/index.js:170`），
即**profile patch 没配 `cwd` 时，命令跑在进程当前目录**。§7.4-B 据此改写。


**前提**：DSH 必须在 **Git Bash 中启动**，否则 `bash` 可能不在 PATH 上。开发机上 Git 装在**非系统盘**，
`C:\Program Files\Git\bin\bash.exe` 这条"标准路径"并不存在 —— 所以任何探测逻辑都**不得硬编码盘符**。
这一点必须写进启动脚本与 README。

**Tier 2（Tier 1 失败则执行）**——自建 `@yanxin/shell-gitbash`，实现 `@deepseek-ai/dsh-shell` 的 `ShellExecutor` 接缝，**以 `dsh-pwsh-local` 为模板**（它是同一个 seam 的 Windows 实现，自述为 bash-local 的 "call-for-call mirror"）：

```ts
protected argv(spec: ShellExecSpec): string[] {
  return [this.bashPath, '-c', spec.command]
}
// bashPath 由 resolveBashPath(configured, env, platform) 纯函数解析：
//   显式配置 → 环境变量 → 各平台的 Git 安装位置（**不假设盘符**）→ PATH → 裸 'bash'
```

Tier 2 免费继承 bounded output / spill 文件 / timeout 与 cancel 分类 / tree-kill / `ctx.jobs` 集成。注意 `ctx.shell` **只能有一个 provider**（"mounting both fails loud on a duplicate service registration"），所以 Tier 2 是**替换**而非并存。

**明确不做**：不改用 pwsh（用户已选 bash）；不 fork `dsh-bash-local`（上游不接受 PR，按 seam 自建更轻）；不自行 `child_process` 起 Git Bash（会丢掉 bounded output / spill / timeout 分类 / tree-kill / jobs / credential scrub，净损失）。

**✅ Tier 1 已实测通过（ADR 0009）**：`tests/integration/shell-tier1.spec.ts` 11 条断言全过（bash 解析 / `$BASH_VERSION` + `uname -s` 证明是 bash 而非 cmd / stdout-stderr 分离 / 非零退出码 / 超时与 abort 分类 / workdir / 超大输出截断 + spill）。**Tier 2（T5b）因此降为"仅在上游升级导致回归时启用"。**

**运行前提（硬约束）**：Tier 1 依赖 `bash` 在 PATH 上 —— **DSH 必须在 Git Bash 中启动**。
开发机上 Git 装在非系统盘，所以探测逻辑**不得硬编码盘符**。测试里已把这条做成**显式诊断**（首条断言即 `command -v bash`）。

**⚠️ `ctx.shell` 的 API 是两步（实测发现，写代码时容易错）**：

```ts
const spec = ctx.shell.resolve(request)   // 填默认值：workdir / timeoutMs / stdoutMaxBytes / sandboxPolicy
const result = await ctx.shell.run(spec)  // run 只接受【已 resolve】的 ShellExecSpec，不是 request
```

`run()` 传原始 request 会通过类型检查失败暴露，但若用了 `as any` 就会变成运行时的
`deadline timeoutMs must be a positive finite number`。本项目所有 shell 调用都走一个包两部的助手。

**审计（用户决策：危险命令只审计不确认）**：写 `$DSH_HOME/yanxin/audit/shell.jsonl`：时间、账号、会话、命令、exit code、耗时、输出字节数、危险等级标记。**不打断执行。** DSH 自带的 `ctx.approval`（`ask` / `allowed-once`，fail-closed）**不启用**——我们的策略是"进得来就全权 + 全量留痕"，而不是"每次都问"。

**⚠️ 覆盖面与四取值口径（2026-10-02 复核后重写；此前这段写的是"愿望"）**

- **判据是"名字像执行器 + 参数里有命令文本"**，不是"工具名等于 `bash`"：`src/audit/shell-record.ts` 的
  `executableCommandOf()` 认 `^bash$` / `^pwsh$` / `^exec$` / `^terminal$` / `^mcp__`，命令串取
  `command` / `cmd` / `script` 三个键。理由同 §7.4-A：MCP 工具**绕过 preset 的能力裁剪**（ADR 0005），
  只认 `bash` 等于给"执行"留一条不留痕的路。`tool` 字段记**真实工具名**。
- **命令**：过 `redactSecrets` 后的形态，不是逐字节原文（被改过时同时写 `commandRedacted: true`）。
- **输出字节数**：**带内**长度。超过 `maxOutputBytes` 的部分 DSH 写进 spill 文件，所以
  `truncated.stdout` 为真时这个数**小于**真实输出，全量大小我们看不见（只有 `spillPath`）。
- **耗时**：我们自己量的墙钟差（`ToolExecutionResult` 没有 duration 字段），`pre-execute` 没 fires 时为 `null`。
- **工作目录**：只有 `requestedWorkdir`（调用方**要**的那个），**没有**"真正跑在哪"——
  那是执行器内部的 `config.cwd ?? process.cwd()`，工具接缝上不可见。
- **落盘失败不再静默**：`writeAudit` 仍然**永不抛**（审计不能拖住执行），但会把错误交给调用方
  `logger.warn` 出来 —— 静默失败的审计器和根本没有审计器，症状一模一样。
- **危险等级只是标签，零阻断**（`src/audit/danger.ts`）。

危险模式清单（仅用于审计打标，不用于阻断）：`rm -rf`、`sudo`、`ssh `、`curl `、`wget `、`mkfs`、`dd if=`、`chmod 777`、`git push --force`、`npm publish`。

### 6.11 初始化流程（setup 服务 + Web 向导）

**setup 是一个状态机服务**（`ctx.setup`），Web 向导只是它的前端（CLI 后续可挂同一服务，不重写）：

```
init ──▶ persona ──▶ background ──▶ world ──▶ accounts ──▶ ready
 │         │             │            │          │
 │      导入人格     补充背景资料   创世       绑定账号
 │      写入 templates/persona-*.md 的副本到 $DSH_HOME/yanxin/persona/
 │      创世：persona/world.md → 结构化初始实体（内核校验后提交）；写 clock.json（T0 纪元）
 └─ 未初始化时，Agent 模式拒绝启动（避免用空人格跑起来污染记忆）
```

产出全部落盘到 `$DSH_HOME/yanxin/` 与 `$DSH_HOME/.agent-presets/`。**状态落盘**，所以中途关闭浏览器可续。

`ready` 之后 setup 服务不消失——控制台可随时回退到任意步骤重跑（例如换人格、重建世界）。

### 6.12 控制台（`/yanxin`）

用 `ctx.webServer.register({ kind: 'prefix', path: '/yanxin', handler })` 自建页面 + 自己的 HTTP 接口，**不依赖 apiproxy 白名单**，不 fork 上游。

`WebRoute` 签名（`packages/host/webserver/src/index.ts`）：

```ts
export type WebRouteKind = 'exact' | 'prefix'
export interface WebRoute {
  kind: WebRouteKind
  path: string                                              // 绝对路径，无尾斜杠
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
register(route: WebRoute): () => void
```

**⚠️ `register()` 返回 disposer 但不是 effect** —— 要让它在插件卸载时自动回滚，必须自己包一层：`ctx.effect(() => ctx.webServer.register({...}))`。重复注册同一 `(kind, path)` 会 **throw**。

功能（全功能）：

| 页面 | 内容 | 数据来源 |
|---|---|---|
| 首页 | **仪表盘**：一句话状态 + 消息统计（今天收到/触发/回复/触发率、累计、近 7 天趋势、最热闹的群） | 消息统计 SQLite（桥记账）+ `ctx.window` / `ctx.world` 软查 |
| 设置 | 人格、背景资料、世界定义、Bot 定义 | `$DSH_HOME/yanxin/*` 文件；可写 |
| 管理员 | 管理员 QQ 名单增删 | `ctx.settings`（`ctx.admin` 命名空间） |
| 时段 | World 窗口（默认 14:00–18:00），多窗口/跨天 | `ctx.settings`（`ctx.window` 命名空间） |
| 世界 | 只读视图（当前 TU、T0 纪元、事务数、她的笔记）**+ 两个运营开关**：引擎启停（`yanxin-window.paused`）与响应群号（`yanxin-world.worldGroupId`，下一句话生效） | 内核只读视图 + settings；开关的边界见下 |
| 记忆 | 检索 + 结果浏览（含溯源 session） | `ctx.memory.search()` |
| 对话 | 会话列表 + 事件时间轴（调试用） | `ctx.sessions` |
| 日志 | 实例运行日志的**实时流**（SSE；打开补尾部，之后增量推送） | 系统临时目录下最新的 `yanxin*.log`（行 config `logFile` 可钉死） |
| OneBot 连接 | 监听地址 / 端口 / access token / 升级路径 / 心跳与调用超时，**改了不用重启**；账号注册表只读 | `ctx.settings`（`yanxin-onebot`，三级回退见 §7.4-A 的"豁免范围"）+ `ctx.onebot.listenPoint` |
| 初始化 | 向导（§6.11） | `ctx.setup` |

**导航是左侧垂直标签栏**（2026-10-02），当前页 `aria-current` 高亮；当前页的判定来自
浏览器 location（不是服务端数据），不破坏"数据不进标记属性"的纪律。

**消息统计（SQLite）**：Node 内置 `node:sqlite`（零依赖）。记账点在**桥**——收到记 `in`
（带"触发了没有"），发送成功才记 `out`；表里只有计数/方向/长度，**不存正文**（内容在
会话与 ReMe，这里是账本）。桥写、控制台读同一个 `$DSH_HOME/yanxin/stats.db`
（WAL 多连接）；SQL 全部参数绑定；库打不开只限频告警，收发照常。

**运营开关与"只读世界"的边界**：控制台依旧**没有**任何改世界内容的入口（改世界只能走
内核的"提案 → 校验 → 提交"）。世界页的两个表单改的是**运营配置**（引擎启停 / 群号），
与时段页同性质，走 settings 持久化写路径，自动进控制台审计。`yanxin-world` 命名空间
挂在**常驻的 console 服务**上（引擎行会随窗口卸下，fiber 注销会带走它名下的 settings
注册——挂引擎上等于世界一停就改不了群号）；引擎用 `settings.get()` 只读（未注册返回
undefined，装载顺序无关紧要）。

**实时日志为什么走 SSE**：日志页的流需要服务端**持有响应**持续推送，绕过一问一答的
`serveApi` 形状（那条路只出 JSON）。`GET /yanxin/api/log/stream` 每 1.5s 推增量
（JSON 帧，过出口脱敏），浏览器 `EventSource` 断线自动重连，客户端保留最近 400 行。

**`ctx.settings` 用 `register(ns, schema, options)` 注册**（`SettingsScope<T>` 有 `get/watch/update/replace`）——即使不进 DSH 原生设置页，**编程读写完全可用**，我们的 `/yanxin` 页面自己渲染。

**安全**：
- 只绑 `127.0.0.1`。⚠️ **这条不是"沿用上游默认"**（原句"与 `@deepseek-ai/dsh-host-webserver` 的默认一致"是错的，2026-10-02 复核）：上游的 `host` 是**必填** union `127.0.0.1 | 0.0.0.0`，**没有默认值**（`dsh-host-webserver/lib/index.js:141`，`server.listen(port, host)` 在 `:296`）。所以"绑回环"完全靠**我们的 config**（`cordis.patch.yml:32`）+ **我们自己的运行期门禁**（`isLoopbackAddress` 拒非回环，`src/console/index.ts:222`）。profile patch 可以把 `host` 改成 `0.0.0.0`，那时只剩第二道门。
- 控制台能改**管理员名单** = 权限提升面。因此：**写操作必须带 token**（`YANXIN_CONSOLE_TOKEN` 环境变量），只读页面可不带。
  ⚠️ **例外（2026-10-02 补）**：**实时日志流按写操作对待** —— 它推的是运行时日志原文，出口脱敏只抹得掉"认得出的密钥形态"（§7.4-D 表）。
  "只读页面可不带"这条纪律本身保留，settings 页因此仍免凭据 —— 那是 §11 R1 待你拍板的设计取舍，不是漏洞。
- 所有写操作记审计日志。

**⚠️ 实测约束：改 provider 后必须重启**（ADR 0004）
`dsh-llm-pi-ai` 的 settings 是热重载的，但**模型注册表在启动时构建并缓存**——改完 `settings.yaml` 的 provider 路由后，未重启时模型列表仍是旧的。因此控制台**不能承诺"改完立即可用"**：修改 provider 后必须提示重启，或由控制台触发一次受控重启。

### 6.13 session 与溯源

**会话命名空间**（`sessionIdFor`，`src/onebot/session-trigger.ts`）：`agent:<selfId>:group:<gid>` /
`agent:<selfId>:private:<uid>` / `admin:<uid>` / `world:<selfId>`。
mode 编进 id 前缀，所以"一场景一模式"是**命名层面**的保证 —— 同一会话不可能跨模式复用（群聊会话永远是群聊姿态，私聊会话永远是助理姿态）。

**⚠️ 溯源不用自定义 session 事件**（原设计被证伪，见 [ADR 0012](decisions/0012-provenance-via-message-source.md)）：

持久化的**读取**路径会**硬拒**未知事件类型 ——
`packages/session/session-persistence/src/coordinator.ts` 的 `assertEventsSupported()` 是
**`throw`**，不是 warn；而 `ignorable: true` 这条逃生门**当前没有任何 writer 能设置**。
所以写 `'yanxin/provenance'` 的后果链是：**写进日志（写路径不查）→ 重启 → resume 抛错 →
该会话永久不可读**，而 `persistence.list()` 仍列得出它 → bridge 每次都走 resume 分支、
每次都失败 → 那个群 / 那个人**彻底失联**。

**实际做法**：溯源挂在官方**已开放**的扩展点 `MessageSourceMap` 上（`src/onebot/provenance.ts`）：

```ts
declare module '@deepseek-ai/dsh-llm' {   // ← 主入口，不是 /message 子路径
  interface MessageSourceMap {
    qq: QqMessageSource   // { kind: 'qq'; userId; groupId?; mode; account }
  }
}
```

它的文档原话是 "Merge-extensible sum type — **plugins add their own `kind`s**"，
monorepo 里有 **11 个包**在这么做（`skill` / `goal` / `subagent` / `commands` / …）。
宿主事件 `user/message` 是**已知类型**，所以整条路都不碰 `KNOWN_SESSION_EVENT_TYPES`，
溯源**随消息本身**一起落盘、一起 resume。

**读历史**：`session.seq` / `session.header` / 事件读取走 `src/onebot/session-api.ts`
的适配层（两条版本线形态不同，见 ADR 0011）；持久化屏障 `ctx.sessions.flush(session)`。

因为能力靠 preset 隔离，**发送者身份不参与安全判定**，只用于审计与溯源 ——
即使 `source` 被伪造，也换不到 shell（而 §6.10 的隔离当前另有问题，见该节的警告）。

---

## 7. Code Style

### 7.1 一个真实的 DSH 插件（本项目的标准形态）

```ts
// src/memory/service.ts
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { z } from 'schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

export interface MemoryProvider {
  search(query: string, limit: number): Promise<MemoryHit[]>
  record(trajectory: Trajectory, sessionId: string): Promise<void>
  consolidate(): Promise<void>
  health(): Promise<{ ok: boolean; detail?: string }>
}

/** 记忆是增强而非依赖：provider 挂了不能让对话挂掉（论文 §6.1 之外的工程纪律） */
export class MemoryService extends Service {
  static readonly name = 'memory'
  static readonly inject = ['credentials', 'timer']   // 依赖声明即能力请求

  static readonly Config: z<MemoryService.Config> = z.object({
    provider: z.union(['reme'] as const).default('reme'),
    endpoint: z.string().required().description('provider 的 HTTP 端点，仅允许回环'),
    searchLimit: z.natural().default(5).description('单次召回条数'),
    requestTimeoutMs: z.natural().role('ms').default(10_000),
  })

  private provider: MemoryProvider

  constructor(ctx: Context, public config: MemoryService.Config) {
    super(ctx, 'memory')
    this.provider = createProvider(config)
    // 注册即 effect：插件卸载时反注册自动回滚
    ctx.effect(() => ctx.on('session/flush', () => this.drain()), 'memory.drain')
  }

  async search(query: string): Promise<MemoryHit[]> {
    try {
      return await this.provider.search(query, this.config.searchLimit)
    } catch (error) {
      this.ctx.logger?.warn('memory search failed, degrading to empty: %s', error)
      return []                                  // 降级：不抛
    }
  }
}

export default MemoryService
```

### 7.2 约定

- **⚡ 硬规则：插件模块要么只用命名导出，要么只 `export default`，绝不同时。**
  实测（ADR 0004）：同时写 `export const inject = ['agentPresets']` 与 `export default apply` 时，`default` 导出（裸函数）优先，模块命名空间上的 `inject` 被**静默丢弃**，运行时才以 `cannot get property "..." without inject` 暴露，极难定位。同理适用于 `name` 与 `Config`。
- **命名**：服务类 `XxxService`，文件同名小写；服务 key 单数名词（`memory` / `onebot` / `world` / `window` / `admin` / `setup`）。
- **模块**：全 ESM；每个服务用 `declare module '@deepseek-ai/cordis'` 增强 `Context`（**不是 `'cordis'`**，这是 fork 的改名点，`docs/rescope.md` 是权威映射表）。
- **配置**：一律 `schemastery` 的 `z.object`；必填显式 `.required()`；给 `.description()`（DSH 设置页与我们的控制台都会读）。
- **副作用**：任何上下文变更走 `ctx.effect` / `provide` / `set`，**返回反注册闭包**。
- **注释**：只解释"为什么"。**引用 DSH/论文结论时写明文件路径或章节号**，这是本项目的可追溯性要求。
- **⚡ 私有字段：必须用 TS 的 `private`，不能用 `#field`。**
  实测（ADR 0007）：cordis 的 `createTraceable` 会把服务值包进 Proxy 做追踪，且对 getter 走 `Reflect.get(target, prop, shadow)`、对方法走 `createShadowMethod(...)`——**两者都以替换过的 receiver 调用成员**。`#private` 的品牌检查要求 receiver 就是声明它的实例，于是必然抛 `Cannot read private member ... from an object whose class did not declare it`。TS 的 `private` 编译后是普通属性，运行时被擦除，不受影响。DSH 自己的服务（如 `SettingsProvider`）也全部用 TS `private`。
- **⚡ 服务实例字段的命名：先看基类有没有同名私有字段。**
  TS 的 `private` 是名义的，子类无法"覆盖"父类私有成员——**同名即编译错误**（`Types have separate declarations of a private property`）。实测：我们想给内存 settings provider 的字段叫 `document`，而 `SettingsProvider` 基类已有一个 private `document`。
- **⚡ `ctx.settings` 的命名空间格式：只用小写字母、数字、连字符 —— 点号不合法。**
  受 `SettingsNamespaceInput` 约束。写 `'yanxin.admin'` 会被推断成 `never`，报 `Argument of type '"yanxin.admin"' is not assignable to parameter of type 'never'`——**错误信息完全没提命名空间格式**，极易误判。正确写法是 `'yanxin-admin'`。
- **⚡ 读外部结构（session 事件、MCP 帧、协议字段）必须走带 fail-loud 的适配层，不要直接写成员名。**
  实测（ADR 0011）：本仓的**类型**来自 npm 的 `@deepseek-ai/dsh-session@0.1.5-rc.3`（有 `snapshotEvents`），
  而**运行时**是从 monorepo 解析到的 `packages/core/session@0.1.0-rc.5`（有 `get events()`）——**两者互斥**。
  于是 `tsc` 全绿而运行时 `snapshotEvents is not a function`。跨版本线 / 跨仓的边界要有
  `src/onebot/session-api.ts` 那样的适配层：两条已知形态都支持，**都不匹配时抛错**，并把实际的
  prototype 成员名写进错误信息。**绝不用"返回空数组/默认值"掩盖形态变化** —— 那会把 API 漂移
  伪装成"模型这轮没说话"，正是 ADR 0010 记过的那类静默失败。
- **⚡ session id 是确定性的，所以冷启动必须 `resume` 优先，不能无脑 `create`。**
  实测（ADR 0011）：`dsh-base` **无条件**装载 `session-persistence-jsonl`，而 bridge 的 session id
  由 `sessionIdFor` 按群/人算出来（重启后不变），因此对磁盘上已存在的 id 调 `agents.create` 会被拒：
  `already has a persisted log on disk that does not match this live session (id collision)`。
  冷路径必须是「`persistence.list()` 按 id 找得到 → `agents.resume`；否则 → `agents.create`」，
  判定方式照抄官方 `packages/api/remotes/src/agent-lookup.ts` 的 `inspectApiRemoteSession`。
  **不用**"resume 失败就 create" —— 那会把 setup/preset 的真实错误误判成"没有日志"，静默降级成新会话。
  附带纪律：`resume` 时同样要在 `setup` 里 `mount` preset（resume 组合的是 **fresh scoped world**）。
- **版本**：`package.json` 里所有 `@deepseek-ai/*` 写**精确版本**，禁用 `^`/`~`/`latest`。
  ⚠️ 但精确版本**只保证类型一致，不保证运行时一致** —— 见上面第一条：从 monorepo 启动 CLI 时，
  bundle 会解析到 monorepo 的 `packages/<包>/lib`，与 `node_modules` 里那份是两条版本线。

### 7.3 反例（不要这样写）

```ts
// ✗ register 返回 disposer 但不是 effect —— 插件卸载后路由还在，重复注册会 throw
export function apply(ctx: Context) {
  ctx.webServer.register({ kind: 'prefix', path: '/yanxin', handler })
}

// ✓ 包一层 effect，卸载自动回滚
export function apply(ctx: Context) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/yanxin', handler }))
}
```

```ts
// ✗ patch 想只改 config 里一个键 —— 做不到，整字段覆盖
// - id: agent-presets
//   config:
//     includeUserRoot: false        ← 这一行会把整个 config 换掉，踢掉 DSH 的 system root

// ✓ 要么重写完整 config，要么干脆不碰（我们选放到 user preset root，见 §6.1）
```

```ts
// ✗ 直接发消息：发射型副作用，effect 撤不回
ctx.effect(() => {
  void sendGroupMessage(gid, text)
  return () => {}                   // 假的反滚
})

// ✓ 经 outbox，提交后才发射
await ctx.world.outbox.enqueue({ gid, text })
```

```ts
// ✗ export default 与命名导出混用 —— inject 被静默丢弃（ADR 0004 实测）
export const name = 'my-probe'
export const inject = ['agentPresets']   // ← 这一行不会生效！
export async function apply(ctx) { await ctx.agentPresets.list() }
export default apply                      // ← default 优先，模块契约被绕过

// ✓ 只用命名导出
export const name = 'my-probe'
export const inject = ['agentPresets']
export async function apply(ctx) { await ctx.agentPresets.list() }
```

```ts
// ✗ 直接写成员名读外部结构 —— 类型能过，运行时可能没有（ADR 0011）
const turn = extractAssistantTurn(agent.session.snapshotEvents(firstSeq), firstSeq)

// ✗ 用默认值掩盖形态变化 —— 把 API 漂移伪装成"模型这轮没说话"
const events = agent.session.snapshotEvents?.(firstSeq) ?? []

// ✓ 走适配层，两条已知形态都支持，都不匹配就 fail-loud
const turn = extractAssistantTurn(readSessionEvents(agent.session, firstSeq), firstSeq)
```

### 7.4 安全约束（必做验收项）

**A. 服务端 URL 请求守卫**

**适用面（2026-10-02 如实收窄）**：`web_fetch` 的 `url`，**加上**任意工具参数里键名为
`url` / `urls`（不区分大小写、深度 ≤6）的字符串值 —— `src/net/url-guard.ts:41-47`。
**不覆盖**：`uri` / `endpoint` / `webhook_url` 这类异名参数（实测直接放行），以及第 7 层往下的嵌套。
这一条本来就是"覆盖已知形态 + 对未知 MCP 工具尽力"的判据，不是"任何出网都过守卫"。

1. 仅允许 `http:` / `https:`；其余协议（`file:` / `ftp:` / `gopher:` / `data:` 等）一律拒绝。
2. 发请求前解析 host，**拒绝**：`localhost`、`*.localhost`、回环（`127.0.0.0/8`、`::1`）、私有（`10/8`、`172.16/12`、`192.168/16`、`fc00::/7`）、链路本地（`169.254/16`、`fe80::/10`）、保留/多播/未指定（`0.0.0.0/8`、`224/4`、`240/4`、`::`）、云元数据端点（`169.254.169.254`）。
3. **对域名先解析、再对解析出来的地址判定**（防域名指到内网）；解析失败即拒绝（fail-closed）。
   ⚠️ 原第 3 条后半句"且**每一跳重定向后重新校验**"**做不到**，见下面"重定向的真实归属"。
4. 限制：`maxRedirects ≤ 3`、体积上限、超时；响应体流式截断。
5. 目标是 IP 字面量时直接对字面量校验。
6. ~~**域名必须先 DNS 解析、再对解析结果校验**（防解析到内网）；解析失败即拒绝。~~ —— 与第 3 条重复，合并进第 3 条。

**⚠️ 为什么这个守卫是强制的而不是可选的（ADR 0005 实测）**：DSH 自带的 web 抓取 provider **明确不做私网防护**——

```
packages/web/web-fetch-http/src/provider.ts:6
  "Private-network and SSRF protection is not implemented; do not enable this provider where..."
packages/web/web-fetch-http/src/policy.ts:18
  "(SSRF / private-network blocking is deferred — see the package Agent Note.)"
```

它只做传输卫生（仅 http/https、拒 URL 内凭据、长度/字节/字符/超时/跳数上限、**仅同源重定向**）。私网目标是它照发的。

**实现状态**：`src/net/url-guard.ts` 已实现并实测通过——`web_fetch https://example.com` 成功；`web_fetch http://127.0.0.1:3080/` 被拒，且工具耗时未增加（**派发前即拦下**）。挂载点 `tools/pre-execute`（DSH 官方认定 per-call 策略属于该层）。

**2026-10-02 复核：判定的实际强度（比第 2 条写的更多，也有两处不到）**

- **超出本清单的段**：CGNAT `100.64/10`、`192.0.0/24`（含 `192.0.2/24` 文档段）、`198.18/15` 基准测试、`fec0::/10` 站点本地、`ff00::/8` 多播；主机名 additionally 认 `*.local` / `*.internal` / `*.home.arpa`。
- **IPv4-in-IPv6 的四种封装都按"里面那个 IPv4"判**，且有回归：`::ffff:a.b.c.d`（IPv4-mapped）、`::a.b.c.d`（IPv4-compatible）、`64:ff9b::/96`（NAT64 知名前缀）、`2002::/16`（6to4）。这一条不是纸面功夫——WHATWG 的 URL 解析器会把 `[::ffff:169.254.169.254]` **归一化成 `[::ffff:a9fe:a9fe]`**，只认点分字符串的判定等于没判。
- **十进制 / 八进制 / 十六进制的 IPv4 字面量**（`2130706433`、`0177.1`、`0x7f000001`）实测**被拦**，但成因要说清：是 URL 解析器把它们归一成点分形态 + `isBlockedIpv4` 的"分组数不是 4 就 fail-closed"（`:65`）合起来挡的，**不是**守卫自己认得这些进制。这类**没有测试**，上游解析器一换形态就可能回归。
- ❌ **两处不到**：① Teredo `2001::/32` 没进判定，且任意 global-unicast 地址**低 32 位里嵌的 IPv4** 不会被当作 IPv4 读 —— 实测 `http://[2001:0:0:0:0:0:c0a8:1]/`（= 192.168.0.1）**放行**；可达性低（要 Teredo 中继或站点路由），但"所有 IPv4-in-IPv6 形态都已覆盖"这句**不能写**。② `64:ff9b:1::/48` 的位置是**猜测**（RFC 8215 明确说不保证），ADR 0017 已记录其放行窗口。

**重定向的真实归属（原来那句"每一跳重新校验"是错的）**：守卫是 `tools/pre-execute` 上的**无状态纯判定**，只看得到**起始 URL**；重定向发生在 provider 内部，我们那一层看不见（`tests/unit/url-guard.spec.ts` 的 F 组早就写明了这一点，是 spec 正文没跟上）。实际拦下"跳到内网"的是**两件别人的东西**：provider 的**仅同源重定向**策略（跨源直接抛 `WEB_REDIRECT_BLOCKED`，`web-fetch-http/src/policy.ts:43-54`）+ patch 里的 `maxRedirects: 3` / `maxResponseBytes` / `timeoutMs`（`cordis.patch.yml:278-281`，由 `tests/unit/bundle-patch.spec.ts:108-112` 断言）。**本仓没有、也无法有"每一跳"的代码**。同理第 4 条的"响应体流式截断"完全在 provider 里，我们只是配了上限。

**残留风险（诚实记录）**：我们解析 DNS 判定后，provider 会**再次解析并连接** → 理论上存在 DNS rebinding 时间窗。彻底关闭需要 provider 支持"解析后锁定 IP"，超出我们的接缝能力。

**⚠️ 挂载点冗余（复核发现，未修）**：`url-guard` 在 host 平面（`cordis.patch.yml:62`）**和三个 preset 各注册一次**（`presets/*/agent.cordis.yml:146/146/184`），于是每次出网**跑两遍判定、写两条 `allow` 审计**。这与本仓给 `shell-audit` 只挂 host 平面的理由直接矛盾（`cordis.patch.yml:68-72`："三个 preset 各挂一份 = 同一份日志被写三遍"）。**没有安全后果**（幂等判定），有审计可读性后果。留作待办。

**豁免范围（明确界定）**：由**运营者写定**的基础设施端点——ReMe `endpoint`、LLM `baseURL`——不是用户输入，**不受本守卫约束**，但必须：只绑回环、在控制台明文标注、且不允许被 LLM 通过工具参数改写。

⚠️ **OneBot 反向 WS 是这一条里唯一"运营者可以改绑定"的例外**：它的 `host`/`port`/`path`/`token`
提到 settings 的 `yanxin-onebot`（取值顺序 settings → 行 config → 代码默认），控制台 OneBot 连接页能改，
**不用重启**。"只绑回环"因此从一句静态纪律变成一个**运行期门**
（`src/onebot/transport.ts` 的 `validateTransportInput`，**服务端判据**，浏览器提示不算门）：

1. **确认门** —— 改成非回环（`0.0.0.0` / `::` / 网卡 IPv4）必须带 `confirm_public=true`。
2. **凭据门** —— 非回环时**必须有 token**。这个端口没有别的东西在守：token 一空，任何能连上它的人都能
   **冒充她的客户端**（推假事件、拿到回发目标），而本条守卫管不到那条路（它只管 harness 自己发起的请求）。

认不出的地址一律**按对外处理**（fail-closed）；收紧方向（改回回环）不设卡 —— 单向摩擦是故意的，
两头都拦人会绕去改文件。换绑的实现选**先听新的、再关旧的**：端口被占是最常见的失败，
反过来做会落得"旧的关了、新的起不来"，而她连不上、控制台也看不出发生了什么。
`accounts`（selfId → preset）**不在这一层**：那是能力构成，仍然只在 profile patch 里，本页只读显示。

**B. shell（用户已确认：仅管理员可运行 + 危险命令只审计不确认）**

- **能力隔离优先于运行期判定**：shell 工具行只存在于 `xiaoyan-admin` preset；`xiaoyan-agent` / `xiaoyan-world` 的 preset 里**没有这一行**。
  **✅ 2026-10-02 全链复核成立**（这是本项目最要紧的一条隔离，值得写清证到哪一步）：
  agent 声明 3 行（`persona` / `tool-web` / `url-guard`）、world 4 行（多一个 `world-tools`）、
  admin 15 行；base 里 18 条 host 平面 `tool-*` 行与我们 patch 的 disable 清单 **1:1 对上**；
  扫过 base 引用的每一个包，未被 disable 的**没有一个 `ctx.tools.register`** ——
  所以 `dsh-bash-local` 那行是"只提供者、不出工具"，agent / world 运行时拿不到 shell。
  隔离本身**有运行时断言**（读 `request/header.tools`，ADR 0013 补的那条），不只是静态读文件。
  ⚠️ 一处不能写：**"world 没有任何文件写入"是假的** —— `world_note` 会写
  `$DSH_HOME/yanxin/world/notes/<标题>.md`（限定目录 + 净化文件名，`src/world/notes.ts:55-62,94`）。
- 每条**执行类**调用写审计日志（覆盖面与取值口径见 §6.10，2026-10-02 已扩到 MCP 工具）。
- ⚠️ **原来这条写的是"`cwd` 强制为 `$DSH_HOME/yanxin/workspace/`，启动时校验真实路径（解析符号链接后）仍在允许根内"——做不到，且不该由这一层做。2026-10-02 复核的三条理由：**
  1. **接缝上没有改写的权力**：`tools/pre-execute` 的返回类型 `PreToolDecision` 只有
     `allow` / `deny` / `ask` 三种（`dsh-tools/lib/types/index.d.ts:414-427`），上游注释原话是
     *"Input rewriting is excluded because arguments are already logged and presented"* ——
     我们既不能把 `workdir` 归一化进允许根，也不能替它填一个。
  2. **命令串自己就是逃生门**：执行形态是 `['bash', '-c', spec.command]`（§6.10），
     一条 `cd ../../.. && …` 就离开任何 workdir。**在校验命令文本之外，workdir 校验不构成边界。**
     为了"看起来有边界"去正则筛命令串，正是本项目一直拒绝的语言级检查（见 C 末）。
  3. **`config.cwd` 只是默认值**：`workdir: request.workdir ?? this.config.cwd ?? process.cwd()`
     （`dsh-bash-local/lib/index.js:170`）—— 而 `cwd` 按 ADR 0004 属于**部署配置**，落在 git 外的
     profile patch 里，本仓既看不见也无法断言（§6.10 那段提案 yaml 里的 `cwd` 从未核实）。
  **所以实际的边界是这一句**：`cwd` 是**部署责任**，不是运行期护栏；本层只保证
  审计里有一行 `requestedWorkdir`（调用方**要**的目录），"跑在哪"由配置的人负责。
  要真正的隔离，出路只有 §7.4-C 说的容器 / 独立进程沙箱。
- 用户已选**不启用** DSH 的 `ctx.approval`（不做二次确认）。

**C. 诚实的局限声明（必须写进 README 与 ADR）**

> shell 是本机任意代码执行能力，**且未经过沙箱**。它能 `curl` 内网、能读任意可读文件。**§7.4-A 的 URL 守卫只约束 harness 自身的请求路径，对 shell 内部的出网行为无效。** 前提是：所有进入 harness 的输入源（群聊消息、网页内容、文件）都被视为可信。若要接不可信输入，必须先把 shell 迁入独立容器/进程沙箱——语言级检查不足以隔离。

**实测补充（ADR 0009）**
- **Tier 1 已在 win32 上实测通过**（11 条断言：bash 解析、命令执行、stdout/stderr 分离、退出码、超时与 abort 分类、workdir、超大输出截断 + spill 文件）。ADR 0001 里"可能连跑都跑不起来"的担心**已证伪**。
- 但 **"无沙箱"这件事一个字节都没变**：我们用的是非沙箱的 `dsh-bash-local`，`dsh-bash-sandbox` 在 Windows 上确实没有 runner。
  ⚠️ **机制要说准（2026-10-02 复核，README 与 ADR 0009 原来的写法是错的）**：不是"base profile 直接 `disabled: true`"，
  而是 base 的**平台门** `disabled: !!js process.platform === 'win32'`（base `cordis.patch.yml:178-181`）；
  而**本仓从头到尾没有写过 `- id: bash-sandbox` 的 disable 行**（`cordis.patch.yml` 里 `bash-sandbox` 只出现在注释里）。
  本机净效果相同，但含义不同：**"无沙箱"是平台条件性质，不是我们装配树里的文件级不变量** ——
  换到 Linux 上 base 会启用 `bash-sandbox`，与我们的 `bash` 行抢唯一的 `shell` provider（ADR 0001 已记录该冲突），
  base 对 `tool-bash` 的 win32 门也会同时翻回启用。**这条 spec 里不能再写成"我们关掉了沙箱"。**
- Windows ACL 沙箱即使启用也是 `enforcement: 'partial'`——官方原话："the restricted token must retain Everyone for process initialization, so external objects granting Everyone write access remain writable"。本仓连这层都不构成：`pnpm-workspace.yaml:27-28` 直接拒绝了它依赖的 FFI 包 `koffi`（连同 `node-pty`）。
- ⚠️ **约束机器仍然挂着，只是对我们失效**：base 的 `sandbox`（`:169`）、`sandbox-policy`（`:172-176`，`mode: DSH_PERMISSION_MODE ?? 'workspace-write'`、`workspaceRoot: process.cwd()`）、`fs-sandbox`（`:443`）、`approval`（`:188-191`，`policy: 'ask'`）**全部 enabled**，而我们禁用的恰好是唯一会去执法的那行 `permission`（理由见 `cordis.patch.yml:322-336`：非沙箱执行器下它拒绝加载）。**spec 与 README 都不能给读者"有某层沙箱在起作用"的印象。**
- **能跑 ≠ 安全。**

**README 落实核验（这条是 §7.4-C 自己要求的，2026-10-02 已核，同日随 README 精简改指路）**：README 的「安全须知」条目给出了同一结论的**摘要**（shell 是本机任意代码执行、没有沙箱、URL 守卫管不到 shell 的出网、要接不可信输入必须先迁容器/进程沙箱）；逐条落地情况与残留风险挪到了 `docs/development-notes.md` 第 6–8 节（那里也写明"无沙箱是平台条件性质"与"settings 页仍免凭据"）。**这条 spec 的自述是真的**，只有上面那句"直接 `disabled: true`"要改。

**运行前提（硬约束）**：Tier 1 依赖 `bash` 在 PATH 上，即 **DSH 必须在 Git Bash 中启动**（探测逻辑不得硬编码盘符）。已做成显式诊断 —— `tests/integration/shell-tier1.spec.ts` 第一条断言即检查 `command -v bash`，失败信息直接说明是环境问题及两条出路。

**D. 密钥与凭据**
- 配置只引用环境变量（DSH 的 `apiKeyEnv` credential 引用机制）；QQ 凭证、OneBot token、LLM key、`YANXIN_CONSOLE_TOKEN` 一律不入库、不进日志。
- **⚡ 硬约束：禁止把密钥内联进任何 YAML（包括 URL 查询参数）**。T0-C 实测发现 **`dsh --dump-config` 会把配置里内联的密钥明文打印**——在用户的 `$DSH_HOME/profiles/web/cordis.patch.yml` 中直接暴露了一个 MCP API key（`url: https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-dev-…`）。该 key 已泄漏进会话记录，**建议轮换**。DSH 的 `redactSecrets` 只作用于 `ctx.settings` 的 wire 视图，**不覆盖 `--dump-config`**。
- **不用 `role('secret')` 承载真正的密钥**：官方自述 `redactSecrets` "is not a proven wire boundary"，走 union/intersection/transform 的 secret 会被原样返回。密钥只走 `apiKeyEnv` 环境变量引用。
- 审计与日志同样适用：任何 `logger` 输出、审计日志、控制台响应都不得包含密钥（任务 T36 有专项检查）。

**⚠️ "不得包含密钥"的实际强度（2026-10-02 复核：机制在，但它是**模式匹配**，不是白名单）**

`redactSecrets`（`src/audit/redact.ts:17-48`）认三类：厂商前缀（`sk-` / `tvly-` / `ghp_` / `AKIA` / `AIza` / `xox` / `ya29.`）、
`Bearer …`、PEM 块，加**键名词尾**规则（`key|token|secret|password|passwd|pwd|credential`，值 ≥4 字符）与 `--token xxx` 开关形态。
所以：**没落在这些形态里的凭据不脱敏** —— 藏在路径里的 key（`/keys/abc123…/`）、4 字符以下的值、新厂商的未知前缀。
`redactValue` 是递归的（深度上限 16，`log.ts` 与 `sendJson` 两条出口都过）。以下是"经过它之后仍然会外泄"的两处，**已修一处**：

| 面 | 状态 | 说明 |
|---|---|---|
| **实时日志流** `GET /yanxin/api/log/stream` | ✅ **本轮已收口** | 原先是**免凭据读**，却把实例日志尾部 64 KB + 每 1.5s 增量推给请求方。现在它与写操作同等对待（`requiresToken(method, path)`，`src/console/logic.ts`）：不带 → 401，服务端没配 token → **403 fail-closed**。`EventSource` 不能带请求头，所以 token 只能走 `?token=` —— 这是**明知的取舍**（换来"没 token 读不到运行时原文"），别再把这个值打进日志。 |
| url-guard 的拦截日志行 | ✅ **本轮已收口** | `checkUrl` 的 reason 串里含用户可控文本（解析失败那条是整条原串）。现在 logger 出口过 `redactSecrets`，且那条 reason 折成一行 + 截 200 字符（防换行伪造日志）。**deny reason 回给模型时不脱敏**（那是调用方自己发的 URL）。测试：`tests/unit/url-guard.spec.ts` G 组。 |
| **settings 页 `/api/page/settings`** | ⚠️ **仍在（有意保留，需要你确认）** | 它把 `yanxin-*` / `llm-pi-ai` / `onebot` 等命名空间的**当前值**渲染成表（`pages/settings.ts:100-108`，值走 `brief()` 160 字符预览）。密钥形态已抹，但**端点、模型 id、端口、群号**是给任何本机进程读的。理由：§6.12 定了"只读页面可不带 token"，改了是**动设计**，不是补漏洞。要收口就把这条路径也加进 `TOKENED_READ_PREFIXES`（一行）。 |
| 首页统计（SQLite） | ✅ 干净 | 只有计数 / 触发率 / 7 天柱 / **群号**，无命令文本、无密钥（`src/console/index.ts:394-436`）。 |
| 记忆页 | ✅ 已经是对的样板 | **读也要 token**（检索走 POST，`pages/memory.ts:4-8,129`）—— 上面日志流那一条就是照它改的。 |
| 非回环请求 | ✅ 双道门 | config 把 `host` 钉在 `127.0.0.1`（`cordis.patch.yml:32`）**加**运行期 `isLoopbackAddress` 拒非回环（`index.ts:222`）。⚠️ 措辞要准：**DSH 侧 `host` 没有代码默认值**（必填 union `127.0.0.1 \| 0.0.0.0`），所以"默认只绑回环"讲的是**我们的 config + 我们自己的门禁**，不是上游默认。 |

**仓库侧密钥核查（2026-10-02）**：`git ls-files` 全量扫 `tvly-` / `sk-` / 内联 `apiKey:` / `token:` → **只有测试里的 FAKE 值**；
`spike/` 已被 `.gitignore:11` 挡住，**没有密钥进过版本库**（本包也不含 `spike/`）。
❗开发期间确有一个第三方 MCP key 因内联在 YAML 里而**泄漏进会话记录**（就是上面那条硬约束的由来）。
它属于作者的运维事项，与本包的读者无关；**你要记住的是同一条纪律：任何密钥都不要内联进 YAML**。

---

## 8. Testing Strategy

- **框架**：vitest（与 DSH 一致）。`tests/unit` + `tests/integration`。
- **层次**：
  - **单元**：纯函数与单服务逻辑（路径守卫、TU 换算、message 归一化、prompt 渲染、窗口判定、patch 解析）。
  - **集成**：真实 `Context` + 内存 loader 装配我们的插件行，断言 fiber 生命周期与 effect 回滚。
  - **契约**：MemoryService 的 provider 无关用例集。
  - **金丝雀**：真实 LLM / 真实 ReMe / 真实 OneBot 的最小冒烟，默认跳过，手动触发。
- **覆盖率**：核心层（`src/memory` / `src/world/kernel.ts` / `src/onebot/message.ts` / 守卫 / `src/window`）≥ 80%。

### 必测清单

| # | 用例 | 断言 |
|---|---|---|
| T1 | preset 能力隔离 | `xiaoyan-agent` / `xiaoyan-world` 的 preset 行清单**不含任何 shell 工具**；`xiaoyan-admin` 含 |
| T2 | 管理员私聊才有 shell | 非管理员私聊 → 会话挂 `xiaoyan-agent`，工具表里无 shell；管理员私聊 → 挂 `xiaoyan-admin`，有 shell |
| T3 | 群聊永不获得 shell | 即使管理员在群里发言，群会话挂的仍是 `xiaoyan-agent` |
| T4 | 模式启停不互扰 | 禁用 `xiaoyan-world` 后其 timer effect 全部回滚；Agent 模式 fiber 与状态**零感知** |
| T5 | 无 start/stop | 代码中不出现 `ctx.start` / `ctx.stop` / `ctx.dispose` / `ctx.fork`；模式切换只经 loader `disabled` |
| T6 | 离线补偿 | 伪造 `clock.json` 的 `lastTick` 在 6 小时前 → 激活后只发**一次**补偿 tick（`world-transactions.jsonl` 只多一条补偿事务，绝不逐 tick 重放） |
| T7 | 窗口判定 | 表驱动：14:00–18:00 内为开、窗口外为关、跨天窗口（22:00→07:00）在 23:30 与 06:30 均为开、23:59→00:01 边界不抖 |
| T8 | 发射闸门 | outbox 条目在事务提交前 OneBot 侧**零调用**（mock 断言）；提交后恰好一次 |
| T9 | URL 守卫 | 表驱动拒绝：`localhost` / `127.0.0.1` / `10.x` / `169.254.169.254` / `[::1]` / `file://`。⚠️ ~~重定向到内网~~ **无此测试，且本层测不到**（重定向在 provider 内部；见 §7.4-A"重定向的真实归属"）。跳数/体积/超时上限由 `bundle-patch.spec.ts:108-112` 断言 patch 配置，同源跳转策略归 provider。**已补的两条**：IPv4-in-IPv6 四封装（`url-guard.spec.ts` B 组）、logger 出口脱敏与折行（G 组）。**仍缺**：十进制/八进制/十六进制 IPv4 字面量（当前靠 URL 解析器归一，无测试）、Teredo `2001::/32`、异名 URL 参数 |
| T10 | 场景路由 | 群报文进 world（脚手架期 agent）姿态、管理员私聊进 admin；同一账号两种场景的会话互不串；错投率 0 |
| T11 | ~~窗口外不丢~~ | **已随 inbox 机制退役**（2026-09-26，双账号方案取消）。替代验收：窗口外被动响应照常（被 @ 能回），窗口内主动行为发生、窗口外不发生 |
| T12 | shell 审计 | 每次**执行类**调用产生一条审计日志。**✅ 2026-10-02 扩了覆盖面**：判据从"工具名 `=== 'bash'`"改成 `executableCommandOf()`（`^bash$\|^pwsh$\|^exec$\|^terminal$\|^mcp__` × 参数键 `command\|cmd\|script`），`tool` 记真实工具名 → **MCP 工具的执行不再隐身**（表驱动 13 条：`audit-logic.spec.ts` F0 组）。落盘失败从"完全静默"改成 `logger.warn` 一声（仍然永不抛、永不拖住执行）。⚠️ 字段取值口径见 §6.10：命令是**脱敏后**的、字节数是**带内**的、工作目录只有 `requestedWorkdir`。 |
| T13 | 记忆降级 | ReMe 返回 500 / 不可达 → Agent 模式仍能正常回复（search 降级为空）。**✅ 已覆盖**：`memory-degrade.spec.ts`（19 条）+ `reme-client.spec.ts` 的端到端降级（5 条）+ `memory-recall.spec.ts`（后端坏掉时对话照常） |
| T14 | 写回分离 / 召回共享 | 两模式写回的 ReMe `session_id` 不同；一次 `search` 能召回到另一模式写入的内容。**✅ 已覆盖**：`memory-recall.spec.ts`（`admin:…` vs `agent:…:group:…`；两个会话共享同一 provider）。**⚠️ 待人工**：对**真实** ReMe 跑通一次 `search` |
| T15 | webServer 回滚 | 卸载 console 插件后 `/yanxin` 路由消失；重复注册同 `(kind, path)` 抛错。**✅ 已覆盖**：`tests/integration/web-server.spec.ts`（5 条；含"不包 `ctx.effect` 则卸载后路由残留"的反例 —— 那一条证明测试真的在测回滚） |
| T16 | patch 语义 | 一个"只改 config 单键"的恶意 patch **会**整字段覆盖（回归测试，防止后来者误以为可深度合并）。**✅ 已覆盖**：`tests/unit/patch-semantics.spec.ts`（6 条，直接对 DSH 的 `applyEntryPatches` 断言 —— 官方称它是 "THE patch semantics"，与 `--dump-config` 共用同一实现） |
| T17 | setup 状态机 | 未 `ready` 时 Agent 模式拒绝启动；中途关闭可续；`ready` 后可回退任意步骤重跑 |
| T18 | 副作用纪律 | 静态检查：`src/` 下无"注册监听却不返回反注册闭包"的写法；`ctx.webServer.register` 必须在 `ctx.effect` 内 |
| T43 | OneBot 传输参数热改（§7.4-A 的例外） | **✅ 已覆盖**（56 条，三段各管一件事）：<br>· `tests/unit/onebot-transport.spec.ts`（38）—— 三级回退的顺序（行 config 不能被静默忽略）、`isPublicBindHost` 对认不出的地址**按对外处理**、两道门的四种组合、字段形态、**拒绝理由里不带 token 值**<br>· `tests/integration/onebot-transport.spec.ts`（7）—— 换 token 后旧 token 立刻 401；换端口时**已连上的那条不断且仍可调用**；⭐ **端口被占 → 保持原监听在听**（不是两手空空）；地址写错不炸；**请求值没变就不换绑**<br>· `tests/integration/console-onebot-page.spec.ts`（11）—— 门在**服务端**（curl 绕不过）、token 不出现在页面 / 回执 / 审计日志三处、一张表单不许越界改另一张的字段、服务不在时没有写入口 |

---

## 9. Boundaries

### Always
- **依赖只放自己 `import` 的东西。** 凡是"宿主的组件"一律不碰，即使看起来配套——典型反例是 `@deepseek-ai/cordis-plugin-loader` / `-include`：它们钉 `cordis ~4.0.4`，而 `dsh-*` 钉 `4.0.2`，把二者写进同一个 `package.json` 会让 pnpm **装出两份 cordis**，而同进程两份 cordis 会让符号键状态（`symbols.isolate` / `symbols.effect` / `Context.is`）判定全错（ADR 0006）。
- 一切上下文变更走 `ctx.effect` / `provide` / `set` 并返回反注册闭包。
- 每个服务显式声明 `static inject`。
- `@deepseek-ai/*` 依赖写**精确版本**。
- 引用 DSH 行为时在注释里写明文件路径；引用论文时写明章节号。
- 提交前 `pnpm typecheck && pnpm lint && pnpm test` 全绿。
- URL 守卫（§7.4-A）覆盖**起始 URL**（重定向由 provider 的同源策略 + patch 的 `maxRedirects` 负责，我们那一层看不见跳）；shell 每次执行写审计。
- `$DSH_HOME/yanxin/` 全量不进版本库；`YANXIN_CONSOLE_TOKEN` 只走环境变量。
- 控制台只绑 `127.0.0.1`（config 钉 + 运行期回环门禁双道）；**写操作与实时日志流**要 token。

### Ask first
- **升级 DSH 版本**（必须走"先更新 clone → 重核 spec → 再改代码"的流程）。
- 新增任何运行时依赖，尤其是 `@deepseek-ai/dsh-*` 之外的东西。
- 改动 bundle patch 的**行结构**或三个 preset 的**能力构成**（这是架构，不是配置）。
- 给任何 preset **新增 shell / 出网 / 写外部路径**的能力。
- 改动 `$DSH_HOME/yanxin/` 的目录布局或世界内核的文件名/事务格式（会破坏既有世界）。
- 变更 ReMe 的 `workspace_dir`（等于换记忆，不可逆）。
- 启用 DSH 的 `ctx.approval`（会改变 shell 的交互契约）。

### Never
- 提交密钥、token、QQ 凭证；把密钥内联进任何 YAML（含 URL 查询参数）—— **`--dump-config` 会明文打印**。
- 用 `role('secret')` 承载真密钥（官方自述不是可靠的 wire boundary，且不覆盖 `--dump-config`）。
- 在 `ctx.effect` 内直接发外部消息（必须经 outbox）。
- 用 `ctx.start()` / `ctx.stop()` / `ctx.dispose()` / `ctx.fork()`（本版不存在）。
- 假设 patch 能深度合并 config（它会整字段覆盖）。
- 假设 guard / `ToolExecution` 能看到发起者身份（它看不到）。
- 手工编辑 ReMe 的 `metadata/`（可重建索引区）或世界内核的 JSONL 事务日志（机器维护区）。
- 把 `register()` 的返回值当作 effect 用（它不是）。
- 删除失败的测试来让 CI 变绿。

---

## 10. Success Criteria

1. `dsh plugin --profile yanxin add ./` + `dsh --profile yanxin` 能起整套 harness；`--dump-config` 能看到合成后的装配树。
2. 三个 preset 的能力隔离成立：`xiaoyan-agent` 与 `xiaoyan-world` 的 preset 里**不存在** shell 工具行；只有 `xiaoyan-admin` 有（T1）。
3. 管理员私聊获得 shell，群聊与普通私聊**永远**没有（T2、T3）。
4. World 模式按默认 14:00–18:00 自动启停；停用期间 Agent 模式**零感知**，其 timer effect 全部回滚（T4、T7）。
5. World 跨窗口重启后只发一次补偿 tick，世界从 `clock.json` 续上（T6）；窗口外消息全落 inbox 并在激活时合并呈现（T11）。
6. 两个 QQ 账号各自连通，报文按 `self_id` 精确路由（T10）。
7. Agent 模式完成"收到群消息 → 召回记忆 → 回复"闭环；管理员私聊完成"调 shell → 审计留痕"闭环（T12）。
8. World 模式完成"Tingle 心跳 → Bot-LLM 生成 act/wait/rest → 结果按 duration 在世界时刻注入 → World-LLM 裁定并写 News"闭环；对外消息**全部经 outbox**，提交前零发射（T8）。
9. 跨模式记忆互通：World 写下的经历，Agent 白天能召回到并可溯源（T14）；ReMe 挂掉时 Agent 照常工作（T13）。
10. `/yanxin` 控制台可用：**九个页面**（初始化 / 管理员 / 时段 / 设置 / 世界 / 记忆 / 对话 / 日志 / OneBot 连接）+ 挂载根本身的仪表盘；插件卸载后路由正确回滚（T15）。
11. 初始化向导能从零走完并落盘；未 `ready` 时 Agent 模式拒绝启动（T17）。
12. URL 守卫对回环/私有/保留地址全部拒绝（T9）。⚠️ ~~内网重定向~~ —— **这一条从验收标准里划掉**：起始 URL 之外的跳转不在我们那一层（§7.4-A"重定向的真实归属"）。可达的替代验收是"patch 里确实写了 `maxRedirects: 3` + provider 只跟同源"。
13. 代码中不存在 `ctx.start` / `ctx.stop` / `ctx.dispose` / `ctx.fork`，也不存在"以为 patch 能深度合并"的写法（T5、T16、T18）。

---

## 11. Open Questions

### 已决（2026-09-25，共 11 项）

| 议题 | 决议 |
|---|---|
| 地基 | **DeepSeek Harness**（profile + bundle）；否决 cordiverse 自建与 fork-仅作库 |
| 版本 | **11 个 `dsh-*` 精确 pin `0.1.5-rc.3`**（`0.1.0-rc.5` 从未发布；`0.1.7-rc.2` 缺 `dsh-agent-presets`）；vendor 三包按各自版本线；禁用 `^`/`~`/`latest` |
| 模式共存 | 定时窗口混合：Agent 常驻，World 定时激活 |
| 账号映射 | **单账号按场景切换**（群聊=World 姿态，管理员私聊=Agent 全能力）；2026-09-26 修正，原"双账号物理隔离"退役 |
| 模式原语 | DSH **preset**（三个：agent / admin / world） |
| World 时段 | 默认**下午 4 小时（14:00–18:00）**，控制台可改 |
| TU | 同步真实时间，`1 TU = 1 现实秒`；离线只补一次 tick |
| LLM | OpenAI 兼容 + function calling；World 用 `tool_choice: 'required'` 替代 GBNF |
| **LLM 具体** | provider 路由 **`example-llm`**（`https://api.example.com/v1`，OpenAI 兼容），模型 **`example-model`**（实测无 reasoning 开销、function calling 可用）；**路由必须落在 `settings.yaml`** 而非 bundle patch（ADR 0004） |
| 记忆 | 抽象 `MemoryService`，先接 ReMe（外部 HTTP，不内嵌） |
| shell | **仅管理员可运行**，靠 preset 能力隔离（管理员私聊专用会话）；危险命令**只审计不确认** |
| Windows shell | **两级策略**（ADR 0001）：Tier 1 零代码启用 DSH 现成 `dsh-bash-local`（前提：DSH 须在 Git Bash 中启动）；Tier 2 若失败则按 `ShellExecutor` 接缝自建 `@yanxin/shell-gitbash`（模板：`dsh-pwsh-local`） |
| 控制台 | `ctx.webServer` 自建 `/yanxin` 页面（全功能七页）；不 fork 上游、不碰 apiproxy 白名单 |
| 初始化 | `setup` 服务（状态机）+ Web 向导 |
| 命名 | Bot = **小研**；Harness = **研心 / YanXin** |
| **QQ 号** | 小研机器号 `2000000002`；**`ADMIN_QQ = 1000000001`**（唯一可信者 owner） |
| **亲密层** | **归用户自建**；我不代写。架构上作为独立 opt-in 文件，群聊 preset 不含它 |
| **代码布局** | 独立成仓（本仓），经 `--patch` 的 `file://` 行加载；不住进 DSH checkout（ADR 0002） |
| **本地对话页** | 已验证跑通（`dsh --profile web`，preset `xiaoyan` + `example-llm/example-model`）；两轮人格探针通过（ADR 0004） |

### 待确认

1. **World-LLM 的模型**：Agent 模式已定 `example-model`。World-LLM 是否也用同一个？同一网关下可选 `deepseek-v4-flash-0731`，或 UI 里的 `DeepSeek` 组（`DeepSeek-V4-Flash` / `DeepSeek-V4-Pro`）。（原建议 flash/pro 分工，你未表态。）
2. ~~**账号 B 在窗口外是否断开连接？**~~ **已随双账号方案退役**（2026-09-26）：单账号常驻在线，被动响应不受窗口限制，inbox 机制取消。
3. ~~**世界定义文本**：`persona/base.md` 与 `profile.md` 已从你的文档落地；`templates/world-definition.md`（世界定义）还没有内容。~~ **已关闭（2026-09-27）**：世界定义落在 `persona/world.md`（用户口述 + 代笔），不再走 `templates/world-definition.md`；创世事务已由它生成（10 实体）。
4. ~~**Agent 模式是否需要 `web_search` / `web_fetch`？**~~ **✅ 已决并落地（2026-10-02 复核）**：要 —— `xiaoyan-agent` / `xiaoyan-world` / `xiaoyan-admin` 三个 preset **都声明了 `tool-web` 行**（`presets/*/agent.cordis.yml:141/141/179`），host 平面另插 `web-fetch-provider` = `dsh-web-fetch-http`（`cordis.patch.yml:267`）。§7.4-A 守卫以 `tools/pre-execute` 挂在**同一条 patch 的 host 平面**上，实测派发前拦下。⚠️ 但**覆盖面对不上"任何出网"**：只认 `url`/`urls` 两个参数名（§7.4-A"适用面"）。
5. **小研会话用哪个工作区？** 实测里复用了你的 `cesu`。persona preset 无工具，工作区是惰性的；但长期看应该给小研一个专属工作区（如本仓或空目录）。
   ⚠️ **2026-10-02 升级：这条不再只是"整洁问题"。** §7.4-B 复核确认 `cwd` 由 profile patch 负责、bundle 里没有，而执行器的兜底是 `process.cwd()` —— **admin 的 shell 现在跑在哪个目录，取决于 DSH 从哪儿启动**（很可能是内核 checkout 本身）。要么把 `cwd` 写进 profile patch 并**验证**（`pwd` 一次），要么在这里定下小研的专属工作区并一并解决。
6. **是否把 `example-model` 设为默认模型？** 目前 preset/模型选择不跨会话持久，每次要手选。设为默认需改 `settings.yaml` 的 `agent-default-model`（会同时影响你现有的其它会话）。

### 待实测（阻塞对应任务，不阻塞脚手架）

5. ~~**⚠️ Git Bash 沙箱可用性（最高优先级）**~~ **✅ 已实测并记录（2026-10-02 复核收口）**：`dsh-bash-sandbox` 在 win32 **没有 runner**，`dsh-bash-local` 跑通（11 条断言）。安全降级的确认可信并已告知：README「安全须知」+ `docs/development-notes.md` 第 6 节 + 本条 §7.4-C。
   ⚠️ 两处措辞在这轮被纠正：沙箱**不是我们关掉的**（base 的 win32 平台门在关，本仓从无 `bash-sandbox` 的 disable 行）；且 `sandbox` / `sandbox-policy` / `fs-sandbox` / `approval` 四行**仍然 enabled**，失效的是唯一的执法行 `permission`。**"无沙箱"是平台条件性质，不是装配树的不变量。**
6. ~~**⚠️ `@imhelper/onebot-v11` 的 v11 具体签名未逐字验证**~~ **✅ 走了预定的回退路（2026-10-02 复核）**：`@imhelper/onebot-v11` **从未被采用** —— `src/` 与 `package.json` 里没有它，只有 `ws@8.21.3`。协议层自己实现（`src/onebot/protocol.ts`：握手头 `X-Self-ID` / `X-Client-Role`、帧分类、API 帧构造；`src/onebot/service.ts`：反向 WS 服务端 + 账号注册表，ping/pong 用 WS 协议层）。已在线上跑通收/发（T10 与 `bridge.spec.ts` 28 条）。
7. ~~**`MessageSource` augment 的确切模块说明符**（`@deepseek-ai/dsh-llm/types`？）~~ ——
   **✅ 已核实（2026-09-25，T12）**：说明符是**主入口 `@deepseek-ai/dsh-llm`**（不是 `/message` 子路径）。
   依据：`packages/skill/skill/src/index.ts:155` 的官方写法就是 `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap {…} }`；
   已在本仓 typecheck 通过并落盘验证（`src/onebot/provenance.ts`）。
8. ~~⚠️ **§6.10 的能力隔离在 `yanxin` profile 下未生效**~~ —— **✅ 已修（2026-09-25，ADR 0013）**：
   host 平面的工具行需要在 bundle patch 里 `disabled: true` 才裁得掉，且 shell / web provider
   这类**服务提供者要留在 host 平面**（preset 是 per-agent 的，声明进程级单例会撞注册）。
   实测工具表从 26 个降到 2 个（群聊）/ 3 个（管理员私聊）。
8. ~~**preset 的 `agent.cordis.yml` 里能否挂我们自己的服务行**~~ **✅ 已验证（2026-10-02 复核，证据是既成事实）**：`xiaoyan-world` 的 preset 里就有 `world-tools` 一行，name 是本仓的裸路径 `yanxin/src/world/tools.ts`（`presets/xiaoyan-world/agent.cordis.yml:192`），并且世界引擎真的在线上按这条路注册动作工具。bare name 走 `$DSH_HOME/profiles/node_modules` 的 parent-walk **成立**。root 服务（memory / onebot）仍然留在 host 平面，不进 preset —— 与 ADR 0013 的分工一致。
9. **ReMe 是否会索引 `workspace_dir` 下的未知顶层目录？** 若会，把世界状态放进 ReMe workspace 就能让"世界经历"直接被 BM25 召回。**⏳ 仍未实测**（这轮没碰；ADR 0014 只核到"召回是 BM25 字面匹配、`workspace_dir` 换不得"）。
10. **API 漂移核验（任务 T0-C2）**——§13 的引用来源是 `0.1.0-rc.5`，运行时目标是 `0.1.5-rc.3`，隔 5 个 prerelease。**这是写业务代码前的硬前置**。**第一轮已完成**（见 `docs/decisions/0003-api-drift-verification.md`）：`ToolExecution` 无身份字段 ✅、`ToolGuard`/`PreToolDecision` ✅、patch 语义 ✅、`webServer.register` ✅、session augment 目标 ✅、`bash-local` 硬编码 ✅；**发现 `agentPresets.mount/list/resolve` 均返回 `Promise`（必须 await）**。
    **2026-10-02 这轮又核掉三条（都是对着已安装的 `0.1.5-rc.3` 读到的，不再是推测）**：
    ① `PreToolDecision` = `allow | deny | ask`，**没有 replace/rewrite**（`dsh-tools/lib/types/index.d.ts:414-427`，注释说明理由："arguments are already logged and presented"）—— 这条直接否掉了 §7.4-B 原来的 cwd 归一化方案；
    ② `LocalBashExecutor.Config` 里 `cwd` 是**必填** `z.string()`（无默认值），而运行期解析是 `request.workdir ?? config.cwd ?? process.cwd()`（`dsh-bash-local/lib/index.js:170`）；
    ③ webServer 的 `host` 是必填 union `127.0.0.1 | 0.0.0.0`，**上游没有安全默认值**（`dsh-host-webserver/lib/index.js:141,296`）。
    **仍未核：settings / defineTool / agentLoop / llm-pi-ai 的 providers 形状**（任务 T0-C4）。

### 待办（2026-10-02 安全复核提出；用户选"先修 P0+P1，其余记为残留风险"）

**✅ 本轮已修**：审计覆盖面（MCP 执行不再隐身）· 审计落盘失败不再静默 · 日志流纳入 token 门 · url-guard 的 logger 出口脱敏 + 折行截断。

| # | 残留项 | 性质 | 一句话出路 |
|---|---|---|---|
| R1 | settings 页对**任何本机进程**免凭据渲染配置当前值（端点/模型 id/端口/群号） | 设计取舍（§6.12 定了"只读页面可不带"），**要改得你点头** | 一行：把该路径加进 `TOKENED_READ_PREFIXES` |
| R2 | `url-guard` 在 host + 三个 preset 各注册一次 → 每次出网两遍判定、两条 `allow` 审计 | 无安全后果，审计可读性受损；与本仓给 `shell-audit` 只挂 host 的理由矛盾 | 只留 host 行，删三处 preset 行（要重跑 `build-presets.mjs`） |
| R3 | url-guard 只认 `url`/`urls` 参数名、深度 ≤6：`uri`/`endpoint`/`webhook_url` 实测放行 | 覆盖面缺口；而它存在的理由正是"守得住未知 MCP 工具" | 扩键名清单或改成"值像 URL 就判"（有误伤风险） |
| R4 | IPv6 判定漏 Teredo `2001::/32` 与"任意 global-unicast 低 32 位里的 IPv4" | 真实可达性低（要中继 / 站点路由） | `parseIpv6` 后加两条前缀分支 + 表驱动用例 |
| R5 | 十进制/八进制/十六进制 IPv4 字面量**当前被拦是靠 URL 解析器归一**，不是我们认得这些进制，且无测试 | 上游解析器一换形态就回归 | 补一组字面量用例（几行），并考虑自己解析 |
| R6 | host 平面 disable 清单是硬编码 id 列表，反向测试只断言"行数 > 10"，**从不与 base 的真实 `tool-*` 行做差集** | ⚠️ **升级即失效**：DSH 哪天多一行 host tool，ADR 0013 那个"preset 干净但 host 泄漏"的故障会静默复活 | base 是 symlink 指向本地 checkout，测试注释里"无法直接读 monorepo"已不成立 → 现在就做得起差集断言 |
| R7 | `admin` 的 shell 实际跑在哪个目录**无人可证**（`cwd` 在 git 外的 profile patch 里，兜底 `process.cwd()`） | §11 待确认 #5 因此升级为安全问题 | 在 profile patch 写 `cwd` 并跑一次 `pwd` 验证；或先定小研的专属工作区 |
| R8 | 开发期曾有第三方 key 因内联 YAML 而泄漏进会话记录（见 §7.4-D 那条硬约束的由来） | 作者的运维事项，**与本包的读者无关**；`spike/` 不在本包内 | 纪律照抄就行：密钥只走 `apiKeyEnv` / `.credentials.yaml` |

---

## 12. 附录 A：被证伪的初始假设

记录在此，避免后来者重走。**加粗的是我实际写进过 spec 又被推翻的**。

| # | 初始假设 | 实际 | 影响 |
|---|---|---|---|
| 1 | 用 `ctx.start()` / `ctx.stop()` 启停模式 | **不存在** | 改用 loader `disabled` 增量 reconcile |
| 2 | 用 ReMe workspace 硬凑"共享记忆" | 不必要——不做 isolate 的 key 天然共享 | memory 是 root 级单例 |
| 3 | 两模式各自实例化同一服务需要 isolate | 两模式提供不同 key，不冲突 | 改用 preset 目录承载模式 |
| 4 | **Cordis 是 Koishi 的** | 是 `cordiverse/cordis`（论文参考实现），DeepSeek 另有 vendored fork | 地基选型从头再来 |
| 5 | **在 `cordis@4.0.0-rc.10` 上自建** | DeepSeek Harness 已把 agent loop / tools / guard / sandbox / session / settings / llm / mcp 全写好 | 改为 DSH bundle，省掉大半实现 |
| 6 | **DSH 的 guard 能按发言者 id 判定权限** | `ToolExecution` / `Agent` **无任何身份字段**，全仓库无 `RuntimeContext` | 改为 preset 级能力隔离 |
| 7 | **DSH 控制台不能给仓库外插件出配置界面** | 只对 settings **数据面**成立；渲染走 `dsh.client` 扫描，不受 apiproxy 白名单限制 | 控制台可扩展；最终选自建页面 |
| 8 | **`@cordisjs/plugin-server-webui` 那套能复用** | 那是 cordiverse 生态，与 fork 的包名不兼容 | 排除 |
| 9 | **`dsh-schedule` 能驱动 World 窗口** | session-local、无 cron、最小 5 分钟固定间隔 | 自写窗口调度插件 |
| 10 | **数据放仓库内 `data/`** | DSH 约定运行时数据在 `$DSH_HOME`（`~/.dsh`） | 全部迁到 `$DSH_HOME/yanxin/` |
| 11 | **patch 能只改 config 里一个键** | 整字段覆盖，无深度合并 | preset 放 user root，避开覆盖 |
| 12 | Windows 上 shell 是 bash | DSH 平台门在 win32 给 pwsh、禁用 bash | 显式覆盖，强制 Git Bash（并承担沙箱待验证风险） |
| 13 | ReMe 有 `facts.jsonl` / `World_Status.md` | 那是 **YesImBot World** 的，不是 ReMe 的 | 世界状态文件我们自定义 |
| 14 | AgentScope 有 `HarnessAgent` / `ReActAgent` + `pre_reply` hook | 那些在 **agentscope-java**；Python 2.0 只有统一 `Agent` + `MiddlewareBase` | 不引入 AgentScope；DSH 自带 `ReactLoopAgent` 更好 |
| 15 | "HarnessAgent 做身份绑定和兜底" | 身份绑定是真的；"兜底"只是**模型级 fallback** | 概念修正 |
| 16 | "preset 里不写 shell 行 ⇒ 该模式没有 shell"（§6.10 的整个前提） | ⚠️ **只在装 `dsh-web-app` 的 profile 下成立**。`dsh-base` 把 `tool-pwsh`/`tool-fs`/`tool-skill`/`tool-subagent`… 注册在 **host 平面**，preset 只能往 agent 平面加、**减不掉 host 行** → `yanxin` profile 下 `xiaoyan-agent` 实际有 26 个工具，含 PowerShell，且实测真的执行了 | **✅ 已修（ADR 0013）**：bundle patch 补 disable 清单 + host 平面提供 shell/web provider，实测降到 2/3 个工具；验收补了 host 侧护栏 |
| 17 | "T7 的白名单断言证明了能力隔离" | 它只证明了 **preset 文件内容**里没有 shell 行 —— 而失效发生在 preset **之外**（host 平面）。断言本身没错，错在把它当成了运行时能力的证据 | 静态断言保留，**必须**再加一条读 `request/header.tools` 的断言（ADR 0013） |
| 18 | "自定义 session 事件类型可以随 session 一起持久化" | ⚠️ 持久化**读取**路径会**硬拒**未知事件类型（`assertEventsSupported` 是 `throw`，`packages/session/session-persistence/src/coordinator.ts`），而 `ignorable: true` 这条逃生门**没有 writer 能设置** | 溯源改走 `MessageSourceMap` 的 `qq` kind（官方开放扩展点，monorepo 里 11 个包在用）—— 见 ADR 0012 |
| 19 | "假 HTTP server 全绿 ⇒ 真实 ReMe 也认这套协议" | ❌ ReMe 的请求形状是它**自己**定的：消息要过 AgentScope `Msg` 校验（`name` **必填**），`session_id` 要能当**文件名**（不许含 `:`，而我们的 session id 是 `agent:<qq>:group:<gid>`），失败原因写在 `answer` 而不是 `metadata` | **✅ 已修（ADR 0014 决策六）**：`record` 补 `name` + 块数组 `content`、新增 `remeSessionId()` 净化、`describeFailure` 改为 answer 优先。三个坑的**症状完全一样**：召回一直空，看着像"记性差" |
| 20 | "ReMe 的错误会以非 2xx 或 `success: false`+原因 的形式暴露" | ❌ 它把内部异常吞进日志，**HTTP 始终 200**（`Msg` 校验失败、LLM 404 都是） | 判据不能只看 status/`success`，必须**同时看 ReMe 日志**（ADR 0014 验收给了五条判据） |
| 21 | "`.env` 放在 ReMe 目录里就会被读到" | 只有**一半**对：`reme start` 不读 `.env`；读它的是 `load_env()`，规则是「**cwd** 及最多 5 层父目录」。所以 `cd` 到哪决定了配置能否加载，cwd 错了 `LLM_API_KEY` 就是空 | 交付 `start-reme.cmd`，**cd 到 `.env` 子树**再启动（ADR 0014） |
| 22 | "Windows 上写 `.cmd` 用 UTF-8 存中文注释没问题" | ❌ cmd.exe 按**系统 ANSI**（zh-CN = GBK）解析 `.cmd`，UTF-8 中文被拆成乱码"命令"，**并吞掉了紧随其后的 `cd`** → 脚本静默地在错误的 cwd 里启动（正好触发 #21） | 启动脚本**保持纯 ASCII**，说明改放注释里的英文段落 / 本文档 |
| 23 | "spec §6.7 借的是 YesImBotWorld 的当前形态" | ❌ 我们借的是它 **2026 大改造之前**的形态（World-LLM 改 Markdown）。它的 `docs/structured-world.md` 开头就写："原先的『World 先讲述结果，再后台改 Markdown』已改为『提出事务 → 内核校验 → 持久提交 → 角色观测』，旧的 `update`、`send_event` 世界写入循环**已经删除**" | ✅ **已按现形态重写 §6.7**（2026-09-27，ADR 0015）：模型只提案、内核四校验（引用/类目/幂等/乐观并发）、观测投影、动作三阶段。**采纳纪律，不照抄它 26.6k 行的规模** |
| 24 | "§7.4-B 的 `cwd` 强制 + 解析符号链接后校验真实路径，是一条可实现的运行期护栏" | ❌ 三条独立的理由使它做不到：`PreToolDecision` **没有输入改写**（只有 allow/deny/ask）；执行形态是 `bash -c <命令串>`，**一句 `cd` 就离开任何 workdir**；而 `config.cwd` 只是默认值，兜底是 `process.cwd()`。写这条的人（我）把"配置项"当成了"边界" | **✅ 已降级（2026-10-02）**：`cwd` 归**部署责任**，审计里只如实记 `requestedWorkdir`；真正的隔离出路仍是 §7.4-C 的容器/进程沙箱。全仓 `realpath`/`lstat` 搜索为 0 —— **从没实现过，却被当成验收项写了两周** |
| 25 | "URL 守卫覆盖每一跳重定向"（§9 Always 与 T9 都这么写） | ❌ 守卫是 `tools/pre-execute` 上的**无状态纯判定**，只看得到起始 URL；重定向在我们看不见的 provider 内部。测试注释（`url-guard.spec.ts` F 组）一直写对了，**正文没跟上** | §7.4-A 第 3 条与 §9 改为"起始 URL + provider 同源策略 + patch `maxRedirects: 3`"；**T9 里那条"重定向到内网"用例从来不存在**，已删 |
| 26 | "只审计工具名 `bash` ≈ 每条命令都留了痕" | ❌ MCP 工具**绕过 preset 的能力裁剪**（ADR 0005 早就写了这条），却从没被挪用到审计的判据上 —— 于是 `mcp__*__run_command` 执行完什么都不写 | **✅ 已修**：`executableCommandOf()` 按"名字像执行器（`bash\|pwsh\|exec\|terminal\|^mcp__`）+ 参数里有命令串（`command\|cmd\|script`）"判定，`tool` 记真实名字（§8 T12） |
| 27 | "控制台的读操作免 token 是安全的，因为只读页面不敏感"（§6.12 的原判据） | ⚠️ 对**页面**成立，对**实时日志流**不成立：它推的是运行时日志原文（插件诊断、异常消息、守卫打的 URL），而出口 `redactValue` 只抹得掉**认得出的密钥形态** | **✅ 日志流已纳入 token 门**（`requiresToken(method, path)`，fail-closed 403 / 401）。**⚠️ settings 页仍然免凭据**（它渲染配置的**当前值**）—— 改它等于改 §6.12 的设计决定，留给用户拍板 |

## 13. 附录 B：关键源码索引

**来源版本：`0.1.0-rc.5`**（作者本地的 DSH monorepo 检出 @ `47f9438`；本包不含那份源码。
要重跑 §13 相关核对，设 `YANXIN_DSH_MONOREPO=<你的检出目录>`，见 `tests/unit/patch-semantics.spec.ts`）。

⚠️ **运行时目标版本是 `0.1.5-rc.3`**，与下表来源隔 5 个 prerelease。下表是"当初读的是哪个文件"的指路，**不代表目标版本仍有同样实现**——须按任务 T0-C2 逐项重核后才可依赖。

**核验进度（见 `docs/decisions/0003-api-drift-verification.md`）**

- ✅ **已按 `0.1.5-rc.3` 复核一致**：patch 语义（`applyEntryPatches` / `PatchOptions`）、`ToolExecutionInput` 无身份字段、`ToolGuard`、`PreToolDecision`、`ctx.webServer.register`、session augment 目标（`@deepseek-ai/dsh-session/types`）、`bash-local` 硬编码 `bash` 且无 shell 路径配置
- ⚠️ **已发现漂移**：`AgentPresets.mount/list/resolve` 返回 `Promise`（必须 await）；`AgentPresets` extends `TypertRemoteService`
- ✅ **2026-10-02 安全复核顺带核掉**：`PreToolDecision` **只有 allow/deny/ask，无输入改写**（`dsh-tools/lib/types/index.d.ts:414-427`）；`LocalBashExecutor.Config.cwd` 必填但运行期兜底到 `process.cwd()`（`dsh-bash-local/lib/index.js:170`）；webServer `host` **无安全默认值**（`dsh-host-webserver/lib/index.js:141`）；**win32 沙箱可用性 = 无 runner，走非沙箱 `bash-local`**（ADR 0009 + §7.4-C，`pnpm-workspace.yaml:27-28` 连 ACL 沙箱的 FFI 都拒了）
- ⏳ **待复核（任务 T0-C4）**：`ctx.settings.register`、`defineTool`/`ctx.tools.register`、`ctx.agentLoop.create`/`followup`/`whenIdle`、`dsh-llm-pi-ai` 的 `providers` 形状、`ShellExecutor` 抽象方法

| 主题 | 文件 |
|---|---|
| patch 应用（全部实现） | `vendor/include/src/index.ts`（`applyEntryPatches` / `PatchOptions`） |
| bundle / profile manifest | `packages/boot/app-boot/src/profile.ts` |
| 层序 | `apps/cli/src/profile-boot.ts:142-171`、`apps/cli/reference/README.md:9` |
| `$DSH_HOME` 解析 | `packages/util/home-paths/src/index.ts` |
| `dsh plugin` 行为 | `apps/cli/src/plugin.ts` |
| CLI 参数 | `apps/cli/src/args.ts` |
| preset 服务 | `packages/preset/agent-presets/src/index.ts`（`Config` / `mount` / 各方法） |
| 自定义 session 事件范例 | `packages/preset/agent-presets/src/session.ts` |
| 工具 guard | `packages/core/tools/src/index.ts`（`ToolGuard` / `PreToolExecution` / `ToolExecution`） |
| 工具编写范例 | `docs/user/develop/basic/tool.md` |
| 权限钩子范例 | `docs/cookbook/extension-cookbook.md:15-31` |
| 沙箱 | `packages/sandbox/*/README.md`（含 `sandbox-windows-acl`） |
| 平台门 | `packages/bundle/base/cordis.patch.yml:178-186` |
| webServer | `packages/host/webserver/src/index.ts` |
| 客户端模块扫描 | `packages/client/modules/README.md` |
| settings 白名单 | `packages/host/apiproxy/src/api-proxy.ts:115-135` |
| LLM 路由配置 | `packages/llm/llm-pi-ai/README.md` |
| agent 驱动范例 | `packages/bundle/headless/src/index.ts:111-133` |
| 包改名映射 | `docs/rescope.md` |

论文依据：*A Programming Paradigm for Spatiotemporal Composability*，arXiv 2608.25512（§6.1 系统边界 / §6.2 服务多路复用 / §6.3 访问控制与沙箱）。

---

## 评审检查表

- [x] 覆盖六个核心领域（Objective / Commands / Structure / Style / Testing / Boundaries）
- [x] 成功标准具体可测（§10，每条对应 §8 测试编号）
- [x] Boundaries 三档齐备（Always / Ask First / Never）
- [x] 安全约束作为验收项写入（§7.4），含诚实的局限声明
- [x] 地基选型有对比记录与理由（§2.1）
- [x] 被证伪假设全部留痕（§12）
- [x] **人工评审通过**（2026-09-27：用户验收当前版本为 **beta 1.0** 并入库打 tag `v1.0.0-beta`；
  §10 十三条逐条核对结论见 `tasks/todo.md` Checkpoint 8）
- [x] **安全约束逐条对代码复核**（2026-10-02，L3 深度审查 + §7.4 四条对着 `src/` 与 `presets/` 核过）：
  结论是**四条验收项里有三条 spec 写得比代码强**（每一跳重定向 / `cwd` 强制 / 控制台响应不含密钥），
  已全部降级为"实际做到的 + 残留风险"，并把做不到的**成因**写清（`PreToolDecision` 无改写、
  重定向在 provider 内部、脱敏是模式匹配）。新增假设 #24–#27、待办 R1–R8。
  **本轮修掉的**：审计覆盖面（MCP 执行留痕）· 落盘失败不再静默 · 日志流纳入 token 门 · url-guard logger 出口脱敏。
  **门禁**：typecheck / oxlint / vitest 全绿（1135 passed，新增 21 条）。
  ⏳ **未闭环的**：R1（settings 页免凭据）、R7（shell 实际 `cwd` 无人可证）、R8（Tavily key 未轮换）、
  R2–R6（守卫覆盖面与升级即失效的护栏）。**因此 §7.4 不能对外称"全部验收通过"。**

