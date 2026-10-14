# 研序 · 研究工作台

本仓库合并了本地研序交接版与 GitHub `origin/main` 的工作流改动。主界面仍按数据研究工作流组织：下载数据、数据清洗、计算、结果核查与定位、文献挖掘、人工审核、绘图；参数与活动数据更新是计算的可选分支。SOC 流水线位于 `SOC-database-pipeline-clean/`，其 Google Scholar 候选发现步骤已接入网页；后续全文提取与数据库合并尚未接入。

## 启动

安装 Node.js 18+ 后，在本目录运行 `npm start`，访问 `http://localhost:8123/`。Windows 可双击 `start-workbench.cmd`（端口 18125）。项目使用 Node 内置模块，无需 `npm install`。不要直接双击 `index.html` 使用 AI、文件上传和执行功能；服务只监听本机。

首次访问需要注册并登录：注册页的测试码定义在 `js/auth-config.js`。这是贡献版的**本地演示级账号门禁**，数据与登录状态仅存浏览器，不是服务器身份认证，也不应作为公网安全机制。

## 合并后的能力

- 左侧固定模块与独立研究任务；每个模块保留对话、确认规则和上传文件会话。
- 默认进入「AI 对话」；左侧「添加 API」支持 DeepSeek/OpenAI，也可连接本机 Codex CLI。设置按钮可补充系统提示词。
- 数据清洗、直接计算、修改计算与结果核查使用本机 Codex；生成环节文档、代码及受限执行是贡献版新增的能力，需要人工审核和确认。执行代码仍有本机风险，运行前必须检查生成内容。
- 工作记录可搜索；浏览器记录可导出/恢复 JSON 备份。备份**不含 API Key、登录状态或服务端 `.workbench/` 上传与输出文件**；迁移整项研究时须另存这些文件。
- 贡献版原有的浏览器多项目记录会在首次打开时一次性转为独立任务；原存储键仍保留。其“写作—投稿”旧流程只作为历史记录展示，不会替换当前固定数据模块。
- 原项目的 SOC 文献数据库流水线、流程图和交接文档均保留。文献挖掘可从模块对话提取候选运行配置，核对后交由 SOC 的 Google Scholar 脚本按检索式与发表年份发现首批候选（最多 10 条，导出运行配置及 JSON/CSV）；其他来源、全文和参数提取仍未接通。下载数据等模块仍主要提供文字引导。

## 文献挖掘：使用流程与需求

目标是把**本次研究对话中确认的规则**变成可复现的运行配置，驱动检索、后续筛选和参数挖掘；不能把 AI 的建议、未批准草稿或检索片段当成已确认规则或全文证据。通用流程借鉴 SOC 的「发现文献 → 获取可读全文（必要时下载 PDF）→ 提取数据 → 校验 → 合并交付」，但 SOC 的中国田间试验、SOC 数值及固定 Excel 字段只是示例，不能套用于所有主题。

当前可用的操作顺序：

1. 启动本地服务并进入「文献挖掘」模块。用 AI 对话说明主题；来源、**论文发表年份**、地域、语言、研究类型、纳排规则、目标参数字段等已有决定可在同一轮说明。首批检索的最小输入是主题，其他未确认项保持不限；实验/观测年份不等同于论文发表年份。
2. 点击「从对话整理规则」。本机 Codex 从本模块对话和**已批准**的模块文档生成候选配置；仅讨论过、尚未确认的内容不能自动生效。Codex 不可用时可点「手动填写」。
3. 在「核对本次运行配置」中一次检查并修改主题、实际检索式、来源、发表年份、研究类型、纳排规则和目标字段。点击「确认配置并检索」才启动脚本；每次任务冻结一份 `run_config.json`，后续结果可追溯到所用规则。
4. 首次运行会创建项目 `.venv/` 并安装 Playwright/Chromium。若 Google Scholar 要求人机验证，在打开的浏览器完成后点「验证后重新检索」；不自动绕过验证码。完成后下载 `run_config.json`、`candidates.json` 和 `candidates.csv`。

当前执行边界和验收要求：

- 只接通 **Google Scholar**；如果配置包含知网、万方、Web of Science、Scopus 或 PubMed，启动会明确拒绝，绝不悄悄只查 Scholar。首批最多 10 条；Python 实际使用 `query`、`publicationYearFrom`、`publicationYearTo` 和 `limit`。地域与研究类型只有写入检索式才会影响这一阶段的搜索；语言、纳排规则和目标字段先随配置保存，供后续阶段使用。
- 候选清单保留标题、结果链接、全文链接（如有）、页面片段、来源、检索时间与待复核状态；按标题做本批去重。片段不是已核实的摘要或全文，候选不是已纳入文献。结果必须记录检索 URL 与实际应用的筛选条件；失败或验证码要给出真实状态。
- 本阶段**不**批量下载论文、自动完成纳排、读取全文、提取参数或生成最终 Excel。SOC 原项目有可选 PDF 下载、逐篇提取、校验和合并脚本/技能，但还没有通用的一键总控。下一阶段需求是接通已选来源、跨来源 DOI/标题去重、全文获取与可追溯参数提取，再按本次确认的字段定义校验并导出文献表和参数明细表；无合法全文时标为待补充，不绕过访问限制。

详细的字段、异常和交付规则见 `docs/literature-mining-alignment.md`；SOC 原始规则见 `SOC-database-pipeline-clean/AGENTS.md`，仅在选择 SOC 示例时适用。

## 配置与检查

本机 Codex 需已登录；macOS 上优先使用 ChatGPT 桌面应用内置的 Codex CLI，也可通过 `CODEX_BIN` 指定其他 CLI。API Key 可在页面配置，或把 `.env.example` 复制为 `.env` 后填写服务端配置。文献挖掘首次检索会自动创建 `.venv/`，安装 `requirements-literature.txt` 与 Chromium；需要 Python 3.10+，网络代理沿用 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。其他计算依赖尚未自动安装；`requirements.txt` 是统一依赖规划清单，可用左侧「编辑依赖」打开。`.env` 用于服务配置，不是虚拟环境。

```bash
npm run check
node tools/check-contract.js
node tools/test-merge-store.js
node tools/test-server-exec.js
node tools/test-literature-guidance.js
node tools/test-literature-connector.js
node tools/test-literature-http.js
python3 -m unittest tools/test_literature_search.py
# 首次文献检索安装 Chromium 后可选：.venv/bin/python tools/test_literature_ui.py
```

`tools/smoke-*.js` 会调用模型并消耗额度，需自行确认账号和运行环境后再执行。

更多说明见 `docs/user-guide.md`、`docs/workflow-drafts.md`、`docs/开发交接.md`。早期说明存于 `docs/README-历史版本.md`；其中的静态演示限制已过时。
