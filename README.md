# 研心 / YanXin

小研的 harness：**一个 bot 实例、两套运行模式（agent / world）、同一人格基底**。
基于 DeepSeek Harness（Cordis）的独立 bundle，经 profile 挂进 DSH。

---

## 快速启动

四步。**先构建** —— bundle 的入口是 `lib/`（`package.json` 的 `exports["."]`），
**改了 `src/` 不 build 等于没改**：

```bash
pnpm install
pnpm build
```

装 DSH 运行时（公开 npm 包，本仓的装配按 `0.1.5-rc.3` 写的）：

```bash
pnpm add -g @deepseek-ai/dsh@0.1.5-rc.3     # 或 npm i -g
```

一条命令把 profile、部署配置、工作目录都建好（会问你缺的值，不给就报错退出）：

```bash
node scripts/install.mjs --self-id <她的 QQ 号>
# 想先看它要做什么：加 --dry-run。全部开关：--help
```

它写的是 `$DSH_HOME/profiles/yanxin/cordis.patch.yml`（模板在 `deploy/profile.example.cordis.patch.yml`，
**每一段为什么必须存在都写在注释里**）—— 这一层不在本仓，因为它装着 access token 和这台机器的路径。

然后填密钥、启动、开向导：

```bash
# 1) LLM 密钥：$DSH_HOME/.credentials.yaml（扁平格式，键名 = 环境变量名）
#    ⚠️ 不要把 key 内联进任何 YAML —— `dsh --dump-config` 会明文打印（见"安全与局限"）
# 2) 控制台凭据（写操作与实时日志流都要；不配就是一律拒）
export YANXIN_CONSOLE_TOKEN='<你自己设一个串>'
# 3) 起
dsh --profile yanxin
```

浏览器打开 **`http://127.0.0.1:3080/yanxin/setup`** —— 人格 → 背景 → 创世 → 绑号，四步走完才算初始化完。
（`persona/` 出厂是**空模板**：结构与纪律都在，人格内容留给你自己写。改完跑 `pnpm presets` 重新生成三个 preset。）

服务端监听 `127.0.0.1:8080/onebot/v11`（**只绑回环** —— QQ 客户端在本机，没有理由对外监听）。

### 前置与可选项

| 需要 | 说明 |
|---|---|
| Node | `>=22.19`（或 `>=24`）。DSH 的 `engines` 要求，本仓跟着走 |
| pnpm | v10+。`pnpm-workspace.yaml` 里有 `allowBuilds` 清单 —— 那是 pnpm 10 的严格构建脚本门，漏了会**装不上**而不是报错 |
| LLM 路由 | 任意 OpenAI 兼容网关 + 一个**支持 function calling** 的模型。世界引擎靠 `tool_choice: 'required'` 提案，不支持的模型会安静地什么都不做 |
| QQ 通道 | 可选。NapCat / SnowLuma 建一条**反向 WS**（Universal 类型），URL `ws://127.0.0.1:8080/onebot/v11`，Token 填 install 生成的那个。不配就没有消息进来，但控制台照样能看 |
| 长期记忆 | 可选，外部 Python 服务 ReMe（见下）。没起只是召回为空，说话不受影响 |
| Windows | **DSH 必须在 Git Bash 里启动**，否则 `bash` 不在 PATH 上，管理员私聊的 shell 不可用（ADR 0001）。Git 装在哪个盘都行，代码不硬编码盘符 |


### QQ 通道（NapCat / SnowLuma，可选）

反向 WS，**我们是服务端、客户端来连我们**；连上之后**由我们向它发 API 调用**（发消息等）。

| 字段 | 值 |
|---|---|
| URL | `ws://127.0.0.1:8080/onebot/v11` |
| 类型 | Universal（API + Event 一条连接） |
| Token | 与 profile patch 的 `onebot.token` 一致（留空则不校验） |
| 心跳间隔 | 任意 —— **我们不依赖 OneBot 心跳做存活检测** |

