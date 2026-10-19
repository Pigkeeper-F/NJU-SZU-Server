# 文献挖掘·第二阶段落地方案（契约冻结版）

- 版本：D1c 冻结稿（2026-10-15）。本文件是后续四个实现任务（I1–I4）与网页接线（W1a/W1b）的**唯一接口真相**；只定义契约与切分，不含实现代码，不改动任何既有代码。
- 依据：D1a《参考管线解剖》（任务笔记 7 条）、D1b《现存实现解剖》（任务笔记 8 条）、`docs/literature-mining-alignment.md`（研究者已确认规则）、`docs/literature-mining-workflow.md`（设计 7 步）、`README.md` 文献段、`docs/contract.md`（§1–§20，本阶段新增 §21 见该文件）。
- 冻结原则：**向后兼容优先**。所有扩展一律为「可选字段 / 新增文件 / 新增路由」；既有文案、校验、状态语义不动（不回归清单见 §10）。凡本文未写死的实现细节，实现者可自由发挥，但不得偏离本文冻结的字段名、取值域、路径与文案。

---

## 0. 术语与总览

| 术语 | 含义 |
|---|---|
| 阶段（stage） | 流水线的一个可独立运行/断点续跑的步骤：`discover / dedupe / fulltext / extract / validate / export` |
| 任务（job） | `.workbench/literature/<uuid>/` 目录承载的一次完整文献挖掘任务；跨多个阶段、可多次续跑 |
| 事件（event） | 阶段脚本 stdout 输出的单行 JSON（NDJSON），类型固定 4 种：`stage / attention / error / result`（D1b note1/note2） |
| 交接点①| Node 连接器（网页形态驱动，W1a） |
| 交接点②| Python 总控 `literature_pipeline.py`（命令行形态驱动，I1） |
| 交付物 | 经批准的、允许下载的任务产物，登记在 `job.files`（W1a 维护） |
| 人在环关口 | 需要人工介入的暂停点：验证码（`verification`）与字段确认（`awaiting_confirmation`） |

流水线（一个大任务）：

```
discover ──► dedupe ──► fulltext ──►[关口: awaiting_confirmation]──► extract ──► validate ──► export
 第一批≤10条   跨批次/跨来源   HTML优先/PDF备选    研究者确认字段含义/单位      规则校验      文献表+参数明细
    │            归并去重          （验证码→人工）        （alignment L9 硬关口）     阻断/待审核   CSV+Excel
    └── 续批（batch.maxBatches）可回到 discover 追加新批次
```

---

## 1. 总体架构

### 1.1 五层链路不变（D1b note1）

保持现有分层：UI（`js/codex.js`）→ 路由（`server.js` `handleLiterature`）→ 连接器（`tools/literature-connector.js`）→ 配置归一（`tools/literature-config.js`）→ Python 阶段脚本 → （可选）SOC 复用脚本。本阶段只在这五层的既有接缝上扩展。

### 1.2 唯一编排点泛化（D1b note2 ①）

`literature-connector.js` 的 `run(job)` L152–183 是唯一编排点，第一阶段把「prepare → search」两步硬编码为顺序逻辑。第二阶段：

- 改为 **steps 数组**：`steps = [{stage:'discover', run}, {stage:'dedupe', run}, …]`，按序执行，每步产出事件流；
- `runSearchProcess`（L66–109）泛化为 **`runStage(scriptName, extraArgs, job, onEvent)`**：仍是「spawn python -u <script> --config <job>/run_config.json --output-dir <job> + stdout NDJSON 解析」的通用执行器，新增阶段脚本全部复用同一协议；
- job 增加 `resumeStage` / `stages` 字段表达多阶段进度（见 §4.3），`resumeCurrent`（captcha 恢复）机制原样保留。

### 1.3 双驱动模式

| 驱动 | 位置 | 职责 | 归属 |
|---|---|---|---|
| Node 连接器（网页） | `tools/literature-connector.js` | 逐阶段 spawn、事件→状态机、交付物登记、`advance` 续跑、写 `events.jsonl` | W1a |
| Python 总控（命令行） | `tools/literature_pipeline.py` | 顺序调用同一批阶段脚本（subprocess），NDJSON 透传，可选写 `events.jsonl` | I1 |

两者**共享同一批阶段脚本与产物约定**，互不嵌套（网页路径不经 pipeline.py）。每个阶段脚本都必须可被两者以相同 CLI 独立调用。

### 1.4 LLM 归属（架构决策）

参考管线的「提取」在 SOC 中是 Codex 智能体按 SKILL 契约直接完成（D1a 提取卡片）。网页线的 LLM 桥（`tools/codex-bridge.js`，持久 `codex app-server` stdio JSON-RPC）**只能在 Node 侧**使用，Python 脚本无法承载。因此：

- **extract 阶段 = Python 半（I4：bundle 生成 + 结果校验）+ Node 半（I4：`tools/literature-extract.js` 适配器，经 CodexBridge 逐篇调用）**；
- 适配器由 W1a 在 `server.js` 组装连接器时注入（沿用现有 `options.prepare` / `options.search` 可注入测试模式）；
- 不修改 `codex-bridge.js` 的 capabilities 逻辑：bundle 全文以**消息文本**形式传入（不依赖模型的文件工具），避免触碰 bridge 既有分支。

---

## 2. 阶段 CLI 契约（验收①）

### 2.1 通用调用规范

所有阶段脚本（`tools/literature_*.py`）遵守：

- 调用形态：`python -u <script> --config <job>/run_config.json --output-dir <job> [阶段参数] [--resume]`；由 `__file__` 推导项目根（同 `literature_search.py` L18），不依赖 cwd；
- 环境：驱动方 spawn 时必须注入 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`（§8.2）；脚本内 `sys.stdout.reconfigure(encoding='utf-8')` 作二次防线；
- stdout：**严格 NDJSON**，每行一个 JSON 对象、`ensure_ascii=False`、逐行 flush；除事件外不得输出任何内容到 stdout；
- stderr：人类可读日志（驱动方截尾 2000 字符用于错误展示）；成功时允许为空；
- 无 stdin 交互、无网络安装、无交互确认；所有科学判断关口以 `attention` 事件暂停而不是等待输入；
- 目录不存在时自建（`mkdir(parents=True)`）；所有 JSON 落盘用「同目录临时文件 + 原子替换」，CSV 用 UTC-8-sig 写入。

### 2.2 NDJSON 事件协议（冻结，D1b note1 归纳的 4 类型）

| 类型 | 必填字段 | 可选字段 | 驱动方语义 |
|---|---|---|---|
| `stage` | `type:"stage"`, `stage`, `message` | — | 更新 job.stage / job.message（现有逻辑逐字不变） |
| `attention` | `type:"attention"`, `stage`∈`{verification, awaiting_confirmation}`, `message` | `counts?` | job.status=`needs_attention`；驱动方设 `resumeStage` 并暂停；**退出码 0**（现状保持） |
| `error` | `type:"error"`, `message` | `stage?` | job.status=`failed`，job.error=message |
| `result` | `type:"result"`, `stage`, `message` | `count?`, `files?[]`, `counts?{}` | 本阶段成功完成；`files` 为**相对 job 目录的 POSIX 路径**（如 `dedupe/dedupe.json`），须通过交付物登记校验（§3.8/§21.7）后才登记进 `job.files` |

约束：

- 一次进程运行必须且只能以「`result`（exit 0）」「`attention`（exit 0）」「`error`（exit 1）」三者之一收尾；干净退出但无收尾事件 → 驱动方按失败处理（discover 沿用既有文案『检索脚本未返回结果』，其他阶段用『阶段脚本未返回结果』）；
- `stage` 取值为 §2.5 词汇表；未知值驱动方原样透传不报错（向前兼容）；
- 事件可携带额外统计字段（如 `batch_index`、`fetched`），驱动方忽略不认识的字段。

### 2.3 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功完成（含 `attention` 暂停——人工关口不是失败） |
| 1 | 失败（脚本内已 `emit("error", …)`；驱动方优先采用 event.message） |
| 2 | 用法错误（argparse 默认行为；驱动方按失败处理，stderr 尾部展示） |

### 2.4 六个阶段脚本逐一

下列 `--config` / `--output-dir` 省略书写。所有阶段执行前须自校验 run_config（脚本侧二次防线，模式同 `literature_search.py` L131）。

#### 2.4.1 `tools/literature_search.py`（discover，I1 改造）

```
python -u tools/literature_search.py --config C --output-dir D
        [--scrape-current] [--batch-index N] [--resume]
