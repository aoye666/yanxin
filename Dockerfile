# 研心 / YanXin —— 单镜像：dsh（harness）+ ReMe（同容器的记忆后端）
#
# 除了 NapCat，拉起来就能用：QQ 客户端留在宿主机，其余都在这一份镜像里。
#
# ⚠️ 两件事要知道：
#   · 镜像里跑的是**非沙箱**的 shell（`dsh-bash-local`），边界就是容器本身；
#     控制台在容器形态下对远程可达（凭据只有一个环境变量 token）。读 README 的安全一节。
#   · `third_party/reme/` 是 vendored 的第三方源树（Apache-2.0，见该目录的 UPSTREAM.md），
#     不适用本包的 PolyForm Noncommercial 条款。
#
# 构建：docker build -t yanxin:local .
# 运行：docker run -p 3080:3080 -p 8080:8080 -e LLM_API_KEY=… yanxin:local

# syntax=docker/dockerfile:1

# ── 三条下载路都可换（默认是上游）────────────────────────────────────────────
# apt / npm / pip 是三条独立的网络路，任何一条不通都会把 build 卡在那里，
# 所以三个都开成了 build-arg。国内网络这样传：
#
#   docker build -t yanxin:local \
#     --build-arg APT_MIRROR=http://mirrors.ustc.edu.cn \
#     --build-arg NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/ \
#     --build-arg PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/web/simple .
#
# ⚠️ 默认值留成上游是有意的：把镜像站写死进公开的 Dockerfile，等于让所有海外用户
#    去依赖一个中国的第三方代理站 —— 那类站点随时会关，而且我们不在它的使用条款里。
#    compose 里对应的 `build.args` 已注释好，取消注释即可。
#
# ⚠️ 实测（2026-10-02，Docker Desktop + WSL2，容器内探 `debian/dists/bookworm/InRelease`）：
#    三条路的失败形态**不一样**，别照抄网上那份"通用国内源清单"。
#      · `http://mirrors.ustc.edu.cn` → **200 / 450ms**；换上它之后 apt 两步从
#        "10 分钟才走到第 7 个包"变成 **33 秒 / 29.5 秒**
#      · `http://deb.debian.org`（默认）→ 200 / 1.3s，但**下包被限速**：
#        实测 10 分钟才走到第 7 个包。"通、但慢得像挂了"是这里最难判断的一种状态
#      · `http://mirrors.aliyun.com`、`http://mirrors.tuna.tsinghua.edu.cn` → **403**
#      · apt 走 **https** 的 tuna 失败在证书上（"The certificate issuer is unknown"），
#        而同一个容器里对同主机做裸 TLS 握手却是通的 —— "TLS 通"推不出"apt 能用它"，
#        所以这里**优先给 http:// 的源**（值要带 scheme，sed 是按前缀整段替换的）
#
#    npm 也别默认"npmmirror 一定快"：同一个 tarball 在容器里 `registry.npmmirror.com`
#    只回 **74 字节**（那是跳转体，真实吞吐当时把 pnpm 拖到 **~10 KB/s**），
#    `mirrors.cloud.tencent.com/npm/` **545ms 拿到完整包**，`registry.npmjs.org` 1218ms。
#
# ⚠️ 兜底思路"挂上宿主代理再 build"在这台机器上不成立：`127.0.0.1:7890` 只绑回环，
#    容器里连 `host.docker.internal:7890` 是 **ECONNREFUSED**。
#
# ⚠️ 换源治不了的那一类：** aggregate 出口被按 IP 限流**。实测把 npm 源换成腾讯云、
#    再把 pnpm 并发从 16 压到 4，吞吐都稳定在 **~110 KB/s**（并发假设就此证伪）——
#    也就是说"少开连接"和"换站"都没用，唯一有效的是**别下载**。
#    见下面 `AS store`：把本机已有的 pnpm store 挂进来。

# ── 依赖缓存的来源：空着也能 build ───────────────────────────────────────────
# 公开包 / CI 不传 `--build-context store=…`，这里就是一空目录，下一步照常联网装。
FROM scratch AS store

# ── builder：装依赖 + tsc ────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

ARG APT_MIRROR=
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PIP_INDEX_URL=https://pypi.org/simple
# ⚠️ `npm_config_registry` 只对 **corepack 和 npm** 有用，pnpm 不认它：实测容器里
#    `pnpm config get registry` 仍然是 registry.npmjs.org。所以 pnpm 那一步要单独把
#    `--registry=` 写在命令上（见下面 install 那行），别指望这行 ENV 顺手管到它。
ENV npm_config_registry=${NPM_REGISTRY} COREPACK_NPM_REGISTRY=${NPM_REGISTRY} PIP_INDEX_URL=${PIP_INDEX_URL}