存活检测走 WebSocket 协议层的 ping/pong（`pingIntervalMs`，默认 30s）。
协议层是自己实现的（`src/onebot/protocol.ts` + `service.ts`，只依赖 `ws`）—— 没有用任何 v11 SDK。

### 长期记忆（ReMe，可选）

长期记忆存在本机的 **ReMe** 里（`127.0.0.1:2333`，**只绑回环** —— 它的 HTTP 接口**没有鉴权**）。
它是**可选**的：没起也不影响说话，只是召回为空。

> ⚠️ ReMe 是**独立的外部 Python 服务**，不在本仓，本仓也**没有一条被核实过的安装命令**。
> 我们只对它提要求：`POST /<job>`，且遵守 `docs/spec.md` §6.9 记的那套接缝契约（中文要 UTF-8 文件、
> 会话 id 不能含 `:`、失败会藏在 200 里）。**装不上就把 `yanxin-memory.provider` 设成 `none` 先跑起来** ——
> 记忆线整条会降级为空召回，其它一切照常，这正是当初把它做成可插拔的目的。

启动（DSH 侧给的命令形状）：

```bash
reme start workspace_dir="<你的记忆目录>" service.host=127.0.0.1 service.port=2333
```

⚠️ **三个坑都是"看起来像记性差"**（都在 spec 附录 A 与 ADR 0014 里）：

1. `reme start` **不读 `.env`**；读它的是服务自己的 `load_env()`，规则是「**当前工作目录**及最多 5 层父目录」。
   所以 **cwd 决定配置能否加载** —— 必须 `cd` 到 `.env` 所在子树再启动，否则 `LLM_API_KEY` 就是空的。
2. 模型名必须是你那个网关**真实存在**的模型 id。写错 → `auto_memory` 回 404，**但 HTTP 状态码仍是 200**（静默失败）。
3. 内部异常会被吞进它自己的日志，**HTTP 始终 200**。判据不能只看 status，要**同时看 ReMe 的日志**。

**验证它在正常工作**：

```bash
curl http://127.0.0.1:2333/health_check
# 端到端就用控制台的记忆页（检索走 POST，要 token）：/yanxin/memory
```

**记忆开关**：`$DSH_HOME/settings.yaml` 的 `yanxin-memory.provider`
（`reme` 或 `none`；`none` 时服务照常装载、召回全空、对话不受影响）。


---

## 行为政策

这几个键在**部署层**，出厂模板（`deploy/profile.example.cordis.patch.yml`）里的值是：

| 键 | 模板里的值 | 含义 |
|---|---|---|
| `groupTrigger` | `name` | 被 @ **或**文本里出现「小研」就叫她一次，每次带最近 10 句原话。想只在被 @ 时回应就改 `mention`；只想私聊测试就改 `never` |
| `contextMessages` | `10` | 群聊触发时带进上下文的句数（0 = 不带；缓冲在内存，重启即空） |
| `dryRun` | `false` | `true` 时只把"本应发什么"记进日志，**不真发** —— 第一次观察她会怎么回，建议先开这个 |
| `maxReplyChars` | `2000` | 超长截断 |
| `cwd` | `$DSH_HOME/yanxin/workspace` | agent 的工作目录。⚠️ 三处 `cwd`（桥 / bash / 世界引擎）**必须一致**，模板里三处都写了同一个占位 |

改这些在 **`$DSH_HOME/profiles/yanxin/cordis.patch.yml`** ——
**不在本仓**，因为里面有 access token 和这台机器的路径（仓库是要公开的）。

> ⚠️ patch **没有深度合并**：覆盖一行的 config 是整字段替换。模板里每段都写完整了，
> 别从自己那份里删键 —— 删掉的键不会"保留上游默认"，而是回落到代码缺省。