```

- 现状参数 `--config/--output-dir/--scrape-current` 语义与文案逐字不变；
- `--batch-index N`：续批/重试指定批次号；缺省 = 1 + 已有最大批号（新批次）；
- 来源：读取来源注册表（§7）的 executable 列表，逐个调用对应适配器；阶段二 executable 仅 `google-scholar`（适配器即现有 `google_scholar_search.run`），非 executable 来源永不执行；脚本入口校验 `sources` 必须 ⊆ executable 集合（现文案口径见 §10）；
- 输出：累计 `candidates.json` + `candidates.csv`（契约 §3.3；写前原子替换，同 batch_index 覆盖该批、其余批次保留）；
- 事件：`stage(browser)` → `stage(search)` → 验证码时 `attention(verification)` → `stage(save)` → `result{count,files:[candidates.json,candidates.csv]}`；退出码 0/1/2；
- 幂等：同一 batch_index 重跑 = 该批整体替换；跨批去重不做（交 dedupe）。

#### 2.4.2 `tools/literature_dedupe.py`（dedupe，I2 新建）

```
python -u tools/literature_dedupe.py --config C --output-dir D [--threshold 0.55] [--resume]
```

- 输入：累计 `candidates.json`（缺文件 → `error`「尚未完成候选检索」exit 1）；
- 输出：`dedupe/dedupe.json` + `dedupe/dedupe.csv`（契约 §3.4）；
- 算法：N 方合并。信号优先级 = DOI 精确（1.0）→ 归一化标题包含匹配（0.95）→ Jaccard ≥ threshold（默认 0.55）；标题归一化/分词（CJK bigram + 英文去停用词）复用 SOC `scripts/papers_index.py` 的 `normalize/tokens/jaccard`（`sys.path` 引入，A 档原样复用，D1a 卡片 3）；
- 事件：`stage(dedupe)` → `result{count=唯一组数, counts:{records_in, groups, merged}, files:[…]}`；无条件全量重算（幂等），`--resume` 仅为 CLI 对称性保留，行为同普通运行；
- 语义：明确重复自动合并（保留全部原始记录）；疑似重复（probable）保留合并关系并标注 `needs_review`，不静默丢弃（alignment L14/L45）。

#### 2.4.3 `tools/literature_fulltext.py`（fulltext，I3 新建）

```
python -u tools/literature_fulltext.py --config C --output-dir D
        [--resume] [--limit N] [--only id1,id2] [--retry-unavailable]
```

- 输入：优先 `dedupe/dedupe.json` 的 canonical 组，缺失时退回累计 `candidates.json`（按 canonical_id 去重）；
- 目标选择优先级（实现细节可调，契约层冻结语义）：① `fulltext_links` 中直链 PDF → ② `result_url` 为 .pdf → ③ `result_url` 页面导航（HTML 正文优先）；全部失败 → `unavailable`；
- 复用：`SOC-database-pipeline-clean/.codex/skills/soc-paper-fetch/scripts/` 的 `browser/common/download_pdf` 经 `sys.path.insert` import（同 `literature_search.py` L100–102 模式）；全程使用 CDP 持久浏览器（含登录态 cookie）；
- 输出：`fulltext/status.json` + `fulltext/files/<paper_id>.pdf|.txt`（契约 §3.5）；
- 人在环：验证码 → `attention(verification)`，exit 0；人工完成后 `--resume` 继续未完成项；
- `--resume`：跳过 `status=fetched_*`；默认重试 `unavailable/needs_attention`，加 `--retry-unavailable` 才重试全部不可用项；
- 不绕过访问控制：付费墙 → `unavailable`（reason 注明），不模拟登录、不抓替代镜像（alignment L17/L27）；
- 事件：`stage(fulltext)` 分段（如逐篇进度以 message 呈现，不刷屏）→ `result{count=已获取, counts:{fetched, unavailable, skipped}, files:[fulltext/status.json]}`。

#### 2.4.4 `tools/literature_extract.py`（extract 的 Python 半，I4 新建）

```
python -u tools/literature_extract.py --config C --output-dir D --prepare|--check [--force]
```

- `--prepare`：读有效 schema（§3.2）+ `fulltext/status.json`，生成逐篇 bundle `extraction/inputs/<paper_id>.json`（契约 §3.6）；已存在且 schema 哈希一致则跳过（`--force` 强制重建）；`result{count=bundles, files:[…]}`；
- `--check`：校验 `extraction/<paper_id>.json` 是否齐备且通过骨架校验（7 键、`paper_id`==文件名 stem、行字段合法、溯源格式合法）；全部通过 `result{count=ok}`；存在缺失/非法 → `error`（message 含逐篇原因摘要）+ exit 1；
- 关口：无有效 schema 确认记录 → `error`「提取前需先在研究者确认参数字段含义与单位」(exit 1)；bundle 的 `schema_sha256` 与当前确认不一致 → 提示需 `--force` 重建并重跑；
- LLM 填充不在本脚本（§1.4），由 `tools/literature-extract.js` 完成。

#### 2.4.5 `tools/literature_validate.py`（validate，I4 新建）

```
python -u tools/literature_validate.py --config C --output-dir D [--resume]
```

- 输入：dedupe + extraction + fulltext + 有效 schema；输出：`validation/validation.json` + `validation/validation.md`；
- 规则见 §6.1/§6.2；**存在阻断/待审核行不判失败**（exit 0，counts 里报数）——阻断行在 export 阶段被隔离，不中断流水线；exit 1 仅限内部错误；
- 事件：`stage(validation)` → `result{count=参数行总数, counts:{blocking, pending, ok}, files:[validation/validation.json, validation/validation.md]}`。

#### 2.4.6 `tools/literature_export.py`（export，I4 新建）

```
python -u tools/literature_export.py --config C --output-dir D [--resume]
```

- 输入：全链产物 + `validation/validation.json` + 可选用户模板；输出：`export/` 下文献表与参数明细表 CSV+Excel、`export_report.md`、历史归档（§4.1/§6.3）；
- 事件：`stage(export)` → `result{count=参数行数, files:[export/literature.csv, export/literature.xlsx, export/parameters.csv, export/parameters.xlsx, export/export_report.md]}`。

### 2.5 stage 词汇表（冻结）

沿用（D1b note1）：`queued, environment, browser, search, save, verification, failed, completed, cancelled, interrupted`。

新增：`dedupe, fulltext, extraction, validation, export, awaiting_confirmation`。

**status 保持 5 值不变**：`running / needs_attention / completed / failed / cancelled`（D1b note2 建议 c 采纳）——字段确认关口用 `status=needs_attention + stage=awaiting_confirmation` 表达，不膨胀 status。

---

## 3. 中间 JSON 契约（验收②）

### 3.1 run_config.json（v1 → v2 扩展）

现有 12 字段与校验文案全部保留（§10）。**新增字段全部可选，缺省时行为与 v1 逐字一致**：

```json
{
  "version": 2,
  "topic": "…", "query": "…", "sources": ["google-scholar"],
  "publicationYearFrom": 2000, "publicationYearTo": 2026,
  "geography": "…", "language": "…", "studyTypes": ["…"],
  "inclusion": ["…"], "exclusion": ["…"], "targetFields": ["…"], "limit": 10,

  "batch": { "size": 10, "maxBatches": 1 },
  "fieldDefinitions": [
    { "key": "soc", "label": "SOC", "meaning": "土壤有机碳含量", "unit": "g/kg",
      "valueType": "number", "required": true,
      "allowedRange": { "min": 0, "max": 600 }, "conditionKeys": ["site", "treatment", "year"] }
  ],
  "templates": { "literature": null, "parameters": null },
  "fulltext": { "maxPapers": 0, "perPaperTimeoutSec": 120 },
  "extraction": { "maxCharsPerPaper": 120000, "model": null },
  "limits": { "discover": 180, "dedupe": 120, "fulltext": 3600, "extract": 1800, "validate": 300, "export": 600 }
}
```

| 字段 | 语义 | 缺省与兼容 |
|---|---|---|
| `version` | 2 = 含扩展字段；1/缺失 = 第一阶段配置 | 读方容忍 1；写方新任务写 2 |
| `batch.size` | 每批候选条数，仍受 1–10 约束（≤10 三层一致不回归） | 缺省 = `limit` |
| `batch.maxBatches` | 本任务允许的批数上限，1–50 | 缺省 1（= 只跑首批，现行为） |
| `fieldDefinitions[]` | 参数字段**提案**（AI/用户整理）；`key/label/meaning/unit/valueType/required` 必填；`allowedRange`/`allowedValues`/`conditionKeys` 可选。**未确认不生效**——生效 schema 以 confirmations.json 为准（§3.2） | 缺省 []；`targetFields` 原样保留供旧 UI |
| `templates.*` | 用户 Excel 模板相对项目根路径 | null = 用内建默认表头 |
| `fulltext.maxPapers` | 单任务获取上限，0 = 不限 | 0 |
| `fulltext.perPaperTimeoutSec` | 单篇获取超时 | 120 |
| `extraction.maxCharsPerPaper` | 送入 LLM 的单篇文本上限（超出截断并标注） | 120000（待验证，见 §12） |
| `extraction.model` | 指定提取模型；null = 复用 prepare 的模型选择逻辑（gpt-6-luna 优先回退账号默认） | null |
| `limits.*` | 各阶段超时（秒）；discover 必须默认 180（维持『检索超过 3 分钟』文案） | 见表 |

**写入时机不变**：连接器 `start()` 以 `wx` + `0o444` 冻结写入（现有行为，D1b note3a 条目 7）；v2 字段在冻结前由 `normalizeConfig` 归一。

### 3.2 confirmations.json（新增，研究者确认记录）

run_config 冻结不可回写，**确认记录独立落盘**：

```
<job>/confirmations.json
{
  "records": [
    { "at": "2026-10-15T…Z", "by": "researcher", "kind": "fieldDefinitions",
      "fields": [ …与 run_config.fieldDefinitions 同构… ], "note": "" }
  ]
}
```

- 写入：W1a 在 `POST /advance` 带 `confirmations` 时追加（原子重写，append-only 语义）；
- 读取：I4 的 extract/validate/export 以**最新一条 `kind="fieldDefinitions"`** 为有效 schema；
- 若列表为空且未确认 → extract 阶段须暂停在 `awaiting_confirmation` 关口（alignment L9/L16 硬关口）；
- schema 哈希：`sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False))`，写入 bundle 与结果校验（§2.4.4）。

### 3.3 candidates.json / candidates.csv（累计视图 + 批次）

第一阶段的单批结构保留为兼容底座，扩展为累计视图（**第一批任务的输出与现结构逐字兼容**）：

```json
{
  "version": 2,
  "source": "Google Scholar", "query": "…", "run_config": {…原有语义…},
  "search_url": "…", "retrieved_at": "…", "count": 23,
  "scope": "first_page_candidates_only",
  "applied_filters": ["query"], "deferred_rules": ["geography", "…"],
  "caution": "Search snippets are not verified abstracts or full text; all records await screening.",
  "batches": [
    { "batch_index": 1, "query": "…", "search_url": "…", "retrieved_at": "…",
      "count": 10, "applied_filters": ["query"], "deferred_rules": ["…"], "status": "complete" }
  ],
  "records": [ …累计全部记录… ]
}
```

- 兼容规则：`source/query/run_config/search_url/retrieved_at/applied_filters/deferred_rules/caution/results` 各键语义不变；多批时这些键取**最新批次**的值（JSON 报告的现有消费者继续可用），批次明细进 `batches[]`；`count` 改为累计记录数；
- `version` 缺省视为 1（旧文件可读）；
- 记录新增字段（全部可空）：`doi`(string, 归一化小写, 无则 "")、`year`(int|null)、`authors`(string)、`venue`(string)、`source_key`("google-scholar")、`batch_index`(int)；**仅在结果页真实可得时填充，不猜 DOI、不由片段编造**（待验证项见 §12）；
- `candidate_id` 唯一性：第 1 批保持 `GSC-###`（不回归）；第 n≥2 批为 `GSC-B<n>-###`（待确认项见 §12）；任务内全局唯一即满足溯源链要求；
- CSV 列序与现有 `fields` 数组向后追加新列（现有 11 列原序在前），保留 `utf-8-sig` 与 `safe_csv_cell` 防公式注入。