# python3-venv 只为在 builder 里装 ReMe（运行时那份在 runtime 阶段）；git 给 pip 用。
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org/debian-security|${APT_MIRROR}/debian-security|g; s|http://deb.debian.org/debian|${APT_MIRROR}/debian|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# ⚠️ pnpm 版本要钉死，不是洁癖：store 目录名（`v11`）和 index.db 的格式是按版本走的，
#    本机的 store 是 11.13.0 写的，而 corepack 的默认版本会变（今天探到是 12.8.1）。
#    版本漂了挂进来的 store 就当没命中、全部重下 —— 那正是这一步要省掉的东西。
#    另外 lockfileVersion 是 9.0，与本仓 .npmrc 的口径一起由这个版本验证过。
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
# ⚠️ 国内镜像站常按**单 IP 并发**限流：pnpm 默认 16 条连接一起打，实测每只掉到 ~10 KB/s
#    （裸容器单连接拉同一个包是 2.5–4.5 MB/s）。
#    注：把并发压到 4 这条路**已证伪** —— aggregate 仍是 ~110 KB/s，限的是总出口不是连接数。
#    留着是因为直连上游时它仍然有用（别在慢镜像站上调高它）。
#    开成 build-arg 而不是写死：默认留空 = pnpm 自己的 16，海外直连 registry.npmjs.org 时那样最快。
ARG PNPM_NETWORK_CONCURRENCY=
ENV npm_config_network_concurrency=${PNPM_NETWORK_CONCURRENCY}

# 依赖层先拷：package.json 没变就不会重跑 install（pnpm 的锁校验也在这一步）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
#
# 挂本机的 pnpm store，别再走网络（文件头那段实测）。用法：
#
#   docker build -t yanxin:local \
#     --build-context store=E:/.pnpm-store/v11 \
#     --build-arg APT_MIRROR=http://mirrors.ustc.edu.cn .
#
# 三个细节：
#   · 只读 bind 不能当 store-dir 用（pnpm 要写 index.db / projects/），所以先拷进一个
#     **cache mount**：既不落进镜像层（否则 builder 白背 1.5 GB），还能跨 build 复用。
#   · `--store-dir` 传的是**根**，pnpm 自己在下面开 `v11/`，所以要把 context 的内容
#     放进 `/pnpm-store/v11/`，不能直接铺在 `/pnpm-store/`。
#   · 没传 context 时 `/host-store` 是空的（`FROM scratch AS store`），条件短路掉，
#     下一步就是纯网络安装 —— 公开包和 CI 的行为不变。
#
# ⚠️ cache mount 会**留旧**：本机 store 更新了（新增包/换版本）这里不会自动跟上，
#    表现为又开始下载缺的那些。要强制重来：`docker builder prune --filter type=exec.cachemount`。
RUN --mount=type=bind,from=store,target=/host-store,readonly \
    --mount=type=cache,target=/pnpm-store \
    if [ -d /host-store/files ] && [ ! -d /pnpm-store/v11 ]; then \
      mkdir -p /pnpm-store/v11 && cp -a /host-store/. /pnpm-store/v11/; \
    fi \
 && pnpm install --frozen-lockfile --store-dir /pnpm-store --registry="${NPM_REGISTRY}"

