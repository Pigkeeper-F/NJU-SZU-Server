# 五库文献流程：实现状态与边界

更新：2026-11-03  
集成分支：`integration/literature-five-source`  
合并提交：`19721b4`（学长五库分支） + `5446f69`、`0d9dbe4`（本轮修复）

> 这份文件是给后续 agent 和研究者看的“事实状态”。不要把它当成“全自动投稿流水线已完成”的宣传页。
> 这里明确区分：**已实现并验证**、**已实现但未真实站点验证**、**未实现/受权限限制**。

## 1. 五库与检索

已接入的五库配置（`config/confirmed-climate-research.json`，按生产/排放两条线共 10 组）：

| 数据库 | 来源 key | 接入方式 |
|---|---|---|
| 中国知网 | `cnki` | 持久浏览器，人工登录/机构权限 |
| 万方 | `wanfang` | 持久浏览器，人工登录/机构权限 |
| Web of Science | `web-of-science` | 持久浏览器，机构订阅 |
| Scopus | `scopus` | 持久浏览器，机构订阅 |
| Google Scholar | `google-scholar` | 持久浏览器，可能人机验证 |

> **五库不含 PMC/PubMed。** PMC、Europe PMC、OpenAlex、PubMed 是其他流程使用的开放检索/全文源；
> 在本五库任务里，PMC/Europe PMC 只作为**全文与补充材料解析器**出现，不参与五库检索，也不是“第六个库”。
> 代码层已由 `tools/literature-confirmed-plan.js` 的 `FIVE_SOURCE_KEYS` 白名单强制：五库方案
> 出现 `pmc` 等非五库来源会直接报错，不会准备任务。

- 检索式按来源分别保存，不再把一条 Scholar 语法复制给所有库。
- 开跑前有逐项核查（研究范围、来源与检索式、纳排与交付、执行边界）；确认快照写入任务目录。
- 任务、讨论、确认记录、候选与材料按任务隔离；新建/切换不会自动重跑。

## 2. 篇关摘三态筛选

代码入口：`tools/literature-screening.js`、`tools/literature-screening-pipeline.js`、`tools/literature_screening.py`、`tools/literature_metadata.py`。

| 判定 | 含义 | 全文队列 |
|---|---|---|
| `include` | 已明确满足全部必要条件 | 下载 PDF/全文 |
| `pending` | 没有明确排除证据，但关键资格待全文确认 | **也下载**，默认不提取 |
| `exclude` | 规则明确不符合且无其他合格部分 | 不下载，保留排除理由 |

硬规则：

- 未取得完整摘要 → 自动转 `pending`，不能用检索片段当摘要排除。
- 模型不可用 → 停在 `screening_unavailable`，不会自动排除任何文献。
- 全文阶段开始前会校验筛选记录与规则版本；未筛选/过期时暂停，不会把全部候选直接下载。
- 排除项保留在状态与审计文件里，不静默删除。

**结论：三态筛选 + “确定不是就不下载”的闸门已实现。**

## 3. 全文与补充材料

代码入口：`tools/literature_fulltext.py`、`tools/literature_fulltext_browser.py`、`tools/literature_cnki_fulltext.py`、`tools/literature_materials.py`。

已实现：

- 正文优先级：平台原生 PDF（知网/出版社）→ Europe PMC/PMC PDF → PMC JATS 全文 → 文章页 HTML → DOI 落地页。
  （这里的 PMC/Europe PMC 只是在解析全文，不是五库检索来源。）
- 正文完整性：PDF 校验 `%PDF`/EOF/大小/传输；HTML/JATS 校验核心章节，`partial` 不进入提取。
- 补充材料：按已验证文章页枚举附件，保留原格式；区分 `downloaded / missing / needs_attention / uninspected / none_declared`。
- 断点续跑、单篇重试、访问受限逐篇暂缓、已保存文件按 SHA 复用。
- **CDP 原生下载兜底**：研究者浏览器通过 CDP 附着时，Chrome 可能直接保存文件而不发 Playwright `Download` 事件；任务页设置 page-scoped 下载目录，只接受完成且通过 PDF 校验的文件。
- **PMC 补充材料**：PMC 附件页可能返回 JavaScript proof-of-work 挑战；改用 Europe PMC 稳定 OA 包
  `https://www.ebi.ac.uk/europepmc/webservices/rest/{PMCID}/supplementaryFiles`，按 JATS 文件名取 ZIP 成员，不实现/绕过验证挑战。
