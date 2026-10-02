# 开发注意事项

改这个仓之前要知道的事。规格本身在 [`spec.md`](spec.md)，这里只写**容易踩、踩了难查**的东西，
以及**已知但没修**的清单。

## 1. 动手之前

- **`pnpm build` 不是可选的。** DSH 加载 `lib/`，不是 `src/`。改了 `src/` 不 build，跑起来还是旧行为。
- **提交门要装一次**：`pnpm exec lefthook install`。本仓 `.npmrc` 关掉了 pnpm 的 `pre/post` 脚本，
  所以 `pnpm install` **不会**自动挂上 pre-commit（typecheck + lint + test）。没装就等于没有门。
- **`presets/` 是生成产物**，由 `scripts/build-presets.mjs` 从 `persona/*.md` 生成。手改会在下一次
  `pnpm presets` 时被无声覆盖。有一条测试专门盯 preset 与 persona 漂移。
- **质量门的顺序**：typecheck → lint → test。typecheck 最快且拦截最多（`strict` + `noUncheckedIndexedAccess`）。
- 日志级别：bundle patch 把 `logger-console` 配成 `levels: { default: 3 }`。DSH 默认阈值是 1，
  会**静默丢掉 warn 与 debug**——"没有 warn 日志"和"没有 warn 发生"长得一模一样。

## 2. 配置分层的六条硬规矩

| 规矩 | 违约后的症状 |
|---|---|
| patch **没有深度合并**：覆盖一行的 config 是整字段替换 | 你只想改 `port`，结果那一行其余键全回落到代码默认 |
| 注册 settings 命名空间时 **schema 不要写 `.default()`** | schema 自己填了值，行 config 被**静默忽略**（`searchLimit: 3` 传进去拿到 5） |
| 取值顺序统一为 **settings → 行 config → 代码默认**，默认值只放一处常量 | 两处各写一份默认，改一处不生效 |
| 密钥只走环境变量（`apiKeyEnv` / `.credentials.yaml`），**不内联进任何 YAML** | `dsh --dump-config` 会明文打印内联密钥 |
| OneBot 的 `host`/`port`/`path`/`token` 在 profile patch 里**只是初值** | 在 patch 上来回改而 settings 里有值，怎么改都"不生效" |
| `accounts`（selfId → preset）只属于 profile patch | 想把它挪进控制台改 = 想给运行期开一个改权限边界的口子 |

## 3. 能力隔离不能靠 preset 文件自证

`dsh-base` 把 `tool-pwsh` / `tool-fs` / `tool-subagent` 等注册在 **host 平面**，preset 只能往
agent 平面**加**行，**减不掉** host 的行。曾经因此让群聊拿到 26 个工具（含 PowerShell，实测真的执行了）。
现在 `cordis.patch.yml` 逐个 `disabled: true` 裁掉。

推论两条：

- 加新工具**在 preset 里声明行**，不要依赖 host 平面那行；provider（进程级单例）留在 host 平面，
  否则撞服务注册名。
- 验收**必须读运行时的 `request/header.tools`**（`tests/unit/preset-capabilities.spec.ts`）。
  读 preset 文件只能证明"文件里没写"，而失效恰恰发生在文件之外。
  同理：`url-guard` 存在，是因为 **MCP 工具绕过 preset 裁剪**。

## 4. 测试与环境依赖

- `tests/support/isolate-dsh-home.ts` 通过 `setupFiles` 全局把 `$DSH_HOME` 指到临时目录。
  必须在**被测模块 import 之前**执行——落盘路径在模块加载时就固化了，写在某个 spec 里会漏。
- 两处测试依赖本机环境，在别人机器上会跳或红，不是代码坏了：
  - `tests/integration/shell-tier1.spec.ts` 需要 `bash` 在 PATH 上（Windows 要 Git Bash）。
  - `tests/unit/patch-semantics.spec.ts` 需要 DSH monorepo 检出，设 `YANXIN_DSH_MONOREPO=<路径>`；
    没设就整组 skip（它断言的是上游 `applyEntryPatches` 的行为，宁可跳过也不假装通过）。
