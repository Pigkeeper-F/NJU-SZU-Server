# 研序 · 研究工作台

本仓库合并了本地研序交接版与 GitHub `origin/main` 的工作流改动。主界面仍按数据研究工作流组织：下载数据、数据清洗、计算、结果核查与定位、文献挖掘、人工审核、绘图；参数与活动数据更新是计算的可选分支。SOC 流水线位于 `SOC-database-pipeline-clean/`，其 Google Scholar 候选发现步骤已接入网页；后续全文提取与数据库合并尚未接入。

## 启动

安装 Node.js 18+ 后，在本目录运行 `npm start`，访问 `http://localhost:8123/`。Windows 可双击 `start-workbench.cmd`（端口 18125）。项目使用 Node 内置模块，无需 `npm install`。不要直接双击 `index.html` 使用 AI、文件上传和执行功能；服务只监听本机。

首次访问需要注册并登录：注册页的测试码定义在 `js/auth-config.js`。这是贡献版的**本地演示级账号门禁**，数据与登录状态仅存浏览器，不是服务器身份认证，也不应作为公网安全机制。

## 合并后的能力

- 左侧固定模块与独立研究任务；每个模块保留对话、确认规则和上传文件会话。
- 默认进入「AI 对话」；左侧「添加 API」支持 DeepSeek/OpenAI，也可连接本机 Codex CLI。设置按钮支持**多组模型配置**（一个接口地址 + 一个 Key 为一组，组内维护模型列表，模型名左侧 ▼ 可展开切换、保存时当前模型自动入列；旧版单套配置首次读取自动迁移）与**测试连通**（用表单当前值实调一次本机代理，直接验证地址/Key/模型是否可用），并可补充系统提示词。
- 数据清洗、直接计算、修改计算与结果核查使用本机 Codex；生成环节文档、代码及受限执行是贡献版新增的能力，需要人工审核和确认。执行代码仍有本机风险，运行前必须检查生成内容。
- 工作记录可搜索；浏览器记录可导出/恢复 JSON 备份。备份**不含 API Key、登录状态或服务端 `.workbench/` 上传与输出文件**；迁移整项研究时须另存这些文件。
- 贡献版原有的浏览器多项目记录会在首次打开时一次性转为独立任务；原存储键仍保留。其“写作—投稿”旧流程只作为历史记录展示，不会替换当前固定数据模块。
- 原项目的 SOC 文献数据库流水线、流程图和交接文档均保留。文献挖掘已升级为六阶段流水线：从模块对话提取候选运行配置，核对后执行首批 Google Scholar 候选检索（最多 10 条），并可逐阶段续跑跨来源去重、全文获取、参数提取（提取前需研究者确认字段含义与单位）、校验与文献表/参数明细表导出（CSV+Excel）；其他检索来源仍会明确拒绝而不能静默忽略。下载数据等模块仍主要提供文字引导。

## 文献挖掘：使用流程与需求

目标是把**本次研究对话中确认的规则**变成可复现的运行配置，驱动检索、后续筛选和参数挖掘；不能把 AI 的建议、未批准草稿或检索片段当成已确认规则或全文证据。通用流程借鉴 SOC 的「发现文献 → 获取可读全文（必要时下载 PDF）→ 提取数据 → 校验 → 合并交付」，但 SOC 的中国田间试验、SOC 数值及固定 Excel 字段只是示例，不能套用于所有主题。

当前可用的操作顺序：

1. 启动本地服务并进入「文献挖掘」模块。用 AI 对话说明主题；来源、**论文发表年份**、地域、语言、研究类型、纳排规则、目标参数字段等已有决定可在同一轮说明。首批检索的最小输入是主题，其他未确认项保持不限；实验/观测年份不等同于论文发表年份。
2. 点击「从对话整理规则」。本机 Codex 从本模块对话和**已批准**的模块文档生成候选配置；仅讨论过、尚未确认的内容不能自动生效。Codex 不可用时可点「手动填写」。
3. 在「核对本次运行配置」中一次检查并修改主题、实际检索式、来源、发表年份、研究类型、纳排规则和目标字段。点击「确认配置并检索」才启动脚本；每次任务冻结一份 `run_config.json`，后续结果可追溯到所用规则。默认只跑首批候选检索，任务完成后页面提供「继续下一阶段」按需推进。
4. 续跑时按阶段执行：**跨来源去重**（DOI 精确/标题归一化自动合并明确重复，疑似重复保留待复核）→ **全文获取**（HTML 正文优先、PDF 备选；遇到人机验证必须先人工完成再按页面提示继续，不自动绕过；付费墙或无法合法获取的标为“待补充”，不绕过访问控制）→ **参数提取**（先由研究者确认主题参数字段的含义与单位，这是硬关口；确认后由本机 Codex 按已确认字段逐篇提取，每个值都带出处）→ **校验**（阻断行不进主表并列入错误报告；缺 DOI、单位不明、疑似重复等进待审清单）→ **导出**（文献表与参数明细表各出 CSV+Excel；同一任务重导出先归档旧版本，不覆盖）。
5. 首次运行会创建项目 `.venv/` 并安装 Playwright/Chromium 与 `openpyxl`、`pypdf`；依赖清单变化会自动重装。若 Google Scholar 要求人机验证，在打开的浏览器完成后点「验证后重新检索」；不自动绕过验证码。任务文件与全量事件流水保存在 `.workbench/literature/<任务 ID>/`（含 `events.jsonl`），页面下载区只提供已登记的交付物。