### 3.4 dedupe/dedupe.json / dedupe.csv（I2 输出）

```json
{
  "version": 1,
  "generated_at": "…Z",
  "threshold": 0.55,
  "counts": { "records_in": 23, "groups": 19, "merged": 4, "needs_review_groups": 1 },
  "groups": [
    {
      "canonical_id": "GSC-001",
      "title": "…", "year": 2019, "doi": "10.xxxx/…",
      "sources": ["google-scholar"],
      "candidate_ids": ["GSC-001", "GSC-B2-003"],
      "merge_confidence": "exact",        // exact | probable
      "merge_reason": "doi_exact",        // doi_exact | title_substring | title_jaccard
      "max_score": 1.0,
      "needs_review": false,
      "records": [ …成员原始记录逐字保留… ]
    }
  ]
}
```

- `merge_confidence=exact`（DOI 精确/归一化标题相等或包含）：成员置 `screening_status="auto_excluded_duplicate"`、`screening_reason` 指向 canonical；canonical 保持 `pending_review`；
- `merge_confidence=probable`（Jaccard 达阈值但非精确）：`needs_review=true`，成员保留 `pending_review`，进入待审清单（**不静默合并**，alignment L45）；
- `dedupe.csv` 一行一组：`canonical_id,title,year,doi,sources,merged_count,merge_confidence,merge_reason,max_score,needs_review`；
- 确定性：记录处理顺序 = 批次升序 + 批内原序；同输入必得同输出（可复现）。

### 3.5 fulltext/status.json（I3 输出）

```json
{
  "version": 1,
  "generated_at": "…Z",
  "policy": "HTML 正文优先、PDF 备选；无法合法获取标为待补充，不绕过访问控制。",
  "items": [
    { "paper_id": "GSC-001", "title": "…", "doi": "…",
      "source_url": "…", "fulltext_url": "…",
      "kind": "pdf",                                    // pdf | html | abstract | none
      "status": "fetched_pdf",                          // 见下
      "path": "fulltext/files/GSC-001.pdf",             // 相对 job 目录；无则 ""
      "size": 812345, "retrieved_at": "…Z",
      "evidence_level": "fulltext_pdf",
      "reason": "" }
  ],
  "counts": { "total": 19, "fetched_pdf": 7, "fetched_html": 3, "abstract_only": 2, "unavailable": 6, "needs_attention": 1 }
}
```

- `status` 取值域：`fetched_pdf | fetched_html | abstract_only | unavailable | needs_attention | pending`；
- `evidence_level` 取值域（全链共享）：`search_result_snippet | abstract_only | fulltext_html | fulltext_pdf`；
- `unavailable` 必须带 reason（付费墙/无合法入口/页面无正文等）；**不重试绕过**；`needs_attention` = 验证码未完成（attention 事件后遗留项）；
- HTML 正文以 `.txt` 保存（正文文本）+ `kind:"html"`；PDF 以 `.pdf` 原样保存（`%PDF` 魔数 + ≥50KB 校验沿用 SOC `download_pdf`）。

### 3.6 extraction 输入 bundle 与输出结果（I4 契约）

**输入** `extraction/inputs/<paper_id>.json`：

```json
{
  "schema_version": 1,
  "instructions_version": "extract-contract-v1",
  "schema_sha256": "…",
  "paper_id": "GSC-001",
  "title": "…", "doi": "…", "source_url": "…",
  "fulltext": { "kind": "pdf", "path": "fulltext/files/GSC-001.pdf",
                "text": "…正文/PDF 抽取文本…", "chars": 48210, "truncated": false },
  "field_definitions": [ …有效 schema… ],
  "condition_keys": ["site", "treatment", "year"]
}
```

**输出** `extraction/<paper_id>.json`（SOC 提取契约骨架的通用化，7 顶层键；D1a 提取卡片）：

```json
{
  "paper_id": "GSC-001",
  "source_pdf": "fulltext/files/GSC-001.pdf",
  "status": "ok",
  "classification_reason": "…为何纳入抽取/跳过…",
  "rows": [
    { "row_id": "GSC-001-R001",
      "field": "soc",
      "value_raw": "12.4", "unit_raw": "g/kg",
      "value_normalized": 12.4, "unit_normalized": "g/kg",
      "conversion": null,
      "evidence": { "where": "p.7 Table 3", "quote": "≤300字原文摘录", "kind": "table" },
      "conditions": { "site": "…", "treatment": "…", "year": "2018" },
      "provenance": "" }
  ],
  "warnings": [],
  "skip_reason": ""
}
```

- 契约要点：`paper_id` 必须等于文件名 stem（对应 SOC 的 `No.`==文件名回溯链）；`status`∈`{ok, partial, skipped}`（SOC 语义保留：skipped 必须带 `skip_reason`）；
- `rows` 行结构 = 「一个有出处的报告值一行」（alignment L15）；`field` 必须 ∈ 有效 schema 的 `key`；`evidence.where/quote` 至少一项非空（可追溯性）；
- `source_pdf` 兼容键名保留：HTML 稿写 `<paper_id>.txt`、仅链接写 `<paper_id>.url`（同 SOC 约定）；
- **禁推断**（提取指令须内含，D1a 提取卡片 7 条）：坐标/气候/质地/施肥量/C-N-pH 等不得推断；SOM→SOC、POC/MAOC 当 SOC 等错映射禁止；看图为唯一依据的数值不得直接当已提取值；
- **溯源标记格式冻结**（与 SOC 兼容）：图表读数行 `provenance = "figure-extracted from {Fig ID} {chart type}"`；计算行 `provenance = "calculated: {formula}"`；纯文本/表格行 provenance 留空（定位在 `evidence.where`）；
- 阶段二提取输入为**文本**（PDF 经 pypdf 抽取）；图表像素读数不在网页线内（§5.4），人工转录行可按上述 provenance 格式补录。

