# SOC Database Pipeline

本项目用于从农业活动/田间试验文献中收集明确报告 SOC 的结构化数据，并合并到 Excel 数据库。当前目标是 **数据收集**，不是下载文章本身；PDF 只是全文不可稳定在线读取时的 fallback。

## Pipeline

```
[Step 1] 来源发现       -> Google Scholar 候选 + 全文 URL / 可选 papers/{n}.pdf
[Step 2] 数据提取       -> outputs/{n}.json
[Step 3] 合并 Excel     -> results/SOC-Database_filled.xlsx
```

## Step 1：Google Scholar 来源发现

使用持久 Chromium 浏览器，用户可在其中完成 Google/机构登录或验证码。浏览器状态保存在 `.codex/skills/soc-paper-fetch/state/user-data/`。

```bash
python .codex/skills/soc-paper-fetch/scripts/browser.py launch
python .codex/skills/soc-paper-fetch/scripts/browser.py status
```

搜索候选：

```bash
python .codex/skills/soc-paper-fetch/scripts/google_scholar_search.py \
  --query "China soil organic carbon long-term fertilization experiment" --limit 10
```

Google Scholar 只作为发现入口。每个候选按以下顺序处理：

1. 打开 Scholar 标题链接或右侧全文/PDF 链接。
2. 如果网页能直接阅读完整方法、处理、结果表/图，直接作为全文来源抽取。
3. 如果网页不能稳定读取，但提供 PDF 或下载按钮，才保存为 `papers/{n}.pdf`。
4. 如果只有摘要、引用页、付费墙、验证码且无法人工通过，跳过。

每个候选都必须先查重：

```bash
python scripts/papers_index.py check --title "<title>" --doi "<doi or empty>"
```

命中 DOI、标题子串或 Jaccard >= 0.55 时跳过。可处理的新来源成功确认后写回：

```bash
python scripts/papers_index.py add --id <n> --title "<title>" --doi "<doi or empty>" --source "google-scholar:<url-or-domain>"
```

如果保存 PDF：

```bash
python .codex/skills/soc-paper-fetch/scripts/download_pdf.py --url "<url>" --out-id <n>
```

如果不保存 PDF，仍使用该编号写 `outputs/{n}.json`；`source_pdf` 可写成 `<n>.html` 或 `<n>.url`，`No.` 必须为 `<n>`，并在 `备注` 记录全文 URL/DOI。

## 录入准入规则

只录入同时满足以下条件的原始研究：

| 条件 | 要求 |
|---|---|
| 区域 | 研究点位必须在中国区域 |
| 点位可定位性 | 至少有经纬度、试验站/农场/村镇/县市/省份，或其他后续可地理编码的地点描述 |
| 文章类型 | 原始田间试验/大田试验/点位试验/长期定位试验/长期施肥试验 |
| 元数据 | 地点、年份/采样时间、处理、作物、施肥或管理措施明确 |
| SOC | 文章明确报告 SOC 数值，或有可校准图表可读出 SOC 数值 |

硬性跳过：

- 综述、meta 分析、系统综述本身。
- 非中国区域研究，或无法追溯到具体点位的 SOC 数据。
- 纯模型模拟、室内培养、盆栽且无田间试验。
- 只有 POC、MAOC、土壤有机质、产量或气体/氮损失，没有明确 SOC。
- 需要从土壤有机质换算 SOC 但论文没有给出转换系数或明确说明。
- 图表没有坐标轴、处理无法区分、误差棒遮挡、或只能目测趋势。

## Step 2：数据提取

`soc-database-extract` 可以从 PDF 或可读全文网页提取。输出必须是单个 JSON object，顶层 key 固定：

```
source_pdf, status, sheet, classification_reason, rows, warnings, skip_reason
```

分类：

- 明确长期定位/长期施肥平台/多年固定处理 -> `长期定位试验`
- 否则 -> `点位试验`

拆行：

- 一行 = `{地点 × 处理 × 采样年份/时间年份 × 作物}`。
- 年份、作物季、处理、地点不同必须拆行。
- 土层不拆行，写入对应 SOC 深度列或 `SOC.土层（cm）`。

禁止行为：

1. 不从地名猜经纬度。
2. 不从气象站名查气候数据。
3. 不从土壤类型名猜 Sand/Silt/Clay。
4. 不从处理缩写推断施肥量。
5. 不从有机肥名称猜 C/N 或 pH。
6. 不把 POC/MAOC/土壤有机质当作 SOC。
7. 不目测柱高/曲线读精确值，除非使用 `figure2data` 校准读图。

SOC 图表 fallback：

- 只有当 SOC 数值不存在于表格、正文、补充材料、图注或图内标签时，才用 `figure2data`。
- 每个图读值必须在 `备注` 标注：`{field}: figure-extracted from {Fig ID} {chart type}`。

写盘后必须校验：

```bash
python scripts/validate_output_v2.py outputs/{n}.json
```

校验器会硬性拒绝没有明确 SOC 值的非 skipped 行。

## Step 3：合并 Excel

当前模板为 `spec/data.xlsx`，schema 已由该模板导出。

```bash
python scripts/merge.py \
  --template spec/data.xlsx \
  --schemas schemas/ \
  --outputs outputs/ \
  --target results/SOC-Database_filled.xlsx \
  --report results/merge_report.md
```

`merge.py` 会复制模板并清空第 3 行及以下旧数据，只保留两行表头，然后写入 `outputs/*.json`。

模板变更后：

```bash
python scripts/export_schema.py spec/data.xlsx schemas/
```

## 运行环境

- Python 3.10+
- `pip install -r requirements.txt`
- `python -m playwright install chromium`
- 浏览器运行在 CDP 端口 9222，可跨 Codex session 复用。