当前执行边界和验收要求：

- 只接通 **Google Scholar**；如果配置包含知网、万方、Web of Science、Scopus 或 PubMed，启动会明确拒绝，绝不悄悄只查 Scholar。首批最多 10 条；Python 实际使用 `query`、`publicationYearFrom`、`publicationYearTo` 和 `limit`。地域与研究类型只有写入检索式才会影响检索阶段的搜索；语言、纳排规则和目标字段随配置保存，供后续阶段使用。
- 候选清单保留标题、结果链接、全文链接（如有）、页面片段、来源、检索时间与待复核状态；批内按标题去重，跨批/跨来源重复由去重阶段归并。片段不是已核实的摘要或全文，候选不是已纳入文献。结果必须记录检索 URL 与实际应用的筛选条件；失败或验证码要给出真实状态。
- 自动化只做“明确重复/无法获取”的判断：去重仅自动排除明确重复；全文获取不重试无法合法获取项；不自动判“不相关”。参数字段以研究者确认记录为准（`confirmations.json`），不把 AI 建议当已确认规则。提取行必须带出处，阻断/待审核行按规则分流，被排除文献仍保留筛选记录。
- 本阶段仍**不**做：其他检索来源接入、用户上传清单/PDF 的自动导入、图表像素读数（人工转录可补录）、代理自动发现。无合法全文的文献标为待补充。

详细的字段、异常和交付规则见 `docs/literature-mining-alignment.md`；SOC 原始规则见 `SOC-database-pipeline-clean/AGENTS.md`，仅在选择 SOC 示例时适用。

## 配置与检查

本机 Codex 需已登录；macOS 上优先使用 ChatGPT 桌面应用内置的 Codex CLI，也可通过 `CODEX_BIN` 指定其他 CLI。API Key 可在页面配置，或把 `.env.example` 复制为 `.env` 后填写服务端配置。文献挖掘首次检索会自动创建 `.venv/`，安装 `requirements-literature.txt`（Playwright、openpyxl、pypdf）与 Chromium；依赖清单内容变化时按 `.literature-ready` 校验值自动重装。需要 Python 3.10+，网络代理沿用 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。其他计算依赖尚未自动安装；`requirements.txt` 是统一依赖规划清单，可用左侧「编辑依赖」打开。`.env` 用于服务配置，不是虚拟环境。

```bash
npm run check
node tools/check-contract.js
node tools/test-merge-store.js
node tools/test-server-exec.js
node tools/test-literature-guidance.js
node tools/test-literature-sources.js
node tools/test-literature-connector.js
node tools/test-literature-http.js
node tools/test-literature-http-stage2.js
node tools/test-literature-extract.js
node tools/test-literature-ui-stage2.js
node tools/test-llm-settings.js
python3 -m unittest tools/test_literature_search.py
python3 -m unittest tools/test_literature_pipeline.py
python3 -m unittest tools/test_literature_dedupe.py tools/test_literature_fulltext.py tools/test_literature_extract.py tools/test_literature_validate.py tools/test_literature_export.py
# 首次文献检索安装 Chromium 后可选：.venv/bin/python tools/test_literature_ui.py
```

`tools/smoke-*.js` 会调用模型并消耗额度，需自行确认账号和运行环境后再执行。

## 调试

出问题时不用猜、不用截图来回传——服务端的请求记录、异常与前端错误都收在内存缓冲里，
用一条命令拿到人读的中文诊断摘要：

```bash
node tools/debug-report.js              # 服务状态、模型、失败请求、慢请求、错误明细
node tools/debug-report.js --port 8124 # 指定端口
node tools/debug-report.js --json       # 原始 JSON
```

也可以开 <http://localhost:8123/debug.html> 用眼睛看（侧栏入口默认隐藏，地址栏加 `?debug=1` 才出现）。
日志只在内存、进程重启即清、不含请求体、API Key 一律脱敏。用途与排查手册见 `docs/debug-tool.md`。

更多说明见 `docs/user-guide.md`、`docs/debug-tool.md`、`docs/workflow-drafts.md`、`docs/开发交接.md`。早期说明存于 `docs/README-历史版本.md`；其中的静态演示限制已过时。
