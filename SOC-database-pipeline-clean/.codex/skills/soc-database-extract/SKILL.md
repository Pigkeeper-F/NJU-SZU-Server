---
name: soc-database-extract
description: Extract structured SOC data from one full-text article page or PDF into a JSON row set matching the SOC database schema. Use for original field-experiment papers that explicitly report SOC values.
---

# SOC Database Extraction

Turn one source article into one JSON file matching `schemas/*.json`. The source may be a local PDF (`papers/{n}.pdf`) or a directly readable full-text web page found through Google Scholar. PDF download is not required when the page itself contains the methods, treatments, and SOC results.

## Output Contract

Write a single JSON object with exactly these top-level keys:

```
source_pdf, status, sheet, classification_reason, rows, warnings, skip_reason
```

For direct web full text, keep the compatibility key `source_pdf` and set it to `<id>.html` or `<id>.url`. Each row's `No.` must equal the numeric id.

Allowed row keys are only:

- the exact composite keys listed under `Sheet Schemas`
- `_split_key`
- optional `_sheet`

No invented columns, no renamed columns, and no extra prefixes.

## Hard Admission Rule

Every non-skipped row must contain an explicit SOC numeric value. Valid SOC value fields are:

- `土壤信息.SOC (g/kg)` for point experiments
- `SOC.SOC     0-30cm`, `SOC.SOC     30-60cm`, `SOC.SOC     60-100cm` for point experiments
- `SOC.SOC          0-30cm`, `SOC.SOC     30-60cm`, `SOC.SOC     60-100cm` for long-term experiments

`SOC.SOC原始单位`, `SOC.土层（cm）`, POC, MAOC, soil organic matter, yield, emissions, and nitrogen loss fields do **not** satisfy this rule.

If the article does not explicitly report SOC, return `status="skipped"` with a clear `skip_reason`.

## China Point-Site Rule

Every extracted article must describe a field site in China that can be located later. The article does not need to provide exact coordinates, but it must provide enough site evidence to support geocoding, such as:

- latitude/longitude;
- a named experimental station, farm, village, county, city, or province;
- a clear site description inside China that can be traced from the article.

Return `status="skipped"` when the field site is outside China, the country/region is ambiguous, or the SOC data are not tied to a traceable point site. Do not infer coordinates from place names during extraction; record only what the article reports.

## Extraction SOP

1. Read the full text or PDF.
2. Confirm it is an original China-region field experiment with a locatable site, sampling year/time, treatment, crop, and management/fertilization information.
3. Classify:
   - `长期定位试验` if the paper explicitly uses a long-term platform, long-term fertilization experiment, or fixed treatments over many years.
   - otherwise `点位试验`.
4. Split rows by `{site × treatment × sampling year/time × crop}`.
5. Extract schema fields in order. Use only reported values or allowed calculations.
6. If SOC exists only in a quantitative chart, use `figure2data`; do not estimate by eye.
7. Write the JSON atomically and run `python scripts/validate_output_v2.py outputs/{n}.json`.

## Forbidden

- Do not infer coordinates from place names.
- Do not look up climate data from station names.
- Do not infer soil texture from soil type.
- Do not infer fertilizer amounts from treatment abbreviations.
- Do not infer C/N or pH from manure names.
- Do not convert soil organic matter to SOC unless the paper explicitly provides the conversion rule.
- Do not treat POC or MAOC as SOC.
- Do not read chart values by visual estimate without calibrated digitization.

## Provenance

Use `备注` for source notes, formulas, URL/DOI, and figure extraction marks. For figure-derived SOC:

```
{field}: figure-extracted from {Fig ID} {chart type}
```

For calculated values:

```
{field}: calculated: {formula}
```

## Status Values

- `ok` — rows extracted and every row has explicit SOC.
- `partial` — rows extracted, explicit SOC present, but major non-SOC fields are missing.
- `skipped` — no explicit SOC, off-topic, not original field experiment, unreadable, or unclassifiable.

## Sheet Schemas

### 点位试验 (58 fields)

```
No.
Reference
处理名称
采样年份
点位信息.Region
点位信息.经度
点位信息.纬度
气候信息.年均温/℃
气候信息.年均降水/mm
土壤信息.PH
土壤信息.容重（g/cm3）
土壤信息.Sand (%)
土壤信息.Silt (%)
土壤信息.Clay (%)
土壤信息.STN (g/kg)
土壤信息.SOC (g/kg)
作物信息.Crop type
作物信息.轮作体系
作物信息.间作体系
施肥信息.总施肥量（kg N/ha）
施肥信息.化肥类型
施肥信息.化肥用量（kg N/ha）
施肥信息.有机肥用量（kg N/ha）
有机肥信息.大类
有机肥信息.详细类型
有机肥信息.C含量(g/kg)
有机肥信息.N含量(g/kg)
有机肥信息.C/N
有机肥信息.PH
有机肥信息.有机肥施用量（t/ha）
灌溉管理.灌溉方式
灌溉管理.灌溉量(m3/ha)
耕作管理.耕作方式
耕作管理.秸秆还田
耕作管理.秸秆还田方式
耕作管理.还田比例（%）
土壤调理剂.调理剂类型
土壤调理剂.施用量（t/ha）
覆盖作物.作物类型
活性氮损失（kg N/ha）.NH3
活性氮损失（kg N/ha）.N2O
活性氮损失（kg N/ha）.N leaching
活性氮损失（kg N/ha）.N runoff
碳排放.CH4（kg/ha）
SOC.SOC     0-30cm
SOC.POC     0-30cm
SOC.MAOC     0-30cm
SOC.SOC     30-60cm
SOC.POC     30-60cm
SOC.MAOC     30-60cm
SOC.SOC     60-100cm
SOC.POC     60-100cm
SOC.MAOC     60-100cm
SOC.SOC原始单位
SOC.土层（cm）
土壤容重（g/cm3）
Yield.t/ha
备注
```

### 长期定位试验 (52 fields)

```
No.
Reference
处理名称
采样年份
试验持续时间
时间年份
点位信息.Region
点位信息.经度
点位信息.纬度
气候信息.年均温/℃
气候信息.年均降水/mm
土壤信息.PH
土壤信息.容重（g/cm3）
土壤信息.Sand (%)
土壤信息.Silt (%)
土壤信息.Clay (%)
土壤信息.STN (g/kg)
SOC.SOC          0-30cm
SOC.POC       0-30cm
SOC.MAOC     0-30cm
SOC.SOC     30-60cm
SOC.POC     30-60cm
SOC.MAOC     30-60cm
SOC.SOC     60-100cm
SOC.POC     60-100cm
SOC.MAOC     60-100cm
SOC.SOC原始单位
SOC.土层（cm）
作物信息.Crop type
作物信息.轮作体系
作物信息.间作体系
施肥信息.总施肥量（kg N/ha）
施肥信息.化肥类型
施肥信息.化肥用量（kg N/ha）
施肥信息.有机肥用量（kg N/ha）
有机肥信息.大类
有机肥信息.详细类型
有机肥信息.C含量(g/kg)
有机肥信息.N含量(g/kg)
有机肥信息.C/N
有机肥信息.PH
有机肥信息.有机肥施用量（t/ha）
灌溉管理.灌溉方式
灌溉管理.灌溉量(m3/ha)
耕作管理.耕作方式
耕作管理.秸秆还田
耕作管理.秸秆还田方式
耕作管理.还田比例（%）
土壤调理剂.调理剂类型
土壤调理剂.施用量（t/ha）
覆盖作物.作物类型
备注
```
