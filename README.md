# 研心 (YanXin)

小研的 harness。基于 DeepSeek Harness（DSH）的插件 bundle：**一个 bot 实例、两套运行模式（agent / world）、同一人格基底**。

| 侧面 | 实现 |
|---|---|
| 消息通道 | OneBot v11 反向 WebSocket（NapCat / SnowLuma 连进来，协议层自建，只依赖 `ws`） |
| 运行模式 | 三个 DSH preset：`xiaoyan-agent`（群聊与普通私聊）、`xiaoyan-admin`（管理员私聊，带 shell）、`xiaoyan-world`（世界引擎 + 世界工具） |
| 主动性 | 自写窗口调度：默认 14:00–18:00 装载世界引擎，可暂停、可改时段；窗口内世界时钟每 **30 TU（=30 秒）**想一轮 |
| 长期记忆 | ReMe（`agentscope-ai/ReMe` 0.4.1.13）。容器形态从 `third_party/reme/` 装；本机形态没起则召回为空，对话不受影响 |
| 部署形态 | 两条：单镜像 `docker compose`（dsh + ReMe 同容器），或本机 `dsh --profile yanxin` |
| 运维界面 | 控制台 `/yanxin`：**十个页面**，含实时日志流、OneBot 连接设置与人格页 |

本包只有源码、测试与生成的 preset。不含运行时数据、密钥，也不含人格内容——`persona/` 是空模板，等你自己写。

完整规格见 [`docs/spec.md`](docs/spec.md)，改代码前先读 [`docs/development-notes.md`](docs/development-notes.md)。

---

## 环境要求

| 依赖 | 要求 |
|---|---|
| Node | `>=22.19`（或 `>=24`） |
| pnpm | v10+ |
| DSH | `@deepseek-ai/dsh@0.1.5-rc.3`（公开 npm 包；本包按这一版装配） |
| LLM | 任意 OpenAI 兼容网关，模型需支持 function calling |
| QQ 通道 | 可选。NapCat 或 SnowLuma，配成反向 WS 客户端 |
| Windows | 需要 Git Bash。DSH 必须在 Git Bash 里启动，否则管理员 shell 不可用 |

---

## 部署

### A. 单镜像（推荐第一次跑这条路）

一个容器里两个进程：`dsh`（带本 bundle）+ ReMe（记忆后端）。

```bash
cp .env.example .env      # 填三个 LLM 值 + 她的 QQ 号 + 两个 token
docker compose up -d
docker compose logs -f yanxin        # 控制台地址与 token 都在日志里
```

`.env` 里必填的只有五项，其余有默认值：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL_NAME` | — | 任意 OpenAI 兼容网关，模型要支持 function calling |
| `YANXIN_SELF_ID` | 空 | 她的 QQ 号。不填也能起（进初始化向导绑） |
| `YANXIN_ONEBOT_TOKEN` / `YANXIN_CONSOLE_TOKEN` | 空 | 见下面那道门 |
| `YANXIN_WEB_HOST` / `YANXIN_WEB_PORT` | `0.0.0.0` / `3080` | 控制台 |
| `YANXIN_ONEBOT_HOST` / `YANXIN_ONEBOT_PORT` / `YANXIN_ONEBOT_PATH` | `0.0.0.0` / `8080` / `/onebot/v11` | QQ 客户端连这里 |
| `YANXIN_REME_PORT` / `YANXIN_REME_WORKSPACE` | `2333` / `/data/reme` | 记忆后端（只绑容器内回环） |

⚠️ **非回环监听 + 空 token = 直接起不来**（`docker/entrypoint.mjs` 在生成配置之前 `exit 1`，
不是警告）。那条端口上没有别的东西在守，token 一空，任何连得上的人都能冒充她的客户端。
放行成功后启动日志里会有一条"已允许远程访问"的 WARN。

QQ 客户端侧填：`ws://<宿主 IP>:8080/onebot/v11`，类型 Universal，鉴权 Token 与
`YANXIN_ONEBOT_TOKEN` 一致。

镜像构建与运行由 `.github/workflows/image.yml` 冒烟：假网关起容器、**记忆线真的在镜像里起来**
（不是 `provider=none` 的空转）、控制台从容器外可达、那条 WARN 在场、非沙箱 shell 的边界没被
`dsh-bash-sandbox` 抢注。

### B. 本机

```bash
pnpm install
pnpm build                                            # DSH 加载 lib/，改了 src/ 不 build 等于没改
pnpm add -g @deepseek-ai/dsh@0.1.5-rc.3               # 或 npm i -g
node scripts/install.mjs --self-id <她的 QQ 号>         # 建 profile、写部署配置、建工作目录
```

