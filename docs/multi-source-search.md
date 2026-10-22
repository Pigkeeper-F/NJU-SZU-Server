# 多检索源：能力、边界与人工路径

> 2026-10-21 落地。原先只接通 Google Scholar；本文说明现在能检索哪些源、
> 各自要不要人工/凭据、以及还检索不到的源怎么办。
> 配套契约 `docs/contract.md` §21（来源校验）、§22（上游产物汇聚）。

## 一、现状一览

| 来源 | 状态 | 人工 | 凭据 | 全文 | 备注 |
|---|---|---|---|---|---|
| **Google Scholar** | 可执行 | **要**（人机验证） | 无 | 仅出版方 | 走浏览器自动化，验证码不绕过 |
| **PubMed** | 可执行 | **不要** | 可选 `NCBI_API_KEY` / `NCBI_EMAIL` | 摘要必有；正文仅 PMC 开放获取子集 | NCBI E-utilities，无登录 |
| **PMC** | 可执行 | **不要** | 同上 | 有（开放获取子集） | PubMed 的全文库 |
| **OpenAlex** | 可执行 | **不要** | 可选 `OPENALEX_API_KEY` | 一般无（有开放获取链接） | 2 亿+ 条元数据，跨学科 |
| **Europe PMC** | 可执行 | **不要** | 无 | 多数有 | 欧洲的 PubMed 镜像，含预印本 |
| 知网 | **需人工** | 要（登录+验证码） | 机构账号 | 部分 | 程序化直连会被拦截；**本工具不绕过验证码** |
| 万方 | **需人工** | 要（登录+验证码） | 机构账号 | 部分 | 同上 |
| Web of Science | **需人工** | 要（订阅+导出） | 机构订阅 | 部分 | 订阅资源，本工具不代持凭据 |
| Scopus | **需人工** | 要（订阅+API Key） | 机构订阅 | 部分 | 订阅资源，本工具不代持凭据 |

**核心变化**：A 类（PubMed / PMC / OpenAlex / Europe PMC）**完全无人工**——不启动浏览器、
不需要过验证码、不需要登录，而且拿到的**摘要比 Scholar 的题录片段完整得多**
（实测 PubMed 摘要 1800–2000 字，Scholar 片段通常只有一两句），这直接改善环节①的要点抽取质量。

## 二、怎么用

### 2.1 在界面上

新建文献作业时，来源选开放源即可（如 `pubmed` + `openalex`）。
检索阶段会**完全绕开浏览器**，不需要过 Scholar 验证码。

### 2.2 配置文件里

`run_config.json` 的 `sources` 数组：

```json
{
  "topic": "长期施肥对土壤有机碳的影响",
  "query": "long-term fertilization soil organic carbon",
  "sources": ["pubmed", "openalex", "europe-pmc"],
  "limit": 10
}
```

`limit` 是**每个来源**各取多少条（沿用既有语义：1–10）。

### 2.3 联调单个源

```bash
python tools/literature_search_open.py --source pubmed --query "soil carbon" --limit 3
```

### 2.4 混合来源

目前一次作业**要么走 Scholar、要么走开放源**（避免浏览器路径与 API 路径的候选合并语义变复杂）。
想两个都要，就建两个作业——下游的跨批去重本来就会把重复的合掉。

## 三、产物结构（下游零改动）

开放源产出的 `candidates.json` / `candidates.csv` 与 Scholar 路径**完全同构**，
所以去重 → 全文获取 → 参数提取 → 校验 → 导出五个阶段**一行都不用改**。

差异点：

- `source` 字段变成 `"PubMed、OpenAlex"`（多源时用顿号连接）
- `scope` 变成 `open_api_candidates`（Scholar 是 `first_page_candidates_only`）
- 新增 `sources` 字段，逐源记录检索 URL、条数、状态、错误
- 候选 id 前缀按来源取自注册表：`GSC` / `PMD` / `PMC` / `OAX` / `EPMC`
- `year` / `authors` / `venue` 取**结构化字段**（开放 API 原生带），不再从 byline 字符串猜

## 四、B 类（检索不到的那几个）怎么办

知网 / 万方 / Web of Science / Scopus 这几个，**程序化直连一定会被拦**（登录态、验证码、订阅授权）。
本工具**不绕过验证码、不代持订阅凭据**——这是设计底线，不是没做。

能落地的三条路：

1. **手动导出 → 导入**：在知网/WoS 自己的界面检索，导出 RIS / BibTeX / EndNote / CSV，
   放进作业目录，用「导入清单」进入候选池，之后的去重/全文/提取照常走。
   格式与字段见注册表里各源的 `importFormats`。
2. **浏览器辅助**：用你自己的登录态在浏览器里检索，把题录复制进作业目录的清单文件。
   本工具只负责**从清单读题录**这一步。
3. **机构订阅 API**：若学校买了 WoS/Scopus 的 API 配额，拿到 Key 后按各家的官方 API 接入
   （`Scopus` 的检索 API 配额是按次计的，`Web of Science` 的 Expanded API 需要机构 token）。
   这属于「订阅凭据由使用者自己提供」，不写进仓库。