### 3.7 validation/validation.json（I4 输出）

```json
{
  "version": 1,
  "generated_at": "…Z",
  "schema_source": "confirmations.json#fieldDefinitions@2026-10-15T…Z",
  "counts": { "parameters_total": 41, "ok": 36, "blocking": 2, "pending": 3 },
  "blocking": [ { "entity": "parameter", "row_id": "GSC-002-R003", "paper_id": "GSC-002",
                  "rules": ["missing_value"], "message": "…" } ],
  "pending":  [ { "entity": "literature", "paper_id": "GSC-004",
                  "rules": ["missing_doi"], "message": "…" } ]
}
```

配套 `validation/validation.md` = 人类可读待审清单（记录标识、问题、已有证据、建议动作，对齐 workflow 第 7 步）。

### 3.8 文献表 / 参数明细表（I4 输出）

**文献表** `export/literature.csv`（及 `literature.xlsx`，sheet 名「文献表」）：

```
paper_id, title, authors, year, doi, source, source_url, fulltext_url,
fulltext_status, evidence_level, retrieved_at, screening_status,
screening_reason, review_status, notes
```

- `screening_status` 取值域：`pending_review | auto_excluded_duplicate | needs_fulltext_check | included | excluded`（`included/excluded` 仅由人工审查写入；阶段二自动化只产生前三者——**不自动判「不相关」**，alignment L13 只允许「明确重复」自动排除）；
- `review_status`∈`{unreviewed, approved, rejected}`，默认 `unreviewed`；人工审查痕迹以追加备注记录（`notes`）；
- 被排除文献**仍保留筛选记录**（行不删除）；`auto_excluded_duplicate` 行的 `screening_reason` 指向 canonical_id。

**参数明细表** `export/parameters.csv`（及 `parameters.xlsx`，sheet 名「参数明细」）：

```
row_id, paper_id, field, value_raw, unit_raw, value_normalized, unit_normalized,
conversion, evidence_where, evidence_quote, provenance, conditions_json,
validation_status, validation_notes
```

- `validation_status`∈`{ok, blocked, pending_review}`；`blocked` 行**不写入主表**（进错误报告），`pending_review` 行写入主表并列入待审清单；
- `conditions_json` = 条件对象的紧凑 JSON 字符串（CSV 与 Excel 同形，避免不可控的多列展开）。

**形式冻结**：CSV 均 `utf-8-sig` + 全字段 `safe_csv_cell`；Excel 用 openpyxl，表头 = 列名、单元格 = 值；一对表对应一对文件（2 CSV + 2 XLSX），不合并为单工作簿。

---

## 4. 任务目录与日志规范（验收③）

### 4.1 目录树（`.workbench/literature/<jobid>/`）

```
.workbench/literature/<jobid>/
├── job.json                     # 任务快照（公开字段；原子重写；现有）
├── run_config.json              # 冻结运行配置（wx + 0o444，永不复写；现有）
├── confirmations.json           # 研究者确认记录（append-only；新增）
├── events.jsonl                 # 追加式全量事件日志（新增）
├── candidates.json / candidates.csv        # 累计候选（§3.3）
├── dedupe/
│   ├── dedupe.json / dedupe.csv            # §3.4
├── fulltext/
│   ├── status.json                          # §3.5
│   └── files/<paper_id>.pdf | .txt          # 全文本体
├── extraction/
│   ├── inputs/<paper_id>.json               # 提取输入包
│   ├── <paper_id>.json                      # 逐篇提取结果
│   └── check_report.json                    # --check 结果
├── validation/
│   ├── validation.json / validation.md      # §3.7
└── export/
    ├── literature.csv / literature.xlsx
    ├── parameters.csv / parameters.xlsx
    ├── export_report.md                     # 计数、填充率、阻断摘要
    └── history/<yyyyMMdd-HHmmss>/…          # 同 job 重导出时的旧版本归档
```

目录名与文件名冻结；`.gitignore` 已含 `.workbench/`（无需改动）。

### 4.2 events.jsonl 格式与写入职责

- 一行一事件：`{"at":"ISO-8601","type":"stage|attention|error|result","stage":"…","message":"…","extra":{…可选…}}`；
- 追加写、utf-8、逐行 flush；**唯一写入者 = 任务驱动方**（网页 = W1a 连接器；命令行 = I1 pipeline.py，默认写、`--no-event-log` 关闭）；阶段脚本不写该文件（避免双写交错）；
- `job.json` 的 `events[]`（UI 用，截尾 30 条）继续由连接器维护，属展示缓存；**events.jsonl 才是全量审计流水**；
- 恢复后可继续追加，不做轮转（本地工具、量级小；如需清理由用户自行掌握）。

### 4.3 job.json 扩展与 snapshot 语义

新增字段（可缺省、向后兼容）：

```json
{
  "…现有字段 id/status/stage/message/count/config/files/events/error…",
  "stages": { "discover": "done", "dedupe": "done", "fulltext": "running",
              "extract": "pending", "validate": "pending", "export": "pending" },
  "resumeStage": "fulltext",
  "until": "export",
  "counters": { "candidates": 23, "uniqueGroups": 19, "fulltextFetched": 10,
                "extractedPapers": 8, "parameterRows": 41 }
}
```

- `stages` 取值：`pending | running | done | failed | skipped`；由连接器在事件流驱动下维护（source of truth 为产物存在性判定，见 §4.4）；
- `resumeStage` = 下一待执行阶段（`completed/needs_attention/failed/interrupted` 状态时非空；running 或全流程结束时为 null）；
- `count` 保持现有语义（展示主计数），阶段明细进 `counters`；
- `snapshot()` 对磁盘 job.json 的读取规则：live job → 现逻辑；completed → 现逻辑；persisted running → **保持**现状改写（status=`failed`、stage=`interrupted`、message『本地服务已重启，检索中断；已保存的文件仍可下载。』），**新增**：按产物判定重建 `stages`（running→pending）并置 `resumeStage`，使 interrupted 分支可经 `advance` 续跑（D1b R6 的补测试要求由 W1a 覆盖）。

### 4.4 断点续跑与恢复语义

- **阶段完成判定 = 产物存在性（artifact-based，双驱动共享）**：

| 阶段 | 完成判据（全部为真） |
|---|---|
| discover | `candidates.json` 存在且 `batches[]` 非空 |
| dedupe | `dedupe/dedupe.json` 存在且 version 合法 |
| fulltext | `fulltext/status.json` 存在且 items 全部非 `pending` |
| extract | `--check` 通过（bundle 齐备 + 结果合法） |
| validate | `validation/validation.json` 存在 |
| export | `export/literature.xlsx` 与 `export/parameters.xlsx` 存在 |

- **各阶段 resume 行为**（幂等三原则：重跑安全、同批替换、产物原子）：
  - discover：同 batch_index 整批替换；interrupted 重跑可能产生的跨批复重由 dedupe 兜底（设计取舍，见 §12）；
  - dedupe：全量重算；fulltext：跳过已获取；extract：schema 未变跳过已有 bundle/结果，变了要求 `--force`；validate/export：全量重算；
- **interrupted 分支**：服务重启 → snapshot 改写为 `failed + stage=interrupted`（文案不变）→ UI 提供「继续」→ `POST /advance` 从 `resumeStage` 续跑；discover 中断的重试沿用 `--scrape-current` 机制（captcha 场景）；
- **captcha 恢复**：`attention(verification)` → `needs_attention`；两种恢复路径均保留：①既有 `POST /search {resumeCurrent:true}`（行为逐字不变）②新 `POST /advance`（stage=verification 时自动等价 `--scrape-current`）；
- **关口恢复**：`awaiting_confirmation` → `POST /advance {confirmations}` 追加确认记录后从 `extract` 续跑；
- **中途失败**：`error` → `failed`（文案沿用或新阶段新文案）；`advance` 允许对 `failed` 任务按 `resumeStage` 重试当前阶段；
- **取消**：`cancel` 只杀当前子进程；discover 文案『检索已停止；持久浏览器保持打开』不变；其他阶段『任务已停止；已完成的阶段产物保留』；`cancelled` 为终态，不接受 advance。

---

## 5. 通用 vs SOC 边界与复用映射（验收④）

### 5.1 总原则（写入 README/alignment 的口径）

