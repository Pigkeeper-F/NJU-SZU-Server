# SOC Database Pipeline

This pipeline collects preliminary point-site article data for a China-region SOC prediction dataset.

The current workflow uses Google Scholar to discover original field-experiment articles, prioritizes directly readable full-text pages, and saves PDFs only when needed. The final structured records are merged into the Excel template under `spec/data.xlsx`.

## Admission Rules

Only collect original field-experiment articles that satisfy all of the following:

- the field site is in China;
- the site is locatable later from coordinates, a named station/farm/village/county/city/province, or another traceable site description;
- the article reports explicit numeric SOC values, or a calibratable SOC chart that can be digitized;
- site, sampling year/time, treatment, crop, and fertilization or management information are clear.

Reject non-China studies, unlocatable sites, reviews/meta-analyses, pure simulations, indoor incubation-only studies, and papers that report only POC, MAOC, soil organic matter, yield, emissions, or nitrogen losses without explicit SOC.

## Collection Endpoint

The current collection endpoint is configured in `collection_endpoint.json`.
It is a spatial-model readiness endpoint, not a raw literature-count endpoint.

Default hard requirements:

- `valid_unique_points >= 500`;
- `valid_surface_points_0_30 >= 500`;
- `min_agro_region_unique_points >= 60`;
- `invalid_coordinate_rows = 0`;
- `max_rows_per_point_share <= 0.05`.

Check progress with:

```bash
python scripts/collection_endpoint.py --fail-open
```

Run without `--fail-open` in automation if a non-zero exit code should mean
"keep collecting". The endpoint reads the merged/model-ready CSV specified by
`model_dataset` and only uses pipeline paper/JSON counts as supporting context.

## Active-learning pilot runs

Before a full collection run, use the project-neutral pilot layer to select
informative samples rather than only random samples. It ranks candidates by
configurable uncertainty, boundary risk, format risk, and expected impact, then
preserves stratum coverage and writes a review template:

```bash
python scripts/active_learning_pilot.py rank \
  --candidates papers_index.csv \
  --config configs/active_learning_pilot.example.json \
  --out results/pilot \
  --round-id round_01 \
  --rule-version rules_v0.1
```

Review `results/pilot/round_01/review_template.csv`, append completed reviews,
then summarize the round:

```bash
python scripts/active_learning_pilot.py review \
  --reviews results/pilot/round_01/review_template.csv \
  --out results/pilot/reviews.jsonl \
  --round-id round_01 \
  --reviewer analyst_01 \
  --validation-session-id supervise_round_01_001

python scripts/active_learning_pilot.py report \
  --reviews results/pilot/reviews.jsonl \
  --out results/pilot/round_01/round_metrics.json
```

Keep calibration, boundary, and blind-validation samples separate. Increment
the rule version whenever a rule changes, and freeze a version only after two
consecutive rounds show no high-severity rule changes.

For two-Codex-session supervision, create a read-only handoff packet for a new
supervisor task:

```bash
python scripts/active_learning_pilot.py supervisor-packet \
  --collection-manifest results/pilot/round_01/round_manifest.json \
  --out results/pilot/round_01/supervisor \
  --supervisor-session-id supervise_round_01_001
```

The supervisor task reads `supervisor_prompt.md`, inspects the listed artifacts,
and writes `supervisor_decision.json`. Validate its gate before continuing:

```bash
python scripts/active_learning_pilot.py supervisor-gate \
  --collection-manifest results/pilot/round_01/round_manifest.json \
  --decision results/pilot/round_01/supervisor/supervisor_decision.json
```

The pipeline enforces distinct collector and supervisor session IDs and does
not let a supervisor overwrite collection artifacts. Codex task creation and
navigation remain an app-level operation; the packet and gate are the portable
interface.

土壤有机碳（SOC）文献数据库构建流水线。当前版本以 **Google Scholar 发现文献** 为入口，优先从可直接阅读的全文网页抽取数据；只有网页不可稳定读取、需要留存来源或全文只以 PDF 提供时，才保存 PDF。最终输出合并到 `spec/data.xlsx` 对应结构的 Excel 数据库。

## 当前准入规则

只录入 **明确给出 SOC 数值** 的原始田间试验文章。仅报告 POC、MAOC、土壤有机质、产量、N2O、NH3、CH4、氮淋溶或氮径流，但没有明确 SOC 数值的文章必须跳过。

排除：综述、meta 分析、纯模型模拟、室内培养试验、没有地点/年份/处理/作物/施肥信息的文章。

## Pipeline 三步

```
[Step 1] Google Scholar 发现全文来源
          -> 可读全文 URL，或必要时 papers/{n}.pdf
          -> 每个候选先查 papers_index.csv 去重

[Step 2] 数据提取
          -> outputs/{n}.json
          -> 逐行必须有明确 SOC 数值

[Step 3] 合并数据库
          -> results/SOC-Database_filled.xlsx
```

## 常用命令

启动持久浏览器：

```bash
python .codex/skills/soc-paper-fetch/scripts/browser.py launch
```

Google Scholar 搜索候选：

```bash
python .codex/skills/soc-paper-fetch/scripts/google_scholar_search.py \
  --query "China soil organic carbon long-term fertilization experiment" --limit 10
```

For broader discovery, rotate through the main, regional, and management-practice search terms in `.codex/skills/soc-paper-fetch/references/criteria.md`.

候选去重：

```bash
python scripts/papers_index.py check --title "<paper title>" --doi "<doi or empty>"
```

如果必须保存 PDF：

```bash
python .codex/skills/soc-paper-fetch/scripts/download_pdf.py \
  --url "<publisher-or-pdf-url>" --out-id <n>
```

校验单篇抽取结果：

```bash
python scripts/validate_output_v2.py outputs/<n>.json
```

合并到新模板：

```bash
python scripts/merge.py \
  --template spec/data.xlsx \
  --schemas schemas/ \
  --outputs outputs/ \
  --target results/SOC-Database_filled.xlsx \
  --report results/merge_report.md
```

模板变更后重建 schema：

```bash
python scripts/export_schema.py spec/data.xlsx schemas/
```

## 目录结构

```
soc-database-pipeline/
├── AGENTS.md
├── requirements.txt
├── .codex/
│   └── skills/
│       ├── soc-paper-fetch/        # Google Scholar 发现 + 可选 PDF 获取
│       ├── soc-database-extract/   # 全文/PDF -> JSON
│       └── figure2data/            # 图表数字化 fallback
├── scripts/
│   ├── merge.py
│   ├── export_schema.py
│   ├── validate_output_v2.py
│   └── papers_index.py
├── schemas/
│   ├── 点位试验.json
│   └── 长期定位试验.json
├── spec/
│   └── data.xlsx                   # 当前 Excel 模板
├── papers/                         # 可选 PDF 落地
├── outputs/                        # 抽取结果 JSON
└── results/                        # 最终 xlsx + merge_report.md
```

`papers/`、`outputs/`、`results/` 是本地数据目录，不进版本库。仓库交付流水线代码、schema、模板和去重索引。
