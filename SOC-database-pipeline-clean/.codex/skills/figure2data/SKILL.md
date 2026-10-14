---
name: figure2data
description: 从科研论文 PDF 图表中提取结构化数据 (CSV)。适用：柱状图全自动、折线图 Codex 视觉读图半程自动。批量化处理几千篇文献的首选 ETL skill。触发于：从 figure/图 提数据、读图表、figure2data、getdata 级别的任务。
---

# figure2data

批量从 PDF 科研图表抽取数据到 CSV。柱状图走像素算法全自动；折线图由 Codex 多模态视觉读值，程序落盘。

## 何时用

- 用户提到：**"从图表读数据"、"figure 转 CSV"、"figure2data"、"图表数据化"、"批量抽图表数据"、"读图表到 Excel"**
- 用户指 PDF + figure 编号
- 用户项目位于 `04_project/07_figure2data/` 或类似

## 何时不用

- 论文给了 supplementary CSV/Excel → 用原数据
- 单张图一次性读 → 手动用 GetData / WebPlotDigitizer 可能更快
- 非 PDF 来源（网页图表、动态图）

## 使用流程

### 0. 准备一份 figure config JSON

每个 figure 需要一份 config 定义子图布局和每个子图的轴信息。Codex 应从 figure caption + preview 图读取信息后自动生成。

示例: `examples/81_fig2.json`（高碳稻田 CH4 排放通量 + 累计排放量图）

### 1. 从 PDF 提 figure 原生高分辨率图 + 切子图

```bash
python -m figure2data.pipeline extract_figure --config FIG_CONFIG.json --out-dir DATA_DIR/
```

会产出 `figure_native.png` + 各个 `{subplot_name}.png`。

### 2. 柱状图子图（全自动）

```bash
python -m figure2data.pipeline bar \
  --subplot DATA_DIR/A_bar.png --config A_bar.json --out-dir DATA_DIR/
```

产出 `A_bar.csv` + `A_bar_verify.png`（红点柱顶 / 绿点误差棒顶的叠加图，**Codex 必须 Read 核验一次**）。

### 3. 折线图子图（Codex 视觉读图）

3a. 自动预处理：校准坐标轴 + 探测 x-tick + 写 meta

```bash
python -m figure2data.pipeline line_pre \
  --subplot DATA_DIR/A_line.png --config A_line.json --out-meta DATA_DIR/A_line_meta.json
```

3b. Codex **Read 该子图** `DATA_DIR/A_line.png`，按 legend 识别系列形状，按 y 轴刻度读每个 tick 每个系列的数值。输出 JSON 到 `DATA_DIR/A_line_readings.json`：

```json
{
  "T1": {"CK": 65, "N0": 32, "RFF": 130, "HACF": 48, "PACF": 68},
  "T2": {"CK": 125, "N0": 200, ...},
  ...
}
```

Tn 按 config 里的 dates 顺序。峰值区目测精度 ±5 单位，末期 ±2。重叠严重的 tick 允许标 null。

3c. finalize 写 CSV

```bash
python -m figure2data.pipeline line_final \
  --meta DATA_DIR/A_line_meta.json --readings DATA_DIR/A_line_readings.json --out-dir DATA_DIR/
```

产出 `A_line.csv` + `A_line_verify.png`。**Codex 核验 verify 图**：每个彩圈应落在该系列 marker 附近；有系统偏差就让 Codex 纠正 readings 重跑。

### 4. 合并汇总

同一 figure 多个子图的 CSV 归到一个目录即可。用户可自行合并。

## Config 格式

**Figure config** (step 1)：

```json
{
  "pdf_path": "81.pdf",
  "page_idx": 4,
  "fig_output": "fig2_native.png",
  "subplots": {
    "A_line": {"crop": [100, 80, 1450, 1200]},
    "A_bar":  {"crop": [1450, 80, 2900, 1200]},
    "B_line": {"crop": [100, 1400, 1450, 2550]},
    "B_bar":  {"crop": [1450, 1400, 2900, 2550]}
  }
}
```

**Bar subplot config** (step 2)：

```json
{
  "y_axis_side": "right",
  "tick_values": [0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800],
  "bar_order": ["CK", "N0", "RFF", "HACF", "PACF"],
  "y_unit": "kg·hm-2",
  "digit_w": [8, 30], "digit_h": [20, 50], "digit_area": [100, 600]
}
```

**Line subplot config** (step 3a)：

```json
{
  "y_axis_side": "left",
  "y_tick_values": [0, 50, 100, 150, 200, 250],
  "dates": ["06-29", "07-06", "07-20", "08-04", "08-17", "08-31", "09-15", "09-28", "10-12"],
  "series_order": ["CK", "N0", "RFF", "HACF", "PACF"],
  "digit_w": [8, 30], "digit_h": [20, 50], "digit_area": [100, 600]
}
```

`digit_*` 参数按图的分辨率调：低分辨率 (3x page render) 用默认 (4,12)/(10,20)/(25,150)；native PDF 嵌图用 (8,30)/(20,50)/(100,600)。

## 精度预期

- **柱状图**：像素级，值误差 <1%
- **折线图**：峰值区 ±5, 末期 ±2（单位按 y 轴）。远好于不读（∞ 误差）但差于 getdata (±1)

## 已知局限

- 需要 PDF 里 figure 是**嵌入图**（非矢量线条）。矢量 figure 需要用 fitz 解析 path 另做。
- 每个 figure 需要一份 config——跨 figure 布局不同无法复用。Codex 在首次处理时从 caption + preview 自动写出。
- 折线图 ≥5 系列密集重叠时，Codex 视觉读数可能分错系列 1-2 个，需要 verify.png 核查。