## 五、速率与合规

- **NCBI**：无 Key 3 请求/秒，配 `NCBI_API_KEY` 可到 10 请求/秒。脚本内置节流。
- **OpenAlex**：有 polite pool（带 `mailto` 进 `OPENALEX_API_KEY` 所在分组可获得更稳的配额）。
- **Europe PMC**：无硬限制，但脚本同样做了节流。
- 每次检索都会**记录检索 URL 与实际应用的筛选条件**（`batches[].search_url`、`applied_filters`），
  便于复现与审计。
- 摘要与正文的使用仍受各出版方条款约束：**取不到就标「待补充」，不绕过**。

## 六、代码位置

| 文件 | 作用 |
|---|---|
| `tools/literature_search_open.py` | 开放 API 检索：请求构造、限流、响应解析、各源 runner |
| `tools/literature_search.py` | 检索阶段主脚本；新增开放源分派与多源候选 id 前缀 |
| `tools/literature_sources.py` / `.json` / `literature-sources.js` | 来源注册表（可执行 / 需人工、原因、凭据、限流、id 前缀） |
| `tools/test_literature_search_open.py` | 离线回归（80 项断言，不联网） |

## 七、已知限制

1. 一次作业**不混跑** Scholar 与开放源（见 §2.4）。
2. PubMed 走 `esearch → esummary → efetch`；`efetch` 的 DOI 认 `ELocationID` 与 `ArticleId` 两个位置。
3. Europe PMC 的 `pubYear` 真实返回是字符串，解析两种都收。
4. 开放源的**全文**覆盖率低于出版方授权源：OpenAlex 基本只有元数据 + 开放获取链接，
   PubMed/PMC/Europe PMC 能拿到开放获取子集的正文。
5. `tools/literature_fulltext.py` 目前只对 Scholar 作业验证过全文抓取路径；
   开放源作业的全文获取**还需要一轮联调**（这是下一步）。

---

## 八、人工源怎么用：清单导入（已实现，2026-10-21）

知网 / 万方 / Web of Science / Scopus 程序化直连必被拦，**本工具不绕过验证码、不代持订阅凭据**。
唯一诚实的路径是「**源站自己检索 → 导出题录 → 导入候选池**」，这条路现在已经做实了。

### 8.1 操作步骤（以知网为例）

1. 在知网检索，勾选要用的文献 → 点「**导出/参考文献**」→ 选 **RIS**（或 EndNote / BibTeX）
   → 下载得到 `.ris`（或 `.bib`）文件。
   > 万方：检索结果页「导出」→ 选 RIS / EndNote。
   > Web of Science：结果页「Export」→ **RIS** 或 **BibTeX**。
   > Scopus：结果页「Export」→ **RIS**。
2. 回到工作台，进「① 文献调研」模块，把当前环节跑过一次检索（这样才有作业可挂靠）。
3. 调研面板底部那行「**检索不到的源（知网/万方等）**」→ 选来源 → 点「**导入清单**」→ 选刚才的文件。
4. 提示「已导入 N 条（候选池共 M 条）」即成功；候选池里这些条目带
   `CNK-I001` 这样的 id（来源前缀 + `-I` 表示导入批次），可直接参与初筛与后续全流程。

### 8.2 语义（重要）

- **导入批次 `batch_index = 0`**，与检索批次（1/2/…）分开记，便于回溯"这条是导进来的"。
- **同一份清单重复导入 = 整批替换**，不会越导越多。
- 导入条目一律 `screening_status = pending_review`：**不自动判"不相关"**，
  是否纳入由人工初筛决定——与检索来的条目完全同权。
- 产物仍是 `candidates.json / candidates.csv`，下游去重 → 全文 → 提取 → 校验 → 导出**零改动**。

### 8.3 格式支持

| 格式 | 说明 |
|---|---|
| **RIS** | 知网/万方/WoS/Scopus 导出通用；字段 AU/TI/JO/PY/DO/AB/UR |
| **BibTeX** | 字段 title/author/journal/year/doi/abstract/url；`and` 连接的多作者会转成逗号 |
| **CSV** | 表头支持中英文（标题/作者/期刊/年份/DOI/摘要 或 title/author/journal/year/doi/abstract） |

格式可自动识别（按扩展名 + 内容特征），也可在界面上显式选择。

### 8.4 相关代码

| 文件 | 作用 |
|---|---|
| `tools/literature_import.py` | RIS/BibTeX/CSV 解析 + 并入候选池（batch_index=0，整批替换） |
| `server.js` `POST /api/literature/import` | 端点：`{jobId, source, content, format?}` → 写入作业候选池 |
| `js/chat.js` | ①调研面板底部的「导入清单」入口（选来源 + 选文件） |
| `tools/test_literature_import.py` | 离线回归：38 项断言（解析/识别/并入/整批替换/坏输入） |

### 8.5 知网能导入多少？

知网免费账号通常**单次导出有条数上限**（常见 20–50 条，视版本），建议分批导出、分次导入——
同一份清单重复导入会整批替换，但**不同清单会累加**，所以分批要换文件名/内容。
