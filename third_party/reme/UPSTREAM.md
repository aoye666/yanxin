# `third_party/reme/` —— vendored ReMe 源树

本目录**不是我们的代码**，是第三方记忆后端 **ReMe** 的一份源码副本。
镜像构建时从这里 `pip install`，所以 `docker build` 不依赖 GitHub 可达。

## 现场档案

| 项 | 值 |
|---|---|
| 上游 | <https://github.com/agentscope-ai/ReMe> |
| commit | `bebad3674573477ad294ca44eb15f508feea2665`（2026-09-26） |
| 版本 | **0.4.1.13**（`reme/__init__.py` 的 `__version__`） |
| 许可 | **Apache-2.0**（见同目录 `LICENSE`，作者：阿里巴巴通义实验室 EconML 团队） |
| Python | `>= 3.11` |
| 我们装的 extras | **`as`**（只有 agentscope）+ 单独点名 `pillow` / `jieba` / `rjieba`，**不装 `core`** |

⚠️ 这一行 2026-10-03 改过口径，判据是 `reme/config/default.yaml`：**embedding / faiss / zvec /
neo4j 那几段是注释掉的**，`file_graph` 与 `keyword_index` 的 `backend` 都是 `local`，
`tokenizer` 的 `backend` 是 `regex` —— BM25 召回这条路上一个向量检索的包都不碰。
`core` 多拖进来的 faiss-cpu / polars / neo4j / zvec / claude-agent-sdk / openai-codex / pproxy
实测把 venv 从 **385 MB 抬到 1.1 GB**。留下的三个：

| 包 | 为什么留 |
|---|---|
| `agentscope`（`as` extras） | **模块级必需**：`reme/components/as_llm/__init__.py:3` 是顶层 import，`import reme.components` 就会拉它；auto_memory / auto_dream 走的是 as_llm |
| `pillow` | `steps/evolve/auto_image_resource.py:34` 是函数内 import —— 缺了不崩，但 QQ 图片进 `resource/` 时那条沉淀路**静默**失败 |
| `jieba` `rjieba` | 当前配置**没在用**（tokenizer 是 regex）；带上是为了 `tokenizer.backend=jieba` 只改配置、不用重 build |

瘦装法实测过：容器里 `pip install './third_party/reme[as]' pillow jieba rjieba` 起服务，
`POST /health_check`（体是 `{}`）与 `POST /search` 都正常，零 ImportError。

## 这份副本里有什么、为什么

只带**最小可装集**（1.9 MB / 221 个文件）：

- `reme/` —— 包体本身。含 14 个 `.yaml`（`[tool.setuptools.package-data]` 要的）
  与 `reme/components/tokenizer/stopwords`（`jieba_tokenizer` 要的）。
- `pyproject.toml` / `README.md` —— 装起来的两条硬要求（`readme` 字段指向 README.md）。
- `LICENSE` —— Apache-2.0 原文，**必须随树存在**。

**不带**（以及为什么可以放心不带）：

- `reme_studio/` —— 它自己的 Web UI。上游 `pyproject.toml` 写死了
  `packages = { find = { include = ["reme", "reme.*"], exclude = ["reme_studio*"] } }`，
  所以它**不参与 `reme-ai` 的构建**。运行时也不需要：`reme/utils/web_static.py` 里那句
  `from reme_studio import static_dir` 是包在 `try/except ImportError` 里的**可选**探针，
  拿不到就退到"没有静态目录"，服务照常起。
  ⚠️ 别想着从 PyPI 补一个回来：索引上 `reme-studio` **只有 0.1.1**（pypi.org / aliyun 都只列到
  0.1.1，2026-10-03 实测），而本机那个 0.1.2 是从这份源树**可编辑安装**出来的（`direct_url.json`
  里写着 `editable: true`）—— 它从来不是一个 PyPI 发布版。上游自己的 `README.md` 第 97 行就写着
  `pip install -e reme_studio -e ".[core]"`，是同一件事。
- `docs/`(12 MB)、`integrations/`、`benchmark/`、`tests/`、`github-pages/`、`skills/`、`plugins/` ——
  已逐目录 grep 过 `reme/` 包体：**没有任何一处按相对路径去找兄弟目录**，砍掉不影响装载与运行。
- `__pycache__/`、`*.egg-info/`、`.git/` —— 本机那份是 `pip install -e` 的开发态产物，镜像里不需要。

## 我们对这份副本动过的两行（都在 `pyproject.toml` 的 `core` extras 里）

| 上游原文 | 改成 | 为什么 |
|---|---|---|
| `"reme-ai[as]"` | `"agentscope[model-ollama]==2.0.8"` | **自引用**：`reme-ai` 就是这个包自己。留着它，`pip install ./third_party/reme[core]` 会去索引上另拉一份 **PyPI 的 reme-ai**（0.4.1.12，比这份源码低一版）装进同一个 venv，盖掉的正是我们要装的那份 —— vendor 就白做了。展开成 `as` extras 的内容，等价且不再自引用。 |
| `"reme_studio"` | （删掉） | 见上面那条：可选 import，且索引上没有对应版本，装上只会让 build 失败。 |

⚠️ **升级第 2 步之后必须重看这两行**：上游哪天改了 `core`，这里的改写就要跟着重做一遍，
否则会静默漏装或多装依赖。

## 升级它（顺序不能换）

```bash
# 1) 取新 commit（把 <sha> 换成要钉的那个）
git clone --filter=blob:none https://github.com/agentscope-ai/ReMe.git /tmp/reme-new
git -C /tmp/reme-new checkout <sha>

# 2) 重新生成最小集（与上面"这份副本里有什么"逐条对应）
rm -rf third_party/reme && mkdir -p third_party/reme
cp -r /tmp/reme-new/reme /tmp/reme-new/pyproject.toml /tmp/reme-new/README.md /tmp/reme-new/README_ZH.md \
      /tmp/reme-new/LICENSE third_party/reme/
find third_party/reme -name '__pycache__' -type d -prune -exec rm -rf {} +

# 3) 改这份 UPSTREAM.md 的 commit / 版本两行

# 4) **重建镜像并跑 health_check** —— 这是唯一的真判据
docker build -t yanxin:local . && docker run -d --name yanxin-smoke -e LLM_API_KEY=… yanxin:local
docker exec yanxin-smoke curl -sS -X POST http://127.0.0.1:2333/health_check
```

⚠️ 第 4 步不能省：**ReMe 的失败藏在 HTTP 200 里**（spec 附录 A、ADR 0014 决策六），
"装上了"和"能用"是两件事。升级后先看 `POST /health_check`，再动我们自己的代码。

## 两件仍未做完的事

- **署名待补**（2026-10-02 由维护者显式推迟）：本包整体是 **PolyForm Noncommercial**，
  而这个子目录是 **Apache-2.0，不适用本包的许可条款**。发布前要在 `README.md` 的许可证一节
  加一句第三方声明，并把 Apache-2.0 要求的"保留许可与声明"落实清楚。
  **这条已同步挂在 `docs/development-notes.md` 的"已知未修"清单里，别让它静悄悄消失。**
- `core` extras 不要再装回来：判据与体积对比都在上面"我们装的 extras"那一节。
  哪天 `default.yaml` 把 embedding / faiss 打开（上游改了默认值也算），再按需要点名具体包，
  并且**重新量一次 venv 体积**。