# ReMe：从仓里的 vendored 源装进独立 venv（构建期不碰 GitHub）。
# ⚠️ **不装 `[core]`**，装的是 `[as]` + pillow/jieba/rjieba，理由是取证取到的：
#    `reme/config/default.yaml` 里 embedding / faiss / zvec / neo4j 全部是注释掉的，
#    file_graph 与 keyword_index 的 backend 都是 `local`，tokenizer 的 backend 是 `regex`
#    —— 也就是说 BM25 召回这条路上一个向量检索的包都不碰。`core` 会多拖进
#    faiss-cpu / polars / neo4j / zvec / claude-agent-sdk / openai-codex / pproxy，
#    实测 venv 从 **385 MB 涨到 1.1 GB**（本机那份就是装了 core 的体积），全是白背的。
#      · `agentscope` 留：`reme/components/as_llm/__init__.py` 是**模块级** import，
#        `import reme.components` 就要求它在场（auto_memory / auto_dream 走的正是 as_llm）
#      · `pillow` 留：`auto_image_resource` 里是函数内 import，缺了不会崩，但 QQ 图片
#        进 resource/ 时那条沉淀路会静默失败 —— 4 MB 换一条不静默的路，值
#      · `jieba` / `rjieba` 留：default.yaml 现在用 regex 切词，**没在跑**；带上是为了
#        把 `tokenizer.backend=jieba` 变成改配置就行，而不是重新 build 一次镜像
# ⚠️ pip 的源要挑**又全又新**的：aliyun 全（core 的 11 个重包逐个数过），
#    USTC 缺 `openai-codex`（404），tuna 从容器里直接 403（宿主机上却是通的，别拿宿主机的结论当准）。
#    实测 aliyun 拉这一套 141 个包 262 秒 ≈ 760 KB/s。
# ⚠️ 别在这行外面再补一个 `reme_studio`：索引上根本没有对应版本（只到 0.1.1），
#    本机那个 0.1.2 是从源树可编辑装的；而 ReMe 对它的 import 包在 try/except 里，缺了照样起。
#    `core` 里那条自引用 `reme-ai[as]` 也已经在这份副本里改掉了，理由写在
#    `third_party/reme/UPSTREAM.md` 的"我们对这份副本动过的两行"。
COPY third_party/reme ./third_party/reme
# ⚠️ 冒烟判据是 **import 闭包**，不是 `reme --help`：ReMe 的 CLI 把第一个参数当 action，
#    `--help` 会被当成"向正在运行的服务 POST /--help"（`reme/reme.py` 的 `call_server`），
#    build 期当然没有服务 → `httpx.ConnectError` → 整层失败。这条实测于 2026-10-03。
#    `import reme.components` 正好是要证的事：组件注册表把所有子包都模块级 import 一遍，
#    瘦装了哪些、漏了哪个，这里直接见分晓。
# ⚠️ pip 用 cache mount（所以**不带** `--no-cache-dir`）：这一层要下 141 个包 ≈ 500 秒，
#    迭代 Dockerfile 时不该每次重下。缓存不落到镜像层里。
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m venv /opt/reme \
 && /opt/reme/bin/pip install --upgrade pip \
 && /opt/reme/bin/pip install './third_party/reme[as]' pillow jieba rjieba \
 && /opt/reme/bin/python -c "import reme, reme.components; print('reme', reme.__version__, 'components ok')"

# 源码与产物：入口是 lib/，而 **patch 里的插件行写的是 'yanxin/src/…ts'** ——
# 两处都要（这条口径的来历见 docs/development-notes.md「构建与产物」）。
# ⚠️ 目录源必须写成 `COPY <目录> <目录>`（目标**不**以 / 结尾）：`COPY persona ./` 拷的是
#    persona 的**内容**，会把 base.md / profile.md 摊平到 /app 根上，/app/persona 压根不存在。
#    这一条栽过一次 —— build 当时不报错，直到 runtime 阶段 `COPY --from=builder /app/persona`
#    才炸出 "not found"（setup 是靠 defaultPackageRoot() 找 persona/ 与 presets/ 的）。
# ⚠️ 顺序也是有意的：ReMe 那层要 500 秒，把它放在源码 COPY **之前**，
#    改 persona / src 就不会连带重跑 pip。
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY persona persona
COPY presets presets
COPY cordis.patch.yml ./
RUN pnpm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

ARG APT_MIRROR=
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY} COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ⚠️ runtime 阶段**必须也有 pnpm**，这不是"顺手装个工具"：`dsh plugin add` 内部就是调 pnpm。
#    缺它时首启容器链不上本仓，插件树里 `@deepseek-ai/dsh-tool-bash` 与
#    `@deepseek-ai/dsh-permission-presets` 会永远 pending (waiting for service: shell)，
#    dsh 以 exit 1 收场 —— 这条是 2026-10-04 第一次真把容器跑起来才暴露的
#    （"build 过了"和"拉起来能用"确实是两件事，同 ReMe 那个教训）。
#    版本钉死成 builder 同一版：pnpm 的 store 目录与 index 格式按版本走，漂了就当没命中。
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate

RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org/debian-security|${APT_MIRROR}/debian-security|g; s|http://deb.debian.org/debian|${APT_MIRROR}/debian|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# DSH 运行时（公开 npm 包）。本仓的装配按这一版写，换版要先重核 spec（ADR 0002 的版本策略）。
# ⚠️ 重试参数不是可有可无：国内镜像站转发 `@deepseek-ai/*` 时会**偶发 ECONNRESET**
#    （2026-10-04 在 WSL 引擎上实测：跑到 170 秒 read ECONNRESET / errno -104 直接退出，
#    同一条命令在 Docker Desktop 上却是通的）。默认重试次数扛不住这种断法。
RUN npm install -g --fetch-retries=8 --fetch-retry-factor=2 --fetch-retry-mintimeout=5000 \
      --fetch-retry-maxtimeout=120000 @deepseek-ai/dsh@0.1.5-rc.3

# ReMe 的 venv（`reme` 可执行文件在 PATH 上）
COPY --from=builder /opt/reme /opt/reme
ENV PATH=/opt/reme/bin:$PATH