> **SOC 仅作可选示例**：`SOC-database-pipeline-clean/` 是本项目借用的实现库与运行示例。通用线只复用其**通用机制**（浏览器会话、下载、查重算法、模板→schema、事务性落盘）；SOC 的主题规则（中国框、0-30/30-60/60-100 土层、SOC 数值准入、两张固定工作表、58/52 字段清单）**只在用户选择 SOC 示例配置时生效**，绝不设为通用默认。（alignment L9/L24、workflow §SOC 示例映射、D1a 复用分档）

### 5.2 A 档：直接复用（import 调用，零/近零改）

| SOC 资产 | 落地方式 | 归属 |
|---|---|---|
| `soc-paper-fetch/scripts/browser.py` | `sys.path` import；discover/fulltext 共用持久 Chromium（CDP 9222） | I1/I3 |
| `…/common.py` | import（`connect_browser/get_or_create_page/apply_stealth/looks_like_captcha/print_json`） | I3 |
| `…/download_pdf.py` | import `run(url, out_id, click_selector, use_current_page, out_path_override)`，用 `out_path_override` 落到 `fulltext/files/` | I3 |
| `…/google_scholar_search.py` | import `run(query, scrape_current, limit, year_from, year_to)`（含 as_ylo/as_yhi 与 `pick_search_page`） | I1 |
| `…/cleanup_tabs.py` | 可选提示（文档提及，不自动执行） | — |
| `scripts/papers_index.py` | import 纯函数 `normalize/tokens/jaccard`（查重底座；本文件已核实无模块级副作用） | I2 |
| `scripts/active_learning_pilot.py` | **不接入网页线**；保留离线直用（轮次治理/双会话审核门），README 指针（D1a 结论：project-neutral 可原样用） | 不做（离线工具） |
| `docs/active-learning-pilot.md` | 方法论参考 | — |

### 5.3 B 档：新写泛化层（在 `tools/` 泛化重写，不直接调用）

| SOC 资产 | 泛化落地 | 归属 |
|---|---|---|
| `soc-database-extract/SKILL.md` 契约骨架 | `EXTRACT_INSTRUCTIONS`（`tools/literature-extract.js`）+ 输出契约 §3.6；58/52 字段与 SOC 准入 → `fieldDefinitions` 由研究者确认 | I4 |
| `scripts/validate_output_v2.py`（SOC 谓词硬规则） | `literature_validate.py` 规则引擎：谓词来自有效 schema（§6.1/6.2），不 import（硬编码 sheet/schema 路径） | I4 |
| `scripts/merge.py`（模板复制+清空+写入+填充率报告） | `literature_export.py` 的模板机制与报告（思路移植） | I4 |
| `scripts/export_schema.py`（双行表头→schema） | 用户模板映射机制（可选路径）：模板核对→字段映射→写入；单行表头通用模板为默认 | I4 |
| `scripts/collection_endpoint.py`（达标 gate） | **本阶段不接入**（目标数量语义未对齐，见 §12）；预留 gate 适配接口 | 预留 |
| `configs/active_learning_pilot.example.json` | 不接入（随 active_learning 离线） | — |
| `fulltext` 选择器库/体积阈值外置 | `download_pdf` 默认选择器 + `--click-selector` 重试路径保留；阈值不动 | I3 |

### 5.4 C 档：明确不做（本阶段）

| 资产 | 不做的理由 |
|---|---|
| 4 个制图脚本（`scripts/generate_soc_sites_map.py`、`plot_*.py`） | 硬编码 `C:\Users\31307\…` 绝对路径，SOC 专属制图 |
| `spec/*.xlsx`、`schemas/*.json`、`tools/summarize_point_trials.py`、`summarize_long_term_trials.py` | SOC 模板资产与土层带/省份语义，不进通用线 |
| `build_papers_index.py` | 一次性 PyMuPDF 标题聚类，不适合网页线 |
| `cnki_search.py` | 登记未接通（§7），后续批次再评估 |
| `figure2data`（opencv+PDF 依赖） | 依赖重且交互半自动，网页线不接入（待裁决项 §12）；溯源格式已冻结以便后续人工/离线补录 |
| `collection_endpoint.json` 实际阈值 | SOC 专属值 |
| 用户上传文献/清单/PDF（alignment L17） | 本阶段不做；**仅预留数据位**：候选记录 `source_key` 允许 `user-upload`，dedupe 一视同仁（§12 待确认） |

---

## 6. 校验与导出规则（验收⑤）

### 6.1 阻断规则（blocking，逐条对齐 `literature-mining-alignment.md` L21）

| 编号 | 规则 | 作用对象 |
|---|---|---|
| B1 | 缺少论文 ID 或无法关联文献（参数行 `paper_id` 空/不存在） | 参数行 |
| B2 | 参数行缺可追溯来源（`evidence.where` 与 `evidence.quote` 均空） | 参数行 |
| B3 | 参数行缺字段名（`field` 空） | 参数行 |
| B4 | 参数行缺原值（`value_raw` 空） | 参数行 |
| B5 | 声明为数值的字段不是有效数字（`valueType=number` 且 `value_normalized` 非法） | 参数行 |
| B6 | 字段不符合本次确认的结构（`field` ∉ 有效 schema） | 参数行 |
| B7 | 文献行缺 `paper_id`，或重复 `paper_id` | 文献行 |

阻断处置：行**不写入主表**，逐条进 `validation.json` 的 `blocking[]` 与 `export_report.md` 错误报告（alignment L23「校验失败的行另列错误报告」）。

### 6.2 待审核规则（pending，逐条对齐 L22）

| 编号 | 规则 | 备注 |
|---|---|---|
| P1 | 缺 DOI | |
| P2 | 单位不明（`valueType=number` 且 `unit_raw` 空） | |
| P3 | 疑似重复（dedupe `needs_review=true` 的组） | |
| P4 | 异常值 | **仅当有效 schema 显式给出 `allowedRange/allowedValues` 时检测**；SOC 数值范围等科学阈值不作通用默认（L22 原文） |

待审核处置：行**写入主表**（`validation_status=pending_review`）并列入 `validation.md` 待审清单；**不擅自补值、换算或删除**（L22）。

### 6.3 导出语义

- 双输出：文献表、参数明细表各出 CSV + Excel（§3.8 形式）；
- 一致性：两表依据**同一份有效 schema**生成（L23）；
- 错误报告：`export_report.md` 含阻断明细 + 计数摘要；`validation.md` 含待审清单；
- **版本不覆盖策略**：
  1. 任务级隔离——每个 job 独立 `<uuid>` 目录，任何阶段不写 job 目录之外；
  2. 同 job 重导出——写前把既有 `export/` 内容整体归档到 `export/history/<yyyyMMdd-HHmmss>/` 再写新版本；
  3. `run_config.json` 冻结（wx+0o444）不复写；`confirmations.json` append-only；
  4. 候选批次：同批号重试替换，新数据必须新批号（`batches[]` 历史保留）；
  5. 被排除文献保留筛选记录（不删行）。

### 6.4 用户模板映射（可选，alignment L24）

- `templates.literature` / `templates.parameters` 指定相对项目根的用户模板 xlsx；
- 提供模板时：先核对表头与字段映射（双行表头走 `export_schema` 机制；单行表头按列名匹配），映射结果写入 `export_report.md` 供研究者确认后才写数据；
- 未提供模板：内建默认表头（§3.8）；**SOC 两张固定工作表与其专属字段不套用到其他主题**。

---

## 7. 来源注册表语义（验收⑥）

单一真相 = 新文件 `tools/literature-sources.json`（JS 与 Python 共用读取）：

```json
{
  "version": 1,
  "sources": [
    { "key": "google-scholar", "label": "Google Scholar", "state": "executable",
      "adapter": { "kind": "soc-script", "script": "SOC-database-pipeline-clean/.codex/skills/soc-paper-fetch/scripts/google_scholar_search.py" },
      "notes": "首批连接器（2026-10-15）" },
    { "key": "cnki", "label": "知网", "state": "registered", "adapter": null,
      "notes": "SOC cnki_search.py 存在但未接入网页线" },
    { "key": "wanfang", "label": "万方", "state": "registered", "adapter": null, "notes": "" },
    { "key": "web-of-science", "label": "Web of Science", "state": "registered", "adapter": null, "notes": "" },
    { "key": "scopus", "label": "Scopus", "state": "registered", "adapter": null, "notes": "" },
    { "key": "pubmed", "label": "PubMed", "state": "registered", "adapter": null, "notes": "" }
  ]
}
```

语义冻结：

