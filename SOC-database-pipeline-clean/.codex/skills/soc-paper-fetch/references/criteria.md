# SOC source screening criteria

This pipeline collects preliminary point-site article data for a China-region SOC prediction dataset. Google Scholar is the discovery entry point. Prefer directly readable full-text pages; save PDFs only when the page cannot be read reliably or the PDF is the only usable source.

## Admission gate

Keep an article only when all conditions are met:

1. **China-region site**: the field site is in China.
2. **Locatable point site**: the article reports enough site information for later geocoding, such as coordinates, an experimental station, farm, village, county, city, province, or another traceable place description.
3. **Experiment type**: field experiment, plot experiment, point-site experiment, long-term field experiment, long-term fertilization experiment, or fixed field platform.
4. **Core metadata**: site, sampling year/time, treatment, crop, and fertilization or management measures are clear.
5. **Explicit SOC**: the article reports numeric SOC values, or provides a quantitative SOC chart with calibrated axes that can be digitized by `figure2data`.

POC, MAOC, soil organic matter, yield, NH3, N2O, CH4, N leaching, and N runoff do not satisfy the SOC requirement by themselves.

## Reject

- Study area outside China.
- Country/region unclear.
- SOC values not tied to a traceable field site.
- Review, meta-analysis, or systematic review itself.
- Pure model simulation.
- Indoor incubation or pot experiment without a field experiment.
- Missing any key metadata among site, treatment, crop, and sampling time.
- Only soil organic matter is reported and the paper does not provide an explicit conversion rule to SOC.
- SOC appears only in an uncalibrated schematic, blurry chart, or chart where treatments cannot be distinguished.

## Google Scholar search suggestions

Use search terms in batches. Start with the main terms, then expand by region and management practice to improve recall.

### Main English terms

- `China soil organic carbon field experiment fertilization`
- `China soil organic carbon long-term fertilization experiment`
- `China SOC long-term fertilization field experiment`
- `China soil organic carbon manure chemical fertilizer field trial`
- `China soil organic carbon straw return field experiment`
- `China soil organic carbon tillage field experiment`
- `China soil organic carbon irrigation field experiment`
- `China soil organic carbon cropland field experiment`

### Main Chinese terms

- `中国 土壤有机碳 长期施肥 田间试验`
- `土壤有机碳 长期定位试验 中国`
- `土壤有机碳 施肥 大田试验 中国`
- `土壤有机碳 有机肥 化肥 配施 田间试验`
- `土壤有机碳 秸秆还田 大田试验`
- `土壤有机碳 耕作 田间试验 中国`
- `土壤有机碳 灌溉 田间试验 中国`
- `农田 土壤有机碳 长期定位`

### China region terms

- `Northeast China black soil SOC long-term fertilization`
- `North China Plain soil organic carbon fertilization field experiment`
- `Loess Plateau soil organic carbon field experiment`
- `Yangtze River Basin soil organic carbon rice wheat rotation`
- `paddy soil organic carbon China fertilization field experiment`
- `red soil China soil organic carbon long-term fertilization`
- `东北黑土 土壤有机碳 长期施肥`
- `华北平原 土壤有机碳 施肥 田间试验`
- `黄土高原 土壤有机碳 长期施肥`
- `长江中下游 稻麦轮作 土壤有机碳`
- `水稻土 土壤有机碳 长期施肥`
- `红壤 土壤有机碳 长期定位`

### Management-practice terms

- `China SOC manure NPK field experiment`
- `China SOC organic inorganic fertilizer field experiment`
- `China SOC straw return no tillage field experiment`
- `China soil organic carbon cover crop field experiment`
- `China soil organic carbon biochar field experiment`
- `SOC 有机无机配施 中国 田间试验`
- `土壤有机碳 有机肥 NPK 长期施肥`
- `土壤有机碳 生物炭 田间试验 中国`
- `土壤有机碳 免耕 秸秆还田 中国`
- `土壤有机碳 覆盖作物 中国 田间`

## Candidate handling order

1. Open the Scholar result title link and any right-column full-text/PDF link.
2. Confirm China-region location and point-site traceability before extracting data.
3. Prefer HTML full text when methods, treatments, tables/figures, and SOC results are visible.
4. Save a PDF only when full text cannot be read reliably online.
5. Run `papers_index.py check` before spending extraction time on a source.
6. After confirming a usable source, run `papers_index.py add` and use `source=google-scholar:<url-or-domain>`.

## Figure SOC

Use `figure2data` only when SOC is required and text/table values are unavailable. Every digitized value must be marked in `备注`:

```text
{field}: figure-extracted from {Fig ID} {chart type}
```

Do not estimate chart values by eye.