- **等异步落盘要等"一整行"，不是等"文件存在"。** 审计走 `mkdir` → `appendFile` 两步，文件会先以
  0 字节存在；负载高时读到空串，断言就偶发红（单跑永远绿，全量跑才现形）。判据用
  "至少一行且以换行结尾"（`tests/unit/audit-hygiene.spec.ts` 的 `waitForFile`）。
- **端口相关的测试别假设"分配到的端口一定不同"。** 换绑类用例要断言的是**结果**（新端口连得上、
  旧的不断），不是"两次数字不一样"；`freePort()` 这类探测在并行 worker 下有竞态，能不用就不用。
- **不要为了让 CI 变绿而删失败的测试**（这条在 `spec.md` §9 的 Never 里）。红要么修，要么记进第 8 节。
- 反复出现的红要先当**竞态**查，别当"环境抖动"放过：本轮全量跑三次红一次，定位到的是上面第一条，
  与审计本身无关。
- 服务实现里实例字段用 TS 的 `private`，**不要用 `#`**：cordis 会把服务包进 Proxy 并用替换过的
  receiver 调 getter，`#` 的品牌检查必然抛错。同理插件模块**要么只用命名导出、要么只
  `export default`**，混用会让 `inject` 被静默丢弃。

## 5. 运行期改配置的门

**OneBot 连接页**（`/yanxin/onebot`）改监听地址、端口、access token、路径、超时，**不用重启**：
参数在 settings 的 `yanxin-onebot`，服务 `watch` 到就重听。配套三条：

1. **换绑先在新地址听成功，再关旧的。** 端口被占是最常见的失败，反过来做会"旧的关了新的起不来"——
   她失联，而唯一能救她的控制台此时也看不出发生了什么。失败时保持原监听并留一行 WARN。
2. **判断要不要换绑比的是请求值，不是实际端口。** 端口写 `0` = 系统分配，用实际值比会变成
   "每次保存都换绑一次、每次又分配一个新端口"。
3. **门在服务端**：改成非回环（`0.0.0.0` / `::` / 网卡 IPv4）必须显式勾选确认，且**必须有 token**。
   这个端口没有别的东西在守——token 一空，任何能连上它的人都能冒充她的客户端，而出网守卫管不到
   那条路（它只管 harness 自己发起的请求）。认不出的地址一律按对外处理；改回回环不设卡。
4. **token 的值永不回显**（页面免凭据可读），也不进审计与回执；表单留空 = 不改，不是清空。

`/yanxin/api/log/stream` 同样按写操作要 token：流里是运行时日志原文，出口的 `redactValue`
只抹得掉**认得出的密钥形态**（键名词尾 `key|token|secret|…` 或厂商前缀），藏在路径里的值抹不掉。

## 6. shell、cwd 与审计的真实边界

- shell **无沙箱**。Windows 上 `dsh-bash-sandbox` 没有 runner——注意它**不是本包关掉的**，
  是 base 的平台门在关；`sandbox` / `sandbox-policy` / `fs-sandbox` / `approval` 四行仍然 enabled，
  被禁的只是唯一执法的 `permission`。所以"无沙箱"是平台条件性质，换 OS 就不同。
- **`cwd` 不是护栏。** 接缝上 `PreToolDecision` 只有 `allow|deny|ask`（不能改写参数），而执行形态是
  `bash -c <命令串>`——一句 `cd` 就离开任何目录。`config.cwd` 也只是默认值（`workdir ?? config.cwd ?? process.cwd()`）。
  所以工作目录是**部署责任**，审计里只记调用方要的 `requestedWorkdir`。