- 六个 key 与现有 `KNOWN_SOURCES` 完全一致（不回归）；`state ∈ {executable, registered}`；
- executable 才允许进入执行链；`registered` **保持明确拒绝**，拒绝文案逐字不变：`尚未接通以下检索来源：<逗号连线>；请明确改为仅检索 Google Scholar，或等待相应连接器。`（`literature-config.js` L32–35 原文）；
- 双层防线：JS 侧 `normalizeConfig({executable:true})` 与 Python 侧脚本入口校验均读注册表；失败不降级、不静默只跑 Scholar（测试断言『unsupported source must not silently run Scholar only』保持）；
- **预留接入接口**：新来源接入 = ①注册表条目 `state→executable` 并填 `adapter`（`{kind:"soc-script"|"new-script", script:相对路径}`）②提供与 discover 相同的 NDJSON 阶段实现 ③把该来源 key 加入 `records[].source_key` 映射；三个阶段脚本无须改动；
- 界面提示「当前仅 Google Scholar 已接通」保持；复选框六源列表保持。

---

## 8. 环境与依赖（验收⑦）

### 8.1 requirements-literature.txt v2 与依赖变更感知

追加两项依赖（纯 pip、无系统依赖；待裁决 §12）：

```
playwright>=1.40,<2
openpyxl>=3.1,<4
pypdf>=4,<7
```

> pin 说明（2026-10-15 依实现期裁决对齐）：`pypdf` 上限放宽为 `<7`，与 `requirements-literature.txt` 一致；本机实测 6.20.1 可正常完成 `PdfReader/extract_text` 与降级路径。

- `openpyxl`：export 写 xlsx + 读用户模板；
- `pypdf`：PDF→文本（提取 bundle）；扫描件/解析失败不视为错误，按 `abstract_only/unavailable` 降级处理。

**依赖变更感知**：`.venv/.literature-ready` 标记升级为 JSON：

```json
{ "schema": 2, "requirementsSha256": "<requirements-literature.txt 内容 sha256（LF 归一）>",
  "createdAt": "…Z", "python": "…版本串…" }
```

`preparePython` 复用条件 = venv python 存在 **且** marker 存在 **且** sha256 与当前文件一致；不一致/旧格式 marker → 重跑 `pip install -r` + `playwright install chromium` → 重写 marker（幂等；首次 Chromium 下载耗时的超时建议见 §12）。旧纯文本 marker 视为过期，触发一次重装。

### 8.2 PYTHONUTF8 编码修正（纳入实现要求）

- 修复事实（D1b R1，Windows 实测）：无 `PYTHONUTF8` 时管道 stdout 为 gbk，Node `chunk.toString('utf8')` 出现 U+FFFD 乱码且不触发解析失败（静默）；
- W1a：连接器**所有** Python spawn（`runCommand` 与 `runStage`）显式 `env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }`；
- I1：`literature_search.py` 与全部新脚本在入口加 `sys.stdout.reconfigure(encoding='utf-8')`（`hasattr` 守卫，同 `common.print_json` 先例）；`literature_common.py` 的 `emit()` 统一经此 stdout；
- 回归测试：W1a 在 `test-literature-connector.js` 增补「剥离父进程 UTF8 变量后 spawn 打印中文的 mock 脚本，断言事件 message 无 U+FFFD」。

### 8.3 超时与网络

- 各阶段超时表见 §3.1 `limits`；discover 保持 180s 与现有文案；其余阶段的超时文案新文案：`阶段执行超过 <n> 秒，已停止；已完成的产物保留。`；
- 网络：沿用系统 `HTTP_PROXY/HTTPS_PROXY`（alignment L31）；脚本不安装依赖、不自动更新；
- 浏览器：CDP 9222 固定端口与归属校验缺口（D1b R10）本阶段不修，保持观察项记录（§11）。

---

## 9. 实现任务切分与文件所有权（验收⑧）

### 9.1 所有权总表（文件 × 任务；同一文件仅一个 owner，保证并行零冲突）

| 文件 | I1 总控 | I2 去重 | I3 全文 | I4 提取校验导出 | W1a 接线 | W1b 网页 |
|---|---|---|---|---|---|---|
| `tools/literature-common.py`（新） | ✅ owner | 引用 | 引用 | 引用 | — | — |
| `tools/literature-sources.json`（新） | ✅ owner | — | — | — | 引用 | — |
| `tools/literature-sources.js`（新） | ✅ owner | — | — | — | 引用 | — |
| `tools/literature-config.js`（改） | ✅ owner | — | — | — | — | — |
| `tools/literature_search.py`（改） | ✅ owner | — | — | — | — | — |
| `tools/literature_pipeline.py`（新） | ✅ owner | — | — | — | — | — |
| `tools/literature_dedupe.py`（新） | — | ✅ owner | — | 引用产物 | — | — |
| `tools/literature_fulltext.py`（新） | — | — | ✅ owner | 引用产物 | — | — |
| `tools/literature_extract.py`（新） | — | — | — | ✅ owner | — | — |
| `tools/literature-extract.js`（新） | — | — | — | ✅ owner | 注入调用 | — |
| `tools/literature_validate.py`（新） | — | — | — | ✅ owner | — | — |
| `tools/literature_export.py`（新） | — | — | — | ✅ owner | — | — |
| `tools/literature-connector.js`（改） | — | — | — | — | ✅ owner | — |
| `server.js`（改） | — | — | — | — | ✅ owner | — |
| `requirements-literature.txt`（改） | — | — | — | — | ✅ owner | — |
| `README.md`、`docs/literature-mining-alignment.md`（改） | — | — | — | — | ✅ owner | — |
| `js/codex.js`（改） | — | — | — | — | — | ✅ owner |
| `css/workspace.css`（改） | — | — | — | — | — | ✅ owner |
| `tools/test-literature-sources.js`（新） | ✅ owner | — | — | — | — | — |
| `tools/test_literature_pipeline.py`（新） | ✅ owner | — | — | — | — | — |
| `tools/test_literature_search.py`（改） | ✅ owner | — | — | — | — | — |
| `tools/test_literature_dedupe.py`（新） | — | ✅ owner | — | — | — | — |
| `tools/test_literature_fulltext.py`（新） | — | — | ✅ owner | — | — | — |
| `tools/test_literature_extract.py`、`test_literature_validate.py`、`test_literature_export.py`、`test-literature-extract.js`（新） | — | — | — | ✅ owner | — | — |
| `tools/test-literature-connector.js`、`test-literature-http.js`（改） | — | — | — | — | ✅ owner | — |
| `tools/test_literature_ui.py`（改） | — | — | — | — | — | ✅ owner |

依赖顺序：I1–I4 并行开工（接口由本文冻结）；W1a/W1b 在 I1–I4 产出可运行脚本后接线（W1b 只依赖契约 §21，不依赖具体实现完成度）。

### 9.2 I1：总控 + 来源注册 + 日志

新 `tools/literature-common.py`（公开函数）：

```python
def emit(kind: str, **values) -> None            # stdout NDJSON 一行（utf-8, flush）
def now_iso() -> str
def atomic_write_text(path: Path, text: str) -> None
def atomic_write_json(path: Path, obj, *, indent: int = 2) -> None
def safe_csv_cell(value: object) -> str          # 与 literature_search.py 同实现（防公式注入）
def safe_url(value: object) -> str
def job_paths(job_dir: Path) -> dict             # 目录/文件常量集中定义（§4.1）
def append_event_log(job_dir: Path, event: dict) -> None   # events.jsonl 追加（§4.2）
def detect_completed_stages(job_dir: Path) -> dict          # §4.4 产物判定表
def stage_counts(job_dir: Path) -> dict          # counters 汇总（§4.3）
```

新 `tools/literature_pipeline.py`（CLI 契约见 §1.3/§2.1）：

```python
STAGES = ["discover", "dedupe", "fulltext", "extract", "validate", "export"]
def run_stage(stage: str, job_dir: Path, *, resume: bool, extra: list[str] | None = None) -> int
def main(argv: list[str] | None = None) -> int
# python -u tools/literature_pipeline.py --config C --output-dir D
#        [--from discover] [--until export] [--resume] [--no-event-log]
# extract 阶段 CLI 模式：--prepare 后若存在未完成 bundle → emit attention(stage="extraction",
#   message="提取输入包已生成（N 篇）。请在网页端完成提取，或在 extraction/ 放置结果后重跑 --check。"），exit 0
```

`tools/literature_search.py` 改造点：`sys.stdout.reconfigure`；`--batch-index`；累计合并写（§3.3）；记录新字段（仅真实可得时填充）；入口校验改读注册表（Python 侧 `tools/literature_sources.py` 极薄加载器，随 `literature-common.py` 一并交付）。

JS 侧（I1 同时 owner）：`tools/literature-sources.js` 导出 `{ SOURCES, listSources(), isKnown(key), executableSources(), assertExecutable(sources) }`，`assertExecutable` 抛错文案与现 `literature-config.js` L32–35 逐字一致；`literature-config.js` 仅替换常量来源为注册表调用 + 追加 §3.1 v2 可选字段归一（12 字段行为逐字不变）。

### 9.3 I2：跨来源去重

`tools/literature_dedupe.py`（CLI 见 §2.4.2）：

