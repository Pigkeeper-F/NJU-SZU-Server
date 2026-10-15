# 研序 · 研究工作台

本仓库合并了本地研序交接版与 GitHub `origin/main` 的工作流改动。主界面仍按数据研究工作流组织：下载数据、数据清洗、计算、结果核查与定位、文献挖掘、人工审核、绘图；参数与活动数据更新是计算的可选分支。SOC 流水线位于 `SOC-database-pipeline-clean/`，复用其 Google Scholar 候选发现能力；网页通用文献流程另支持开放全文获取、带出处提取与清洗交接，尚未接入 SOC 专用数据库的自动合并。

## 启动

安装 Node.js 18+ 后，在本目录运行 `npm start`，访问 `http://localhost:8123/`。Windows 可双击 `start-workbench.cmd`（端口 18125）。项目使用 Node 内置模块，无需 `npm install`。不要直接双击 `index.html` 使用 AI、文件上传和执行功能；服务只监听本机。

首次访问需要注册并登录：注册页的测试码定义在 `js/auth-config.js`。这是贡献版的**本地演示级账号门禁**，数据与登录状态仅存浏览器，不是服务器身份认证，也不应作为公网安全机制。

## 合并后的能力

- 左侧固定模块与独立研究任务；每个模块保留对话、确认规则和上传文件会话。
- 默认进入「AI 对话」；左侧「添加 API」支持 DeepSeek/OpenAI，也可连接本机 Codex CLI。设置按钮可补充系统提示词。
- 数据清洗、直接计算、修改计算与结果核查使用本机 Codex；生成环节文档、代码及受限执行是贡献版新增的能力，需要人工审核和确认。执行代码仍有本机风险，运行前必须检查生成内容。
- 工作记录可搜索；浏览器记录可导出/恢复 JSON 备份。备份**不含 API Key、登录状态或服务端 `.workbench/` 上传与输出文件**；迁移整项研究时须另存这些文件。
- 贡献版原有的浏览器多项目记录会在首次打开时一次性转为独立任务；原存储键仍保留。其“写作—投稿”旧流程只作为历史记录展示，不会替换当前固定数据模块。
- 数据下载支持按确认规则获取公开文件，保存原始文件与下载记录，人工确认后自动交给清洗模块；需要登录、网页检索或复杂筛选的来源仍需明确获取方式。
- 原项目的 SOC 文献数据库流水线、流程图和交接文档均保留；通用文献获取不自动套用 SOC 的科学规则或固定表结构。

## 下载到清洗

### 文献数据获取：审核方案后执行

在下载或文献挖掘模块的方案卡片讨论、编写并审核获取方案，然后点击「按审核方案开始执行」。首批检索最多 20 条候选、处理最多 3 篇；支持 Europe PMC、Crossref 与 Google Scholar，获取开放全文 XML/PDF 或读取研究者上传的全文与补充表格。模型负责方案解析、筛选及带出处提取，服务器负责检索、获取、解析、证据校验和进度保存；不会执行材料中的指令。方案明确指定 Google Scholar 时使用该来源；既有未指定来源的方案仍默认 Europe PMC/Crossref，不暗中替换来源。发表年份筛选与实验年份分开处理。

遇到规则不明确、缺少全文、单位或数值证据问题时，执行面板显示「需要与你讨论」。可以在对话中讨论，确定后在面板提交答复并继续；获取阶段可上传材料并关联论文，或明确跳过某篇。刷新可恢复状态，服务重启可续跑当前步骤；停止保留已有成果。方案内容改变后须重新审核并开始新批次。

成果包括 literature-list.csv、search-records.json、screening-records.json、原始材料、material-manifest.json、extracted-data.csv、extraction-records.json 和 review-report.md。提取 CSV 保存原值、单位、条件、论文、材料文件、页码/表格位置及逐字证据；缺失留空，数值无证据则不交付为有效值。每次重新提取保留版本文件；最新文件用于核查和交接。核查通过后点击「将提取表交给清洗」，只复制数据表，不把 PDF/XML 混入清洗输入。

