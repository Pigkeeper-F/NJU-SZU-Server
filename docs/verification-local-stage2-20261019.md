# 本地六阶段整合核查（2026-10-19）

## 整合内容

- 本地基线：`9cf2261`。
- 上游分支：`origin/literature-mining-stage2`，`9ca672c`。
- 在原本地分支合并第二阶段，保留本机 Codex 设置登录、已审核方案流程、材料补传、公开文件下载和清洗交接。
- `/api/literature/*` 使用带提取适配器的共享 Scholar 连接器；`/api/codex/literature/*` 继续由原 LiteratureFlow 处理。
- 文献模块将原辅助候选卡升级为默认展开的“文献检索与提取（六阶段）”。
- 新模型分组沿用旧存储键；旧文献流程解析当前活动分组后再提交模型配置。
- Python 子进程保留系统代理和取消检查，同时显式启用 UTF-8。
- Windows 启动脚本补充已安装 npm x64 原生 Codex 路径发现，优先尊重自定义 CODEX_BIN。

## 已完成验证

- `tools/check-contract.js`：`ALL_CHECKS_PASS`。
- 合并涉及的核心 JavaScript 语法检查通过。
- 旧任务迁移、来源注册、文献引导、阶段 UI 静态检查、模型分组、逐篇提取和连接器测试通过。
- `tools/test-scholar-flow.js`：验证等待、续跑、全文与出处检查通过。
- `tools/test-literature-flow.js`：旧审核方案流程、补传、重启续跑、版本和交接测试通过。
- `tools/test-literature-http-stage2.js`：17项通过；使用模拟检索和全文、真实提取适配器和阶段脚本，检查字段确认、提取、校验、CSV/Excel 导出及下载。
- `tools/test-literature-http.js` 通过。
- `tools/test-server-exec.js`：76项通过、0失败；无真实 Key 的可选上游项跳过。
- `tools/test-source-download.js` 通过。
- 项目 `.venv` 中执行文献 Python 测试：150项通过。
- `tools/test_literature_ui.py` 在隔离浏览器上下文中通过：从对话整理配置、启动按钮、字段确认表、单位与 advance 请求；模型和检索响应为测试桩，不写用户浏览器记录。
- 项目专用 Python 依赖和 Chromium 已准备，`.literature-ready` v2 记录已生成。
- `http://localhost:18125/` 返回200，提供新版 UI；历史任务 API 返回正确结构。
- 本机 Codex 状态连接成功，并返回5个可用模型；未在验收中执行真实模型提取。

## 数据保留与验证边界

更新前已将代码、上传和执行文件备份到项目工作区外层的 `更新备份/20261019-stage2-111529/`，记录基线提交。合并不清除浏览器存储，也不替换已有任务目录。

本次验证不等于正式科研批次已完成：未执行真实 Google Scholar 联网检索、登录机构来源或真实模型提取。已有 Meta 分析文件仍位于工作区的 `paper-search-results/`，没有自动导入或重算。

## 同日模型目录修复

- 原 npm CLI 0.142.5 的目录仅有5个可见模型，以 gpt-5.5 为默认。
- 已安装的桌面 CLI 0.163.0-alpha.10.2 返回8个可见模型，包含 gpt-6.1-sol、gpt-6-astra、gpt-6-sol、gpt-6-luna、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna 和 gpt-5.5。
- 默认发现桌面运行时，保留显式 CODEX_BIN 和无桌面环境的回落。读取完整分页，不把显示名称替代实际调用标识。
- 新版 account/read 曾出现工作区路由发现超时；官方 CLI login status 确认为已登录，直接推理 gpt-6.1-sol 实际完成并返回 OK。新增仅针对该错误的本机登录状态回退，远端推理鉴权仍由 Codex 执行。
- 更新后18125服务的 status 实际返回 loggedIn=true、8模型、默认 gpt-6.1-sol、无 error。
- 真实浏览器设置页已显示“本机 Codex 已登录 · 8 个模型”，下拉选项逐项核对通过。
- 六阶段新任务将当前模型写入冻结提取配置，旧任务保持原配置。
- `test-codex-models.js`、阶段 UI 检查、语法检查、契约检查通过；未声称逐个完成全部8个模型的实际推理测试。