```python
def load_candidates(job_dir: Path) -> tuple[dict, list[dict]]     # (报告头, 累计记录)
def group_records(records: list[dict], *, threshold: float = 0.55) -> list[dict]
    # 顺序确定性：批次升序+批内原序；信号 DOI 精确 → 归一化包含 → Jaccard
def write_outputs(job_dir: Path, groups: list[dict], meta: dict) -> dict   # 原子写 §3.4；返回 counts
def main(argv: list[str] | None = None) -> int
```

复用：`sys.path.insert(SOC_ROOT/'scripts')` 后 `from papers_index import normalize, tokens, jaccard`（A 档；算法行为以 SOC 实测为准：DOI=1.0 / 包含=0.95 / Jaccard≥threshold，CJK bigram，D1a 卡片 3 实测）。

### 9.4 I3：全文获取

`tools/literature_fulltext.py`（CLI 见 §2.4.3）：

```python
def classify_target(record: dict) -> dict        # {"kind":"pdf"|"html"|"abstract"|"none","url":str,"reason":str}
def load_targets(job_dir: Path, config: dict) -> list[dict]
def fetch_one(record: dict, out_dir: Path, opts: dict) -> dict     # 返回 §3.5 item；验证码抛 CaptchaPause
def run(config: dict, job_dir: Path, *, resume: bool, limit: int | None,
        only: list[str] | None, retry_unavailable: bool) -> int
def main(argv: list[str] | None = None) -> int
```

复用（`sys.path.insert(SOC_FETCH)`，与 `literature_search.py` L100–102 同模式）：`browser.launch`、`common.connect_browser/get_or_create_page/apply_stealth/looks_like_captcha`、`download_pdf.run(..., out_path_override=<job>/fulltext/files/<id>.pdf)`。每篇一次 `download_pdf.run` 调用（含一次 CDP 连接）为首版实现；开销实测见 §12。

### 9.5 I4：提取校验 + 导出

见 §2.4.4–2.4.6 与 §3.6/§3.7/§3.8。关键签名：

```python
# tools/literature_extract.py
def build_bundles(config: dict, job_dir: Path, *, force: bool = False) -> dict
def check_results(job_dir: Path, config: dict) -> dict      # 写 extraction/check_report.json
def main(argv: list[str] | None = None) -> int
```

```javascript
// tools/literature-extract.js
const EXTRACT_INSTRUCTIONS = '…让模型只输出一个 JSON…含禁推断清单与溯源格式…';
function buildExtractPrompt(bundle) -> string
function parseExtractionJson(text) -> object | null          // 容忍 json 代码围栏；校验 7 键骨架
async function runExtractStage({ bridge, jobDir, config, python, onEvent }) -> { ok, extracted, skipped }
// 流程：python --prepare → 每篇 bridge.run(专用 sessionId, [{role:'user',content:prompt}], EXTRACT_INSTRUCTIONS,
//        false, config.extraction.model, 'literature-mining', null) → 轮询 bridge.snapshot → 原子写
//        extraction/<paper_id>.json → python --check → 聚合 result 事件
```

```python
# tools/literature_validate.py
BLOCKING_RULES: list[str]; PENDING_RULES: list[str]          # §6.1/§6.2 编号与规则名一一对应
def validate_literature(job_dir: Path) -> list[dict]
def validate_parameters(job_dir: Path, schema: list[dict]) -> list[dict]
def run(config: dict, job_dir: Path) -> dict                 # 写 §3.7；exit 0（含阻断行）| 1（内部错误）
def main(argv: list[str] | None = None) -> int
```

```python
# tools/literature_export.py
def load_inputs(job_dir: Path) -> dict                       # dedupe/fulltext/extraction/validation/有效 schema
def literature_rows(inputs: dict) -> list[dict]              # §3.8 列结构
def parameter_rows(inputs: dict) -> list[dict]               # blocked 行剔除，进错误报告
def write_csv(path: Path, rows: list[dict], columns: list[str]) -> None
def write_xlsx(path: Path, rows: list[dict], columns: list[str], sheet: str, template: Path | None) -> None
def archive_previous(export_dir: Path) -> str | None         # §6.3 版本归档
def run(config: dict, job_dir: Path) -> dict
def main(argv: list[str] | None = None) -> int
```

### 9.6 W1a 接线点（server.js / connector / docs）

`tools/literature-connector.js`：

- `runStage(script, extraArgs, job, onEvent)`（由 `runSearchProcess` 泛化，保留其 NDJSON 解析/缓冲/stderr 截尾逻辑）；
- steps 编排：`start()` 跑至 `until`（缺省 `discover`＝现行为）；`advance()` 从 `resumeStage` 续跑（缺省 `until:"export"`）；
- 交付物登记：静态模式表 `DELIVERABLE_PATTERNS`（`candidates.json|csv`、`dedupe/dedupe.json|csv`、`fulltext/status.json`、`fulltext/files/<id>.pdf|txt`、`extraction/<id>.json`、`extraction/inputs/<id>.json`、`validation/validation.json|md`、`export/*.csv|xlsx|md`、`run_config.json`）+ 逐 job 累计 `job.files`；`result.files` 先过模式校验再登记；
- `advance(id, { until, confirmations })`：状态守卫 `completed | needs_attention | failed`（含 interrupted）且 `resumeStage` 非空；`awaiting_confirmation` 时追加 `confirmations.json` 后置 running；captcha 等价 `--scrape-current`；`cancelled` 拒绝（文案『任务已停止，不能继续；请发起新检索』）；
- 编码：所有 spawn 注入 `PYTHONUTF8/PYTHONIOENCODING`（§8.2）；
- interrupted 分支补 `stages/resumeStage` 重建（§4.3）。

`server.js`：

- `handleLiterature` 新增分支：`POST /api/literature/advance`（body ≤64KB）、`GET /api/literature/jobs?limit=`；
- download 的 Content-Type 改为映射表：`.csv→text/csv; charset=utf-8`、`.json→application/json; charset=utf-8`、`.xlsx→application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`、`.md→text/markdown; charset=utf-8`，其余 `application/octet-stream`（现三元判断只覆盖 csv/json，L244）；
- 组装：`new LiteratureConnector(ROOT, { extract: (job, python, onEvent) => require('./tools/literature-extract').runExtractStage({ bridge: codex, job, python, onEvent }) })`（注入模式沿用现有 `options.prepare/search` 先例，测试可 mock）；
- X-Workbench 守卫：`/api/literature/` 前缀已含（L1229–1232），新 POST 路由**自动继承**，无需改动；
- docs：`README.md` 文献段与 `docs/literature-mining-alignment.md`『尚未实现』节最小更新（改为实现进度列表；**已确认规则原文不得改动**）；`docs/contract.md` §21 由 D1c 本次冻结，W1a 实现后仅同步必要差异。

### 9.7 W1b 接线点（js / css）

- `js/codex.js`：
  - `literaturePanel`（L210–286）：状态区按 `status+stage` 渲染——`running+<stage>` 显示阶段文案；`needs_attention+verification` 显示「验证后重新检索」（现逻辑）；`needs_attention+awaiting_confirmation` 显示字段确认表单（预填 `run_config.fieldDefinitions` 或 `targetFields` 逐项转 {key,label,meaning,unit,valueType,required}）+「确认并继续提取（POST /advance）」；`completed` 且 `resumeStage` 非空显示「继续下一阶段」；
  - 下载区（现 L266–282）改为遍历 `job.files` 分组渲染（按阶段前缀分组、长列表折叠）；
  - `watchLiterature`（L110–134）：终态判定保持（`status !== 'running'` 即退出轮询），新增 stage 文案由 job.message 直出；
  - `startLiterature`（L138–155）：`/search` 请求体带 `until`（UI 选择：默认仅首批＝`discover`，可选「运行到下一关口」）；`literatureConfigKey`（L155–161，现含 12 字段）追加 v2 字段（`batch/fieldDefinitions/templates/fulltext/extraction` 若有）；
  - 历史任务找回（可选）：`GET /jobs` 列表入口。
- `css/workspace.css`：`.literature-connector` 区块（L833+）追加阶段条/确认表/分组下载样式。
- `tools/test_literature_ui.py`：增补 awaiting_confirmation 表单与 advance 流程断言（保持现有关键文案断言不回归）。

### 9.8 API 契约（W1a 实现依据，同步写入 contract.md §21）