首期不自动登录文献来源、不绕过访问控制、不做 OCR 或图像数值估读，不宣称全量检索。PDF/Excel 读取使用已有 Python 与 pypdf/pdfplumber/PyMuPDF/openpyxl；缺少依赖时显示问题，配置 `WORKBENCH_PYTHON` 可指定现有解释器。模型限流时保留等待状态，可稍后继续或在设置选择可用模型。

接口依据：[Europe PMC REST](https://europepmc.org/RestfulWebService)、[Crossref REST](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)。

### 只找候选文献：Google Scholar

文献挖掘模块展开「只找候选文献：Google Scholar」，可从已确认的对话整理运行配置，也可手动填写；核对检索式、发表年份、来源与首批条数后点击「确认配置并检索」。这里只生成最多 10 条候选及 JSON/CSV、冻结配置，不自动执行最终纳排或全文提取。其他纳排规则与目标字段随配置保存，明确列为后续处理项。知网、万方、Web of Science、Scopus、PubMed 等尚未接通的来源会明确报错。

完整流程也复用这个 Scholar 连接器，把候选继续送入筛选、获取材料与数据提取。搜索片段只用于筛选，不能作为数值证据。Scholar 遇到验证码时暂停，请在检索浏览器中手动完成验证后点击继续；不会自动解验证码。配置不变时读取已验证结果页，已完成查询复用冻结结果。

Scholar 首次运行需要 Python 3.10+，自动准备项目 `.venv/`、`requirements-literature.txt` 依赖和 Chromium，可能需要几分钟；安装或网络失败会明确显示。使用已有代理环境变量，Windows 也支持已启用的系统 HTTP 代理。该最小环境用于检索，不等于自动安装全部计算或 PDF/Excel 解析依赖。

### 已有文件链接：直接下载

1. 在下载模块与 AI 讨论来源、年份、范围和验收要求，在「查看/编辑下载规则」中核对并确认；也可审核模块的下载方案。
2. 点击「按规则开始下载」，在弹窗中填写实际文件地址。每行一个 `地址 | 文件名`，最多 5 个公开 HTTP(S) 文件，每个不超过 20MB；支持 CSV、TSV、Excel、JSON、TXT、ZIP、PDF。
3. 点击「开始下载」。在「文件与结果」查看原始文件及下载记录；失败时修正地址后重新下载，旧文件保留。下载本身不需要模型登录。
4. 核对文件符合来源、年份、范围及版本要求后，点击「确认文件并进入清洗」。平台复制这些原始文件到清洗模块，不必重新上传；随后讨论并确认清洗规则，再执行清洗。

只确认规则不会完成下载；网页地址也不等于实际文件地址。ZIP/PDF 可以保存原始来源，后续解析能力需在清洗模块另行确认。

## 配置与检查

本机 Codex 需要安装 CLI；在左下角“设置 → 模型”选择本机 Codex 并点击登录按钮，完成官方浏览器登录即可。已有本机登录时直接复用。macOS 也可复用桌面应用内置 CLI；`CODEX_BIN` 可指定路径。模型与后端按当前模块保存；生成环节文档、代码和 AI 定位也使用所选后端。无需填写 API Key。API 对话仍可在页面配置密钥，或使用 `.env`。除 Scholar 最小检索环境外，Python 等计算依赖尚未自动安装；`requirements.txt` 是统一依赖清单，可用左侧「编辑依赖」打开。虚拟环境目录为 `.venv/`，`.env` 用于服务配置。

```bash
npm run check
node tools/check-contract.js
node tools/test-merge-store.js
node tools/test-source-download.js
node tools/test-literature-flow.js
node tools/test-scholar-flow.js
node tools/test-server-exec.js
node tools/test-literature-guidance.js
node tools/test-literature-connector.js
node tools/test-literature-http.js
python3 -m unittest tools/test_literature_search.py
# 首次文献检索安装 Chromium 后可选：.venv/bin/python tools/test_literature_ui.py
```

`tools/smoke-*.js` 会调用模型并消耗额度，需自行确认账号和运行环境后再执行。

更多说明见 `docs/user-guide.md`、`docs/workflow-drafts.md`、`docs/开发交接.md`。早期说明存于 `docs/README-历史版本.md`；其中的静态演示限制已过时。