---

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint
pnpm test        # vitest
pnpm build       # tsc -p tsconfig.build.json → lib/
pnpm presets     # 改了 persona/ 之后重新生成三个 preset
```

⚠️ **`pnpm build` 不是可选的。** 服务端加载 `lib/`，不是 `src/`。

⚠️ **提交门要装一次**：`pnpm exec lefthook install`。
仓里有 `lefthook.yml`（pre-commit 跑 typecheck + lint + test），但本仓的 `.npmrc` 关掉了
pnpm 的 `pre/post` 脚本，所以 **`pnpm install` 不会自动挂上它** —— 没装的话钩子形同不存在，
提交会绕过三道检查。紧急跳过用 `LEFTHOOK=0 git commit`（别养成习惯）。

⚠️ 日志级别：bundle patch 里把 `logger-console` 配成 `levels: { default: 3 }`。
DSH 的默认阈值是 1，会**静默丢掉 warn 和 debug**（ADR 0010 记过这个坑）。

---

## 管理员

管理员**私聊**是唯一带 shell 的通道（`xiaoyan-admin` preset 比 `xiaoyan-agent` 多
`tool-bash`）。群聊**即使来自管理员也不走 admin**。

**实测工具表**：群聊 **2 个**（`web_fetch`、`web_search`）；管理员私聊 **3 个**（+ `bash`）。

⚠️ shell 的**提供者**（`dsh-bash-local`）在 **host 平面**（`cordis.patch.yml`），**不在 preset 里** ——
因为 host 平面有别的消费者（`permission-presets` 等依赖 `shell` 服务），而 preset 是 per-agent 的，
声明进程级单例会撞服务名。**分工原则：服务提供者放 host 平面，模型可见的工具行由 preset 声明。**
（这条是踩了坑才固化的，见 ADR 0013。）

名单存在 `ctx.settings` 的 `yanxin-admin` 命名空间下（即 `$DSH_HOME/settings.yaml`）。
**空名单时一律不是管理员**（fail-closed —— 不认得出就当普通人）。

目前改名单有三条路：控制台的**管理员页**（推荐）、服务 API，或手改 `settings.yaml`。

---

## 控制台 `/yanxin`

本机运维界面：一条 `prefix` 路由 + **三道门**。

```bash
# 写操作必须带 token；token 只从环境变量来（不进仓库、不进 patch）
export YANXIN_CONSOLE_TOKEN='<你设的串>'
# 然后起服务（见上文），浏览器开：
#   http://127.0.0.1:3080/yanxin/
```

| 门 | 判据 | 谁守 |
|---|---|---|
| 只绑回环 | `host: 127.0.0.1` | patch 配置（第一道） |
| 非回环请求 403 | 代码里判 `remoteAddress` | **我们的代码**（可被测试证伪） |
| 写操作要 token | `x-yanxin-token` 与 `YANXIN_CONSOLE_TOKEN` 定时安全比较；**没配 token = 一律 403**（fail-closed） | 我们的代码 |
| **实时日志流**要 token | 它是读操作，但流里是运行时日志原文 —— 与写操作同等对待 | 我们的代码 |

- 页的内容是**数据（`Block[]` JSON）**，不是 HTML；浏览器端用 `createElement`/`textContent` 渲染。
  **整条链没有 `innerHTML`** —— 昵称、消息、日志里的 `<script>` 只会显示成文字（ADR 见 spec §6.12 的偏差说明）。
- 所有写操作（含被拒的）落 `$DSH_HOME/yanxin/audit/console.jsonl`。

**九个登记页 + 首页仪表盘**（一页一个插件行，卸载即消失；首页是挂载根本身，不在导航计数里）：

| 页面 | 路径 | 能做什么 |
|---|---|---|
| 初始化 | `/yanxin/setup` | 装人格 / 装背景 / 创世 / 绑账号（唯一的人工入口） |
| 首页 | `/yanxin/` | 仪表盘：一句话状态 + 消息统计（今天 / 累计 / 近 7 天趋势 / 最热闹的群） |
| 管理员 | `/yanxin/admins` | 名单增删（改完立刻生效） |
| 时段 | `/yanxin/window` | 改主动行为窗口（提交即重新裁决，不用重启） |
| 设置 | `/yanxin/settings` | 命名空间总览 + **换模型**（可选路由从 `llm-pi-ai` 读出来并校验） |
| 世界 | `/yanxin/world` | 只读：TU / 纪元 / 事务数 / 她此刻在哪儿 / 笔记本 + 引擎启停、响应群号两个开关 |
| 记忆 | `/yanxin/memory` | 检索她的长期记忆 + 溯源（**要 token**：里面是她全部的对话痕迹） |
| 对话 | `/yanxin/talk` | 只读：事件时间轴（**只看本进程活着的会话** —— 磁盘日志是分帧 zstd） |
| 日志 | `/yanxin/log` | 实例运行日志的**实时流**（SSE；**要 token** —— 流里是运行时原文） |
| OneBot 连接 | `/yanxin/onebot` | 改监听地址 / 端口 / access token / 升级路径 / 心跳与超时，**不用重启** |

可写面是**四项**（模型路由、管理员名单、时段、OneBot 传输参数）：其余命名空间是部署配置，只读展示、手改 `settings.yaml`。

⚠️ OneBot 那一页改了**不用重启**，但它把"只绑回环"这个隐式前提变成了可点的字段，所以加了
两道**服务端**的门（浏览器里的提示不算门，`curl` 也绕不过）：

1. 改成非回环（`0.0.0.0` / `::` / 网卡 IPv4）必须**显式勾选确认**；
2. 非回环时**必须有 access token** —— 这个端口没有别的东西在守，token 一空，
   任何能连上它的人都能**冒充她的客户端**（推假事件、拿到回发目标），而 URL 守卫管不到那条路。

认不出的地址一律按对外处理（fail-closed）；改**回**回环不设卡。
`accounts`（哪个 QQ 号挂哪个 preset）**不在这一页** —— 那是能力构成，要改仍然走 profile patch。
**token 的值在页面上永不回显**（这一页免凭据可读，见"安全与局限"）。

---

## 安全与局限（必读）

> shell 是本机任意代码执行能力，**且未经过沙箱**。它能 `curl` 内网、能读任意可读文件。
> **§7.4-A 的 URL 守卫只约束 harness 自身的请求路径，对 shell 内部的出网行为无效。**
> 前提是：所有进入 harness 的输入源（群聊消息、网页内容、文件）都被视为可信。
> 若要接不可信输入，必须先把 shell 迁入独立容器/进程沙箱——语言级检查不足以隔离。

逐条落地情况：

- **shell 无沙箱**：`dsh-bash-sandbox` 在 Windows 上没有 runner，我们用的是非沙箱的 `dsh-bash-local`。
  ⚠️ 注意它**不是被我们关掉的**：生效的是 base 的平台门（`disabled: !!js process.platform === 'win32'`），
  本仓从未写过 `bash-sandbox` 的 disable 行；而 `sandbox` / `sandbox-policy` / `fs-sandbox` / `approval`
  四行仍然 enabled，被禁的只是唯一执法的 `permission`。**所以"无沙箱"是平台条件性质，换个 OS 就不同。**
  Windows ACL 沙箱即使启用也是 `enforcement: 'partial'`
  （官方原话：受限令牌必须保留 Everyone 才能初始化进程）。**能跑 ≠ 安全。**
- **`cwd` 不是护栏**：`tools/pre-execute` 的返回值只有 `allow`/`deny`/`ask`（**不能改写参数**），
  而执行形态是 `bash -c <命令串>` —— 一句 `cd` 就离开任何工作目录。所以 shell 跑在哪个目录
  **由部署配置负责**（profile patch 的 `cwd`；没配就落到进程的 `cwd`），审计里只记调用方**要的**
  `requestedWorkdir`。要真正的隔离只有容器 / 独立进程沙箱（spec §7.4-B、§7.4-C）。
- **谁有 shell**：只有**管理员私聊**（`xiaoyan-admin` preset）。群聊与普通私聊的工具表里没有 shell 那一行 ——
  这是**声明期裁掉**，不是运行期判定。
- **出网守卫**（`src/net/url-guard.ts`）：仅 http/https；拒回环/私有/保留/链路本地/云元数据；
  先解析 DNS 再判别；跨源重定向由 provider 拒绝（我们只 own 起始 URL 与跳数上限）。
  **残留风险**：解析后 provider 会再解析一次并连接 → DNS rebinding 的时间窗仍在（ADR 0017）。
- **审计**：`$DSH_HOME/yanxin/audit/{url-guard,shell,console}.jsonl`。
  每条**执行类**调用一行：时间、会话（及从会话命名解析出的账号）、命令、exit code、耗时、输出字节数、危险等级、
  `requestedWorkdir`。覆盖面**不止 `bash`** —— 名字像执行器（`bash`/`pwsh`/`exec`/`terminal`/`mcp__*`）
  且参数里带命令串的都算，所以 MCP 工具的执行同样留痕（2026-10-02）。
  **落盘前统一脱敏**（ADR 0016）—— 命令里若带 `sk-…` / `Bearer …` / `?apiKey=…`，
  记下来的是 `«redacted»` 形态，并标 `commandRedacted: true`。
  ⚠️ 两个"如实"：命令是**脱敏后**的（不逐字节）；`输出字节数`是**带内**长度（超出部分在 spill 文件里）。
  落盘失败**不再静默**：仍然永不抛、绝不拖住执行，但会 `logger.warn` 一声。
- **审计里的"账号"是线索不是身份**：DSH 的工具接缝没有发起者（人类）身份，
  `account` 是从会话命名约定解析出来的（`src/audit/session-subject.ts`）。
  **不要拿它做权限判定。**
- **密钥只在环境变量**：LLM key / OneBot token / `YANXIN_CONSOLE_TOKEN` 一律不入库、不进 patch
  （patch 会有 `--dump-config` 明文打印的风险）。
- **控制台**：绑定地址由 config 钉在 `127.0.0.1`（**上游没有安全默认值** —— `host` 是必填的
  `127.0.0.1 | 0.0.0.0`），再加一道运行期回环门禁。**写操作要 token；实时日志流同样要**
  （流里是运行时日志原文，出口那层脱敏只抹得掉"认得出的密钥形态"）。
  没配 `YANXIN_CONSOLE_TOKEN` 时这两类**一律 403 fail-closed**。
  ⚠️ `EventSource` 不能带请求头，所以日志流的 token 只能走 `?token=`（spec §7.4-D 记了这个取舍）。
  **settings 页仍对任何本机进程免凭据渲染配置当前值** —— 那是 §6.12 的设计决定，未改。

---

## 文档导航

| 路径 | 内容 |
|---|---|
| `docs/spec.md` | **单一事实源**：目标、机制、代码纪律、边界、成功标准 |
| `deploy/profile.example.cordis.patch.yml` | 部署层模板（`scripts/install.mjs` 的原料），每段为什么必须存在都写在注释里 |
| `scripts/` | `install.mjs`（部署）、`build-presets.mjs`（从 `persona/` 生成三个 preset） |
| `persona/` | 人格**源文件**（单一来源）。⚠️ 出厂是**空模板**，人格内容由你写；改完跑 `pnpm presets` |
| `presets/` | 由 `scripts/build-presets.mjs` 生成的**产物 —— 不要手改** |
| `AGENTS.md` | 给 AI agent 看的操作约定（构建顺序、patch 分层纪律、测试隔离） |

> **本包不含**：`docs/decisions/`（22 篇 ADR，作者的踩坑记录）、`tasks/`（任务分解与逐条进度）、
> `spike/`（一次性探针，且含明文密钥所以从来不入版本库）。
> 文中出现过的 `ADR 00xx` 与 `T12` 这类任务号，在这份包里**只是编号**，指不到文件 ——
> 它们的结论都已经写进 `docs/spec.md`（附录 A「被证伪的初始假设」是浓缩版）。

---

## 许可证

**[PolyForm Noncommercial License 1.0.0](LICENSE)** —— 全文见 `LICENSE`。

Required Notice: Copyright (c) 2026 aoye666

一句人话：**非商业用途随便用**（个人学习、研究、实验、爱好项目、自娱自乐，以及慈善/教育/科研/公益/政府机构的使用都算许可用途）；
**商业用途不在授权范围内** —— 想拿它做产品或服务，请先联系许可人单独取得许可。
可以改、可以再分发（分发时带上本文与 `LICENSE`）。

⚠️ 两点要提醒：
- **本包不含人格内容。** `persona/` 是空模板，你自己写的那份归你 —— 但请注意你与模型聊天产生的
  会话数据、记忆与审计日志都属于你，不要提交进任何公开仓库（`$DSH_HOME/` 整个目录都不该入库）。
- 这不是 OSI 认证的开源协议。如果你要的是一条"完全无限制"的许可，请用 MIT/Apache-2.0，
  别在打算商用的项目里依赖本包。

---

## 六个最容易踩的坑（结论都在 spec 附录 A 与 §7.4）

1. **类型通过 ≠ 运行时存在。** 从 monorepo 启动时，bundle 解析到 monorepo 的
   `packages/<包>/lib`，与本仓 `node_modules` 里那份是**两条版本线**（ADR 0011）。
   读外部结构一律走适配层（`src/onebot/session-api.ts`）。
2. **session id 是确定性的**，所以冷启动必须 `resume` 优先，无脑 `create` 会撞
   `id collision`（ADR 0011）。
3. **插件模块要么只用命名导出、要么只 `export default`**，绝不同时 ——
   混用时 `inject` 会被**静默丢弃**（ADR 0004）。
4. **preset 只能往 agent 平面"加"行，减不掉 host 平面的行。** `dsh-base` 的
   `tool-pwsh` / `tool-fs` / `tool-subagent`… 默认所有 agent 都拿得到 —— 曾经让群聊
   拿到 26 个工具（含 PowerShell，实测真的执行了）。已在 `cordis.patch.yml` 用
   `disabled: true` 裁掉，并补了 host 侧回归护栏（ADR 0013）。
   **推论：加新工具要在 preset 里声明，不要依赖 host 行。**
   验收也要注意 —— **读 preset 文件证明不了运行时能力**，权威证据是发请求时的
   `request/header.tools`（本仓的对应测试是 `tests/unit/preset-capabilities.spec.ts`）。
5. **外部后端的失败可能是"HTTP 200 + 内部异常"。** ReMe 把 `Msg` 校验失败、
   LLM 404 之类的错误吞进自己的日志，响应仍然 200；而**失败原因写在 `answer` 里，
   `metadata` 往往是无关的统计计数**。所以对接外部后端时：判据不能只看状态码，
   而且要把 `answer` 露出来（只看 metadata 会把"session_id 非法"显示成
   `{"auto_tag":{...}}`，查错方向直接带偏）。见 ADR 0014 决策六。
6. **判定要对着"归一化之后"的形态。** URL 解析器会把 `[::ffff:169.254.169.254]` 变成
   `[::ffff:a9fe:a9fe]`，把 `2130706433` 变成 `127.0.0.1`；只认点分写法的私网守卫于是
   **全部放行**（云元数据与回环都能过）。凡是对"文本形态"下判定的地方，先问一句
   "这段文本是谁给我的、它经过了解析器没有"。见 ADR 0017。