WORKDIR /app
# node_modules 整份带走：本仓把 @deepseek-ai/dsh-* 放在 devDependencies 里满足 peer 约束
# （.npmrc 关掉了自动装 peer），所以**运行时也要 devDeps** —— 不要在这里改成 --prod。
# ⚠️ 属主用 COPY 的 `--chown` 定，**不要**改写成最后一条 `RUN chown -R node:node /app`：
#    那条 RUN 会把 /app 整个复制成一个新层（实测多要 ≈ 2 GB），镜像直接翻倍。
#    （/app 其实连"可写"都不需要：控制台写人格落到 `$DSH_HOME/yanxin/persona`，
#    回填的 preset 落到 `$DSH_HOME/.agent-presets/`，两处都在卷里 —— 见 install.ts 的
#    personaDir() 与 installPresets()。这里给 node 只是让"谁读它"这件事一眼看得清。）
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/lib ./lib
COPY --chown=node:node --from=builder /app/src ./src
COPY --chown=node:node --from=builder /app/persona ./persona
COPY --chown=node:node --from=builder /app/presets ./presets
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc cordis.patch.yml ./

# 入口与部署模板（entrypoint 渲染 profile patch 要读 deploy/ 下那份 docker 模板）
COPY --chown=node:node deploy ./deploy
COPY --chown=node:node docker ./docker
# 许可与来源档案留进镜像，运维在容器里也能查到"这份 ReMe 是哪一版"
COPY --chown=node:node third_party/reme/LICENSE third_party/reme/UPSTREAM.md ./third_party/reme/

ENV DSH_HOME=/home/node/.dsh \
    HOME=/home/node \
    YANXIN_REME_WORKSPACE=/data/reme \
    NODE_ENV=production \
    YANXIN_WEB_PORT=3080 \
    YANXIN_ONEBOT_PORT=8080

# ── 把 profile 烘进镜像：首启不必再联网装配 ─────────────────────────────────
# `dsh plugin --profile yanxin add /app` 会在 `$DSH_HOME/profiles/yanxin/package.json`
# 里写下 `"yanxin": "link:/app"`、把 `dsh.profile.bundles` 补全，再调 pnpm 装出 profile 的
# node_modules。放在**构建期**做有两个硬理由：
#   · 运行时那条要联网装依赖，而首启那台机器很可能正卡在某个镜像站上（本机的真实速率见顶部）；
#   · `/home/node/.dsh` 是命名卷，Docker 在卷**首次创建**时把镜像里这一层的内容灌进卷 ——
#     所以新装的实例一起来装配就是完整的，这才是"拉取就能用"的正解。
# ⚠️ 只对**命名卷**成立。bind mount 一个空目录当 `$DSH_HOME` 是拿不到种子的，
#    那种情形由 `docker/entrypoint.mjs` 里那条兜底的 `dsh plugin add` 现场补链。
#
# ⚠️ 第二个 add 不是冗余：`logger-console` 这个 provider **不在发布版 base 的树里**
#    （base 只带 `session-log-deepseek`），而 patch 里那行要用它。它的 import 上下文是
#    **profile 目录**（报错原文：`imported from /home/node/.dsh/profiles/yanxin/`），
#    所以塞进 /app/node_modules 不算解决 —— 必须装进 profile。
#    版本钉 **1.0.2**：那是 peer 对得上本基线（cordis ^4.0.2 / schemastery ^3.18.2）的最后一版；
#    1.0.3 要 ^4.0.3、1.0.4 要 ~4.0.4，装了就又是"两份 cordis 实例"那个坑（见 .npmrc 的记录）。
RUN mkdir -p /home/node/.dsh && dsh plugin --profile yanxin add /app \
 && dsh plugin --profile yanxin add '@deepseek-ai/cordis-plugin-logger-console@1.0.2' \
 && grep -q '"yanxin": "link:' /home/node/.dsh/profiles/yanxin/package.json \
 && ls /home/node/.dsh/profiles/yanxin/node_modules/@deepseek-ai/cordis-plugin-logger-console/package.json >/dev/null

# 两个卷的挂载点：/home/node/.dsh 是她的全部状态（会话 / 世界 / 审计 / 人格 / preset），
# /data/reme 是记忆。**两个都不留就等于换了个人** —— README 里那句警告对应这里。
# （/app 不在这条 chown 里，理由见上面那段：会白复制一层 2 GB。）
RUN mkdir -p /home/node/.dsh /data/reme && chown -R node:node /home/node /data/reme
USER node

EXPOSE 3080 8080
VOLUME ["/home/node/.dsh", "/data/reme"]

# 健康判据用首页（容器内是回环，免凭据只读 —— 不为健康检查新开免鉴权接口，那是永久后门）。
# 已核控制台没有 api/health 这一路。`-L` 是因为裸 `/yanxin` 会 308 到 `/yanxin/`。
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -fsS -L "http://127.0.0.1:${YANXIN_WEB_PORT}/yanxin/" || exit 1

ENTRYPOINT ["node", "/app/docker/entrypoint.mjs"]
