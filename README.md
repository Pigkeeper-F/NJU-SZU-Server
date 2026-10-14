# 研序 · 研究工作台

本目录是原 NJU-SZU 项目与 2026-10-12 研序交接版的合并工作区。交接功能、原有 SOC 流水线和流程图资料均保留；交接背景见 [开发交接说明](docs/开发交接.md)。

## 启动

1. 安装 Node.js 18 或以上版本（本机验证环境为 Node.js 24）。项目只使用 Node 内置模块，无 npm 依赖，无需 npm install。
2. macOS/Linux 在项目目录运行 `npm start`，访问 http://localhost:8123/；Windows 可双击 `start-workbench.cmd`，访问 http://localhost:18125/。
3. 保持终端窗口运行；停止时按 Ctrl+C。服务只监听运行电脑的 127.0.0.1，不是远程共享网站。

也可在项目目录的 PowerShell 运行：

```powershell
$env:PORT = '18125'
node server.js
```

`npm start` 默认端口为 8123；Windows 启动脚本固定使用 18125。请固定使用同一浏览器、同一地址，浏览器数据按地址隔离。不要双击 index.html 来使用 AI、上传和执行功能。

## AI 与计算环境

- 使用本机 Codex：需要安装 Codex CLI 并使用自己的账号登录，使 codex 命令可被服务器进程找到，然后在页面点击“检查连接”。项目不包含 CLI、账号、登录状态或 API Key。模型列表来自该账号，实际可用模型可能不同。
- 使用 API 对话：在左下角“添加 API”配置自己的 DeepSeek 或 OpenAI 密钥。也可复制 .env.example 为 .env 配置服务器。API 模式目前提供文字对话；文件处理与执行走本机 Codex。
- 运行 Python、R 等模型还需要相应运行时与模型依赖。项目根目录的 `requirements.txt` 是规划中的统一 Python 依赖清单，可在左下角“编辑依赖”中用系统文本编辑器打开；目前不会自动安装。将来虚拟环境使用 `.venv/`，`.env` 留给服务配置。可设置 WORKBENCH_PYTHON 指向 Python 可执行文件；Codex 可执行文件可由 CODEX_BIN 指定。
- 本机 Codex 使用 app-server 协议，需在当前电脑验证 CLI 兼容性。

## 当前流程

新建独立任务 → 数据清洗（讨论并确认规则后执行）→ 直接计算或修改计算 → 结果核查与定位 → 发现问题后返回计算讨论、修正、重跑、复验。

直接计算上传现有代码和数据；修改计算先确认修改规则。核查模块支持“讨论核查原则”和“上传核查标准”，原则在大弹窗内编辑、确认并保留版本。下载数据、文献等模块目前主要提供流程讨论，不能据模块名称理解为全部自动执行能力已完成。

## 项目内容

- server.js、js/、css/、index.html：当前完整平台源码。
- tools/：Codex 桥接与契约检查、计算和核查试跑脚本。
- docs/：流程设计、各模块说明、开发交接与历史文档。
- examples/1992-cleaning-trial/：80 行真实来源练习小样、规则说明、来源说明与取样脚本；非完整年度数据库。
- examples/cleaning-demo-input.csv：清洗演示数据。
- examples/历史试跑文件/：原本地工作目录中的小样输入、输出、代码和报告快照，供回看。不是浏览器任务备份，也不会自动显示在新任务中。
- audit-principles-preview.png：界面预览。
- SOC-database-pipeline-clean/：原项目保留的 SOC 文献数据库流水线实例，尚未接入网页命令执行。
- docs/flowchart/：原项目流程图与历史版本。

## 自检

```powershell
npm run check
node tools/check-contract.js
```

tools/smoke-calculation.js、smoke-modify-calculation.js、smoke-audit.js 是需要已登录 Codex 和相应运行环境的集成试跑，会调用模型、创建测试会话。脚本中模型名是历史环境的值，接手者须改为自己账号的可用模型。修改与核查试跑需传入直接计算返回的 session ID。不要把历史验证结果视为新电脑上的验证。

## 数据与边界

任务列表、对话、确认规则保存在浏览器 localStorage；上传和输出保存在服务端 .workbench/。复制源码不会自动迁移浏览器对话、API Key 或账号登录状态；正式完整研究数据也不在示例中。新电脑启动时可新建任务并上传 examples 中的材料练习。

早期 README 保留为 docs/README-历史版本.md，其中“纯静态”“无模型服务”等已过时。其它早期设计稿也可能描述规划而非已实现能力；以当前源码及 docs/开发交接.md 为准。
