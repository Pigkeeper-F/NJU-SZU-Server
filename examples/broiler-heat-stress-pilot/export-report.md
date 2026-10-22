> Repository snapshot: original source quotations and local material files are omitted. Automatic checks are not manual scientific validation.

# 导出报告（文献表 + 参数明细表）

- 生成时间：2026-10-21T00:24:36.805990+00:00
- 字段定义来源：confirmations.json#fieldDefinitions@2026-10-21T00:14:10.562Z
- 字段定义指纹 schema_sha256：f5635fca92bd629c
- 两表依据同一份已确认字段定义生成；被排除文献保留筛选记录，阻断行只在下方错误报告列出。

## 计数摘要

- 文献表行数：10
- 参数明细表行数：259
- 参数行校验：共 259，通过 251，阻断 0，待审核 8
- 文献行阻断：0，文献行待审核：0
- 文献全文状态：abstract_only 1，fetched_html 3，unavailable 6
- 参数明细表待审核行：8

## 列填充率

- 文献表：低于 10% 填充的列 screening_reason 0%
- 参数明细表：低于 10% 填充的列 conversion 0%、provenance 0%、validation_notes 3%

## 错误报告：阻断行（未写入主表）

（无阻断行）

## 待审核行（已写入主表，另见 validation.md）

| 类型 | 记录 | 论文 | 规则 | 问题 |
|---|---|---|---|---|
| parameter | PMID-007-R144 | PMID-007 | missing_unit | 字段 variation_value 为数值字段但未给出单位（unit_raw 为空） |
| parameter | PMID-007-R145 | PMID-007 | missing_unit | 字段 variation_value 为数值字段但未给出单位（unit_raw 为空） |
| parameter | PMID-007-R146 | PMID-007 | missing_unit | 字段 variation_value 为数值字段但未给出单位（unit_raw 为空） |
| parameter | PMID-007-R147 | PMID-007 | missing_unit | 字段 variation_value 为数值字段但未给出单位（unit_raw 为空） |
| parameter | PMID-007-R148 | PMID-007 | missing_unit | 字段 variation_value 为数值字段但未给出单位（unit_raw 为空） |
| parameter | PMID-007-R149 | PMID-007 | missing_unit | 字段 variation_value 为数值字段但未给出单位（unit_raw 为空） |
| parameter | PMID-007-R150 | PMID-007 | missing_unit | 字段 variation_value 为数值字段但未给出单位（unit_raw 为空） |
| parameter | PMID-007-R151 | PMID-007 | missing_unit | 字段 variation_value 为数值字段但未给出单位（unit_raw 为空） |

## 待补充 / 降级清单

- PMID-001：全文待补充：页面导航失败（https://pubmed.ncbi.nlm.nih.gov/33142538/）：fetch_error；页面不可用（https://pmc.ncbi.nlm.nih.gov/articles/PMC7647856/）：尚无可验证的文章正文区域；整页长度不能证明取得全文。（全文待补充）；页面不可用（https://doi.org/10.1016/j.psj.2020.08.019）：尚无可验证的文章正文区域；整页长度不能证明取得全文。（全文待补充）
- PMID-003：全文待补充：页面不可用（https://pubmed.ncbi.nlm.nih.gov/20709975/）：仅有题录、导航或空页面，尚未取得可确认的摘要或正文。（全文待补充）；页面不可用（https://doi.org/10.3382/ps.2010-00812）：尚无可验证的文章正文区域；整页长度不能证明取得全文。（全文待补充）
- PMID-004：全文待补充：页面不可用（https://pubmed.ncbi.nlm.nih.gov/11297279/）：仅有题录、导航或空页面，尚未取得可确认的摘要或正文。（全文待补充）；页面不可用（https://doi.org/10.1093/ps/80.4.418）：尚无可验证的文章正文区域；整页长度不能证明取得全文。（全文待补充）
- PMID-008：全文待补充：补充材料超过1分钟未就绪，原窗口已保留；处理后继续，不会重复点击。（本轮已跳过，待补充）
- PMID-009：全文待补充：全文页面需要机构或订阅权限，已暂停；请在原页面核对权限后继续。（本轮已跳过，待补充）
- PMID-010：全文待补充：该站点本批次仍待登录、验证或权限处理，已跳过当前材料；原页面保留，未重复访问。（本轮已跳过，待补充）
