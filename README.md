# 研心 (YanXin)

小研的 harness。基于 DeepSeek Harness（DSH）的插件 bundle：**一个 bot 实例、两套运行模式（agent / world）、同一人格基底**。

| 侧面 | 实现 |
|---|---|
| 消息通道 | OneBot v11 反向 WebSocket（NapCat / SnowLuma 连进来，协议层自建，只依赖 `ws`） |
| 运行模式 | 三个 DSH preset：`xiaoyan-agent`（群聊与普通私聊）、`xiaoyan-admin`（管理员私聊，带 shell）、`xiaoyan-world`（世界引擎 + 世界工具） |
| 主动性 | 自写窗口调度：默认 14:00–18:00 装载世界引擎，可暂停、可改时段 |
| 长期记忆 | 外部 ReMe 服务（可选；没起则召回为空，对话不受影响） |
| 运维界面 | 本机控制台 `/yanxin`：九个页面，含实时日志流与 OneBot 连接设置 |

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

QQ 客户端侧填：`ws://127.0.0.1:8080/onebot/v11`，类型 Universal，鉴权 Token 与部署配置里的 `onebot.token` 一致。

---

## 日常命令

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # oxlint
pnpm test          # vitest run（62 个 spec 文件）
pnpm build         # → lib/
pnpm presets       # 从 persona/ 重新生成 presets/
pnpm deploy        # = node scripts/install.mjs，可反复跑
```

提交门（lefthook 跑上面三项）不自动安装，第一次要 `pnpm exec lefthook install`。

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

- **shell 只在管理员私聊可用**，在声明期裁掉而非运行期判定；它**没有沙箱**，是本机任意代码执行能力。要接不可信输入，先把它迁进容器或独立进程沙箱。
- **出网有 SSRF 守卫**（`src/net/url-guard.ts`）：仅 http/https，拒回环/私有/链路本地/云元数据，先解析 DNS 再判定。它只约束 harness 自己发起的请求，管不到 shell 内部的出网。
- **密钥只走环境变量**。内联进 YAML 的值会被 `dsh --dump-config` 明文打印。
- **执行类调用一律留审计**（`$DSH_HOME/yanxin/audit/*.jsonl`），落盘前统一脱敏。
- **控制台只服务回环**，写操作与日志流需要 token；未配置 token 时一律拒绝。

---

## 目录

```
src/            源码（onebot / world / memory / console / setup / admin / audit / net / window）
tests/          62 个 spec（unit + integration + support）
presets/        三个 agent preset —— 生成产物，不要手改
persona/        人格源文件（出厂为空模板）
deploy/         部署层模板
scripts/        install.mjs、build-presets.mjs
docs/           spec.md（规格）、development-notes.md（开发注意事项）
AGENTS.md       给 AI 编码代理的操作约定
```

---

## 已知限制

- Windows 上无可用 shell 沙箱（`dsh-bash-sandbox` 没有 win32 runner）；`cwd` 只是默认值不是边界。
- URL 守卫判定的是起始 URL，跨源重定向由上游 provider 拒绝；DNS rebinding 的时间窗仍在。
- ReMe 是外部 Python 服务，本包只定义了它的接口契约，没有核实过的安装命令。装不上就把
  `yanxin-memory.provider` 设为 `none`，其余功能照常。

## 许可

[PolyForm Noncommercial License 1.0.0](LICENSE)。非商业用途（个人学习、研究、实验、爱好项目，以及慈善/教育/科研/公益/政府机构的使用）在授权范围内；**商业用途不在授权范围内**，需要单独取得许可。分发时请一并保留本文与 `LICENSE`。

```
Required Notice: Copyright (c) 2026 aoye666
```