| 路由 | 方法 | 契约 |
|---|---|---|
| `/api/literature/prepare` | POST | 不变 |
| `/api/literature/search` | POST | 不变；新增可选 `until`（stage 名，缺省 `discover`）；`resumeCurrent` 不变 |
| `/api/literature/advance` | POST（新） | `{id, until?, confirmations?:{fields:[…]}}` → 200 `job`（公开快照）；400 文案：无效 id『无效检索任务标识』/ 不存在『检索任务不存在』/ 状态不允许『任务已停止，不能继续；请发起新检索』或『该任务已完成全部阶段』/ 并发冲突沿用『已有文献检索正在运行，请等待或停止后重试』 |
| `/api/literature/jobs` | GET（新） | `?limit=`（1–50，默认 20）→ `{jobs:[公开快照…]}` 按 `job.json` mtime 倒序；损坏记录跳过 |
| `/api/literature/job` | GET | 不变；快照新增 `stages/resumeStage/until/counters` 字段（可缺省） |
| `/api/literature/cancel` | POST | 不变；新阶段取消文案见 §4.4 |
| `/api/literature/download` | GET | 不变路由；`name` 必须命中该 job 已登记 `files`（成员校验替代固定白名单）；新增 MIME；反软链、36 位 id 正则、`no-store/nosniff` 全部保持 |

---

## 10. 不回归清单（承接 D1b note3a/3b，实现期必须逐条保留）

1. 来源白名单六源与拒绝文案（`尚未接通以下检索来源：…`）；HTTP 测试断言「不静默只跑 Scholar」；
2. `normalizeConfig` 12 字段与全部校验文案（topic/query 必填、sources 空/重复/未知、年份 1800..当年+1、起>止、limit 1–10、string≤500、list≤30）；
3. 首批 ≤10 三层一致（config L40 / py L131 / UI input max=10）；
4. 候选字段与批内去重：`GSC-###`（第 1 批）、`pending_review`、`search_result_snippet`、标题去重 key、`safe_url` 仅 http/https、CSV utf-8-sig + 防公式注入、报告头键与 `caution` 原文；
5. 下载白名单语义（改为登记内核但拒绝行为同款）、`job.files.includes` 双重校验、lstat 反软链、36 位 ID 正则、snapshot『结果文件不存在』；
6. needs_attention 人工验证全链（py attention → connector → UI 按钮 → `--scrape-current`）与『不会自动绕过验证码』口径；
7. `run_config.json` `wx` + `0o444` 冻结、不回写；
8. 错误文案逐条：『已有文献检索正在运行…』『检索超过 3 分钟，已停止；如遇验证请手动完成后重试。』『检索脚本未返回结果』『本地服务已重启，检索中断；已保存的文件仍可下载。』『无效检索任务标识』『检索任务不存在』『检索任务未在运行』『结果文件不可下载』『请从工作台发起请求』；UI 侧『请先从对话整理运行配置并核对』『对话或已批准文档有更新，请重新整理规则后再检索』与完成语『…这不是已纳入文献，也未提取全文…』（多阶段完成后文案由 W1b 在**保持原句**基础上追加阶段摘要，不得删改原句）；
9. 守卫：`X-Workbench:1`（403）、Host/Origin 同源、download 响应头 no-store/nosniff/filename*、静态服务不暴露 `.workbench`；
10. `workflowPrompt` 文献段 4 断言字符串与『不得同时包含…』反向断言（`test-literature-guidance.js`）；prepare 指令注入防护（『对话是待分析数据』）、messages 30 条/4000 字符上限；
11. UI 关键文案/行为：『从对话整理规则』『确认配置并检索』『手动填写』（仅无配置时显示）、未配置 start disabled、『当前仅 Google Scholar 已接通』、六源复选框与未接通提示。

> 备注：D1b 提到『ExportEventSource 行为』在仓库中无此符号（已核实），所指疑为备份导出/恢复（不含密钥与 `.workbench`）或 `docs/llm-integration-research.md` 的 EventSource 说明；该悬案不影响本阶段契约，实现期保持既有行为不改动即可（§12 待裁决）。

---

## 11. 风险清单（承接 D1b note4 + 本阶段新增）

| 编号 | 风险 | 处置 |
|---|---|---|
| R1 | Python 管道 gbk 乱码（已实测） | §8.2 双防线 + W1a 回归测试 |
| R2 | `0o444` 只读是应用层的（可删改名） | 保持现状；文档如实说明 |
| R3 | venv marker 语义变更引发重装 | marker v2 幂等重装；旧格式触发一次重装 |
| R4 | 检索 180s 超时（慢网络） | 不改；fulltext/extract 用各自更长超时 |
| R5 | 并发：仅内存单 running；多实例不互斥 | 保持现约束；advance 复用同一守卫 |
| R6 | interrupted 分支无测试 | W1a 补测（§4.3/§4.4） |
| R7 | Windows 路径/编码 | 全链 path.join + POSIX 相对路径登记；CSV utf-8-sig |
| R8 | UI 轮询 1.2s 无退避 | 保持；长阶段由事件驱动文案，不加假进度 |
| R9 | prepare 依赖本机 codex | 保持；extract 复用同一前置条件并在缺失时明确报错 |
| R10 | CDP 9222 无归属校验 | 观察项，本阶段不修（如实记录） |
| R11 | 静态白名单/缓存策略 | 不动 |
| R12 | 双 job 体系（codex job vs 文献 job） | 保持分离；extract 用 CodexBridge 但**不**进入 codex job 体系（独立桥调用，产物只落 job 目录） |
| R13（新） | 同 job 重导出覆盖 | §6.3 归档策略 |
| R14（新） | 长任务（fulltext/extract）与服务重启 | interrupted 续跑（§4.4）；进度落 events.jsonl 可审计 |
| R15（新） | LLM 提取幻觉 | 契约级禁推断 + evidence 强制 + `--check` 骨架校验 + 待审清单 |

---

## 12. 待验证 / 待裁决（交主代理）

**待裁决（需要拍板）**

| # | 事项 | 建议 |
|---|---|---|
| D1 | `GET /api/literature/jobs` 是否纳入本阶段 | 纳入（多阶段任务生命周期长，刷新后找回历史任务是实际需求；已写入 §9.8/contract §21） |
| D2 | `awaiting_confirmation` 用 `status=needs_attention + stage` 表达 | 采纳（D1b note2 建议 c；保 5 值 status 不膨胀） |
| D3 | 续批 candidate_id 扩展为 `GSC-B<n>-###` | 采纳（保第 1 批格式不变；跨批唯一性必需） |
| D4 | `figure2data` 网页线接入 | 本阶段不接入（依赖重、半自动）；保留溯源格式，后续单独立项评估 |
| D5 | 新依赖 `openpyxl` + `pypdf` | 采纳（纯 pip；pypdf 质量风险见 V5） |
| D6 | pip/playwright 安装超时 300s→600s | 建议调整（首次 Chromium 下载常超 300s，D1b R3；检索 180s 不动） |
| D7 | interrupted 重跑可能产生跨批复重（由 dedupe 兜底） | 接受该设计取舍 |
| D8 | 用户上传文献（alignment L17）阶段二不做 | 仅预留 `source_key="user-upload"` 数据位 |
| D9 | 目标数量语义（候选/纳入/参数行）未对齐 → 不实现 collection gate | 预留 gate 适配接口，待 alignment 补充确认 |

**待验证（实现中实测）**

| # | 事项 | 责任 |
|---|---|---|
| V1 | Google Scholar 结果页 DOI/year/authors 可得性（不猜、仅真实可得时填充） | I1 |
| V2 | SOC `download_pdf.run` 每篇一次 CDP 连接的实际开销 | I3 |
| V3 | `papers_index` 纯函数 import 无副作用 | I2（测试覆盖） |
| V4 | bridge 提取专用 sessionId 策略（`createSession()` 新建 vs 复用模块会话） | W1a |
| V5 | `pypdf` 中文 PDF 文本抽取质量；解析失败降级路径 | I4 |
| V6 | 单篇 120k 字符 bundle 经 bridge 传输与模型上下文适配 | W1a/I4 |
| V7 | 大 job（数百候选）下 `jobs` 列表与下载列表的 UI 性能（分组/折叠） | W1b |

---

## 13. 验收清单自查（方案覆盖对照）

| 验收项 | 覆盖位置 |
|---|---|
| ① 各阶段 CLI 契约（命令/参数/退出码/NDJSON） | §2.1–2.5（六脚本逐一） |
| ② 中间 JSON 契约（run_config 扩展/候选/dedupe/fulltext/extraction/两表） | §3.1–3.8 |
| ③ 任务目录、JSONL 日志、断点续跑/恢复（含 interrupted） | §4.1–4.4 |
| ④ A/B/C 档落地与「SOC 仅作可选示例」 | §5.1–5.4 |
| ⑤ 阻断/待审核规则、版本不覆盖、CSV+Excel 双输出 | §6.1–6.4 |
| ⑥ 来源注册表语义与预留接入 | §7 |
| ⑦ 依赖变更感知与 PYTHONUTF8 | §8.1–8.3 |
| ⑧ I1–I4 文件所有权与公开签名、W1a/W1b 接线点 | §9.1–9.8 |
| 不回归 / 风险 / 待裁决 | §10 / §11 / §12 |