`install.mjs` 会生成 `$DSH_HOME/profiles/yanxin/cordis.patch.yml`（模板：`deploy/profile.example.cordis.patch.yml`）。
它不覆盖已有配置、不写你的密钥；`--help` 看全部开关，`--dry-run` 只看不动。

剩下两件需要你自己做，因为要碰密钥：

```bash
# 1) LLM 密钥 → $DSH_HOME/.credentials.yaml（扁平格式，键名即环境变量名）
# 2) 控制台凭据（写操作与实时日志流都要；不设则一律拒绝，聊天不受影响）
export YANXIN_CONSOLE_TOKEN='<自定>'

dsh --profile yanxin
```

打开 <http://127.0.0.1:3080/yanxin/setup>，四步走完初始化：人格 → 背景 → 创世 → 绑账号。
之后改 `persona/` 里的任何文件都要重跑 `pnpm presets`（三个 preset 是生成产物）。

---

## 日常命令

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # oxlint
pnpm test          # vitest run（71 个 spec 文件，1303 个用例）
pnpm build         # → lib/
pnpm presets       # 从 persona/ 重新生成 presets/
pnpm deploy        # = node scripts/install.mjs，可反复跑
```

提交门（lefthook 跑上面三项）不自动安装，第一次要 `pnpm exec lefthook install`。

---

## 消息行为（桥的策略项）

这些都挂在装配树的 `onebot-bridge` 行上（行 config + 代码缺省两级；运行期热改走 settings 的只有
OneBot 的传输四项）。改一项要重写整段 config —— patch **没有深度合并**。

| 键 | 默认 | 作用 |
|---|---|---|
| `groupTrigger` | `mention` | 群聊触发：`mention` 只回被 @；`name` 被 @ **或**文本里出现名字都调一次；`never` 群里不回应 |
| `nameWords` | `['小研']` | `name` 模式下算"被叫到"的字样（要和她人格里的自称一致，否则"提到她"对不上） |
| `contextMessages` | `10` | 每次调用带进群聊最近几句原话（`0` = 不带；缓冲在内存，重启即空） |
| `maxReplyChars` | `2000` | 一条回复的**总长**上限 |
| `maxReplySegments` | `4` | 一条回复最多拆成几条 QQ 消息；超出的**并进最后一条**，不是丢掉 |
| `maxReplyCharsPerSegment` | `200` | 单条上限（QQ 实收约 500，留余量） |
| `replySegmentGapMs` | `600` | 拆成多条时两条之间隔多久（`0` = 连着发） |
| `stripReplyQuotes` | `true` | 外层引号发出去时去掉 —— 它只是分段边界，不是她想说的话 |
| `replyMixedLines` | `keep-all` | 引号行与裸行混在一起时：`keep-all` 裸行也发（不丢内容）；`quoted-only` 只发引号行 |
| `dryRun` | `false` | 只记日志不真发（第一次观察她会怎么回时很有用） |
| `stats` / `statsPath` | `true` / `$DSH_HOME/yanxin/stats.db` | 控制台首页仪表盘的数据源 |
| `model` / `cwd` | — | 覆盖默认模型 / agent 工作目录 |

**分段发送**的边界由她自己标：一行一句、整行用直引号包住，一个引号行 = 一条消息。
一个引号行都没有时**整条照发**（再按长度切）—— "忘加引号"不能变成不回话。
`[CQ:…]` 这类段永远不被从中间切断，包括总长截断那条路径。群里 @ 只挂在第一条上。

**合并转发**（"折叠的聊天记录"）会展开成给模型读的"谁在什么时间说了什么"：需要时调
`get_forward_msg`，深度上限 3 层、总预算 40 条、每条 300 字。拉不到时保留 `[forward]` 占位符
并 warn 一条（带转发 id）—— 整条消息不会因为展开失败被静默丢掉。

---

## 配置分三层

| 层 | 在哪 | 装什么 |
|---|---|---|
| bundle patch | 本包 `cordis.patch.yml` | 插件行的结构与开关。入库，**不放任何密钥或本机路径** |
| profile patch | `$DSH_HOME/profiles/yanxin/cordis.patch.yml` | 端口、access token、账号注册表、工作目录、世界群号。不入库 |
| settings | `$DSH_HOME/settings.yaml` | 运行期可改：管理员名单、时段、模型路由、记忆后端、OneBot 传输参数 |

后两层在版本库之外，所以改它们不需要重新拉代码。取值优先级与几处反直觉的地方写在
[`docs/development-notes.md`](docs/development-notes.md)。

---

## 安全须知

摘要，细节与残留风险清单在 `docs/spec.md` §7.4：

- **shell 只在管理员私聊可用**，在声明期裁掉而非运行期判定；本机形态它**没有沙箱**
  （`dsh-bash-sandbox` 没有 win32 runner），是本机任意代码执行能力。容器形态里沙箱提供者
  被显式禁用 —— Linux 上平台门不成立，不禁它会与 `bash-local` 抢注 `shell` 服务名。
- **出网有 SSRF 守卫**（`src/net/url-guard.ts`）：仅 http/https，拒回环/私有/链路本地/云元数据，
  先解析 DNS 再判定。它只约束 harness 自己发起的请求，管不到 shell 内部的出网，也管不到 MCP。
- **密钥只走环境变量**。内联进 YAML 的值会被 `dsh --dump-config` 明文打印。
- **执行类调用一律留审计**（`$DSH_HOME/yanxin/audit/*.jsonl`），落盘前统一脱敏。
- **控制台的暴露面随形态变**：本机形态只绑回环；**容器形态默认 `0.0.0.0`，即对远程可达**，
  此时唯一那道门就是 `YANXIN_CONSOLE_TOKEN` —— 没 token 起不来（entrypoint 直接 `exit 1`），
  起来后日志里有一条"已允许远程访问"的 WARN。把它放到公网上请先自己加一层反代鉴权/TLS。
- **仓里不写真实标识**：她的 QQ 号、主人的 QQ 号、真实群号在代码/文档/测试里都是占位值
  （`3000000001` / `2000000001` / `3000000003`），真值只在 `$DSH_HOME`。有一条机械守卫盯着
  （`tests/unit/source-hygiene.spec.ts` 末尾）。

---

## 目录

```
src/            源码（onebot / world / memory / console / setup / admin / audit / net / window / preset）
tests/          71 个 spec（unit + integration + support + fixtures）
tests/fixtures/ package-root —— 向导测试用的包根夹具（不依赖这份包的 persona 有没有填）
presets/        三个 agent preset —— 生成产物，不要手改
persona/        人格源文件（出厂为空模板）
deploy/         部署层模板（本机 profile.example / 容器 profile.docker / compose 示例）
docker/         entrypoint.mjs —— 一个容器里两个进程的装配与首启落盘
third_party/    reme —— vendored 的 ReMe 源树（Apache-2.0，见 UPSTREAM.md）
scripts/        install.mjs、build-presets.mjs
Dockerfile      单镜像：dsh（带本 bundle）+ ReMe
docs/           spec.md（规格）、development-notes.md（开发注意事项）
.github/        image.yml —— 镜像构建 + 起容器冒烟
AGENTS.md       给 AI 编码代理的操作约定
```

---

## 已知限制

- Windows 本机形态没有可用的 shell 沙箱（`dsh-bash-sandbox` 没有 win32 runner）；`cwd` 只是默认值不是边界。
- URL 守卫判定的是起始 URL，跨源重定向由上游 provider 拒绝；DNS rebinding 的时间窗仍在。
- **出站只发文本**。收到图片/表情能看懂（归一化成占位符），但她还发不出图片和 QQ 表情 ——
  出站消息段构造还没接。
- **她不能主动发到配置之外的群/人**。目前只有"回应来过的会话"这一条路，主动跨群发送的工具
  还没做（做的时候要有白名单与审计，没白名单等于可以被注入指令去骚扰陌生群）。
- ReMe 的记忆沉淀是**慢路径**（一次 `auto_memory` 实测十几到二十几秒），所以写回刻意挂在对话
  队列之外攒批；容器形态从 `third_party/reme/` 装、CI 验过记忆线真的起来，本机形态没装 ReMe
  就把 `yanxin-memory.provider` 设为 `none`，其余功能照常。
- 群聊上下文缓冲在内存里，重启即空 —— 她的长期记忆靠 ReMe，不靠这个缓冲。

## 许可

[PolyForm Noncommercial License 1.0.0](LICENSE)。非商业用途（个人学习、研究、实验、爱好项目，以及慈善/教育/科研/公益/政府机构的使用）在授权范围内；**商业用途不在授权范围内**，需要单独取得许可。分发时请一并保留本文与 `LICENSE`。

```
Required Notice: Copyright (c) 2026 aoye666
```
