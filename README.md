# 研序 · 研究工作台

本仓库合并了本地研序交接版与 GitHub `origin/main` 截至 2026-10-14 的改动。主界面仍按数据研究工作流组织：下载数据、数据清洗、计算、结果核查与定位、文献挖掘、人工审核、绘图；参数与活动数据更新是计算的可选分支。SOC 流水线位于 `SOC-database-pipeline-clean/`，目前是文献挖掘实例，尚未接入网页执行。

## 启动

安装 Node.js 18+ 后，在本目录运行 `npm start`，访问 `http://localhost:8123/`。Windows 可双击 `start-workbench.cmd`（端口 18125）。项目使用 Node 内置模块，无需 `npm install`。不要直接双击 `index.html` 使用 AI、文件上传和执行功能；服务只监听本机。

首次访问需要注册并登录：注册页的测试码定义在 `js/auth-config.js`。这是贡献版的**本地演示级账号门禁**，数据与登录状态仅存浏览器，不是服务器身份认证，也不应作为公网安全机制。

## 合并后的能力

- 左侧固定模块与独立研究任务；每个模块保留对话、确认规则和上传文件会话。
- 默认进入「AI 对话」；左侧「添加 API」支持 DeepSeek/OpenAI，也可连接本机 Codex CLI。设置按钮可补充系统提示词。
- 数据清洗、直接计算、修改计算与结果核查使用本机 Codex；生成环节文档、代码及受限执行是贡献版新增的能力，需要人工审核和确认。执行代码仍有本机风险，运行前必须检查生成内容。
- 工作记录可搜索；浏览器记录可导出/恢复 JSON 备份。备份**不含 API Key、登录状态或服务端 `.workbench/` 上传与输出文件**；迁移整项研究时须另存这些文件。
- 贡献版原有的浏览器多项目记录会在首次打开时一次性转为独立任务；原存储键仍保留。其“写作—投稿”旧流程只作为历史记录展示，不会替换当前固定数据模块。
- 原项目的 SOC 文献数据库流水线、流程图和交接文档均保留。下载、文献等模块仍主要提供文字引导，不能仅凭模块名判断已具备自动执行能力。

## 配置与检查

本机 Codex 需要安装并登录 CLI。API Key 可在页面配置，或把 `.env.example` 复制为 `.env` 后填写服务端配置。Python 等计算依赖尚未自动安装；`requirements.txt` 是统一依赖清单，可用左侧「编辑依赖」打开。未来的虚拟环境目录是 `.venv/`，`.env` 用于服务配置。

```bash
npm run check
node tools/check-contract.js
node tools/test-merge-store.js
node tools/test-server-exec.js
```

`tools/smoke-*.js` 会调用模型并消耗额度，需自行确认账号和运行环境后再执行。

更多说明见 `docs/user-guide.md`、`docs/workflow-drafts.md`、`docs/开发交接.md`。早期说明存于 `docs/README-历史版本.md`；其中的静态演示限制已过时。