- **附件链接跨进程持久化**：稳定、无 token/签名的链接写入 `fulltext/material-links.json`；`materials.json` 本身不写临时链接。
- 直接/包下载没有打开子窗口时，不再把“无需清理”误报成“清理失败”。

## 4. 真实冒烟证据（2026-11-02）

开放获取 PMC 样本 3 篇（`PMC13714334`、`PMC13722600`、`PMC13718310`）：

- 正文完整 3/3：PDF 2 篇 + JATS/HTML 1 篇。
- 补充材料 `AAS-71-0-s001.docx` 成功下载，892,828 字节；该篇 `materials_completeness = complete`。
- 另两篇补充材料仍为 `unverified`（页面验证/补材入口未闭合），未虚报齐全。
- 任务目录：`.workbench/literature/d615944d-ffe3-4d1a-bd91-585f12042d57/`（本机运行产物，不随 Git 提交）。

回归：

- `python tools/test_literature_materials.py`：28 项
- `python tools/test_literature_materials_browser.py`：32 项
- `python tools/test_literature_fulltext.py`：71 项
- `python tools/test_literature_cnki_fulltext.py`：83 项
- `python tools/test_literature_fulltext_browser.py`：27 项
- `python tools/test_literature_cdp_download.py`：8 项
- `node tools/check-contract.js`：`ALL_CHECKS_PASS`

## 5. 尚未完成 / 不要宣称完成

1. **知网真实自动 PDF 未闭环**
   - 研究者样本遇到“下载需要会员/订阅”，已按 `access_required` 跳过。
   - 代码路径已有 CDP 下载兜底与知网单篇续跑，但没有一篇**有权限的知网样本**真实跑通自动落盘。
   - 不能声称“知网全文已全部自动获取”。

2. **万方/WoS/Scopus 的出版社全文未验证**
   - 三者大量只是索引，全文要靠 DOI 到出版社/PMC；目前只验证了 OA/PMC，Elsevier/Springer/Wiley 等订阅出版社没有真实样本。
   - 订阅墙/验证码/下载配额不绕过。

3. **非 PMC 补充材料未验证**
   - 通用页面扫描已实现；Elsevier/Springer/Wiley/Frontiers/MDPI 等真实补充材料入口未逐一实测。
   - “没找到”不等于“作者声明没有”；状态必须保留 `unverified/needs_attention`。

4. **五库正式生产批次未完整跑完**
   - 已有一条历史任务越过知网第一篇停点，但 3814 条级任务没有全部跑完，PDF 覆盖未声明完整。

## 6. 继续验证的最小步骤

1. 用研究者已登录的持久浏览器启动一个“小样测试”任务。
2. 准备 3–5 篇有权限的知网样本：正常 PDF、仅 CAJ、下载报错、带附件、需登录各一类。
3. 执行：检索/导入 → 去重 → 篇关摘筛选 → 全文获取。
4. 检查 `fulltext/status.json`、`materials.json`、`download-diagnostics.jsonl` 和实际文件。
5. 只有实际文件落盘并通过校验，才把对应能力标为“已验证”。

## 7. 给后续 agent 的硬约束

- 不把“页面显示 Full access”当作“文件已下载”；以 `fulltext/files/` 与 `fulltext/materials/` 的实际文件为准。
- 不把人工下载、隔离测试或旧任务缓存算作自动下载成功。
- 不绕过登录、订阅、验证码、下载配额；遇到就记录 `access_required/login/verification` 并保留页面。
- 不把“未找到补充材料”写成“作者声明没有”；只有明确声明才 `none_declared`。
- 修改前端时保持现有工作台风格与既有 class/DOM 结构，不借机重做界面。