- 审计覆盖的判据是"名字像执行器 + 参数里有命令串"（`bash|pwsh|exec|terminal|^mcp__` ×
  `command|cmd|script`），**不只是 `bash`**——MCP 工具的执行也要留痕。
  两处如实：命令是脱敏后的（不逐字节，带 `commandRedacted` 标记）；`stdoutBytes` 是**带内**长度，
  输出超过上限时真实体积只有 spill 文件知道。
- 审计里的 `account` 是从会话命名解析的**线索**，不是身份（工具接缝没有发起者身份），
  **不要拿它做权限判定**。

## 7. 六个最容易踩的坑

1. **类型通过 ≠ 运行时存在。** 从 monorepo 启动时 bundle 解析到 monorepo 的 `packages/<包>/lib`，
   与本包 `node_modules` 里那份是两条版本线。读外部结构一律走适配层（`src/onebot/session-api.ts`）。
2. **session id 是确定性的**，冷启动必须 `resume` 优先，无脑 `create` 会撞 `id collision`。
3. **导出形式混用** → `inject` 被静默丢弃（见第 4 节）。
4. **host 平面工具泄漏**（见第 3 节）。
5. **外部后端的失败可能是"HTTP 200 + 内部异常"**。ReMe 把校验失败、LLM 404 吞进自己的日志，
   响应仍然 200，原因写在 `answer` 里而 `metadata` 是无关计数。判据不能只看状态码。
6. **判定要对着"归一化之后"的形态。** URL 解析器会把 `[::ffff:169.254.169.254]` 变成
   `[::ffff:a9fe:a9fe]`、把 `2130706433` 变成 `127.0.0.1`；只认点分写法的私网守卫会全部放行。

## 8. 已知但没修的事

按"值不值得动手"排序，都在 `spec.md` 里有更长的版本（§7.4 与 §11 R1–R8）：

| # | 事项 | 现状 |
|---|---|---|
| 1 | host 平面的 disable 清单是硬编码 id 列表，测试只断言"行数 > 10"，不与 base 的真实 `tool-*` 行做差集 | **升级即失效**：上游多一行 host tool，第 3 节那个故障会静默复活。base 现在是指向本地检出的符号链接，做差集已经可行 |
| 2 | 出网守卫只认参数名 `url` / `urls`（深度 ≤ 6），`uri` / `endpoint` / `webhook_url` 放行 | 与它"守住未知 MCP 工具"的存在理由不匹配 |
| 3 | IPv6 判定漏 Teredo `2001::/32`，以及任意 global-unicast 地址低 32 位里嵌的 IPv4 | 可达性低（要中继或站点路由），但"所有内嵌形态已覆盖"这句不成立 |
| 4 | 设置页对任何本机进程免凭据渲染配置**当前值**（端点、模型 id、端口、群号） | 保留是设计决定（只读页可不带 token）。要收紧就是把它加进需要凭据的路径清单 |
| 5 | `url-guard` 在 host 平面与三个 preset 各注册一次 | 每次出网跑两遍判定、写两条 allow 审计。无安全后果，审计可读性受损 |
| 6 | 十进制/八进制/十六进制 IPv4 字面量当前被拦，是靠 URL 解析器归一化，不是守卫自己认得这些进制，且无测试 | 上游解析器换形态就会回归 |
| 7 | shell 实际落在哪个工作目录，本包无法证明（`cwd` 在版本库外的 profile patch 里） | 部署后要自己 `pwd` 验一次 |

## 9. 本包的边界

`docs/decisions/`（ADR 踩坑记录）与任务清单不在本包里。别处出现过的 `ADR 00xx`、`T12` 这类编号
在本包**只是编号**，指不到文件——它们的结论都写进了 `spec.md`（附录 A「被证伪的初始假设」是浓缩版）。

`persona/` 出厂是空模板：结构、说话纪律、边界都在，人格内容留空。请把你与模型产生的会话数据、
记忆与审计日志留在 `$DSH_HOME/`，不要提交进任何公开仓库。
