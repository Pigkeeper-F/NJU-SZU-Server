# 本机 Codex 接入说明

当前首期覆盖数据清洗模块。浏览器通过同源 `/api/codex/*` 接口访问 Node 本地服务；服务用 stdio JSON-RPC 启动 `codex app-server`，复用 CLI 登录，不读取或转发登录令牌到浏览器。

## 运行与接口

- 安装 Codex CLI 后执行 `codex login`，再运行 `npm start`；使用 `model/list` 返回的账号可用默认模型和默认推理配置，避免继承不适用的本机模型设置。
- 可用 `CODEX_BIN` 指定 CLI 路径。服务仅监听 `127.0.0.1` 并检查 Host、Origin；Codex 写接口要求工作台请求头。
- 可用 `WORKBENCH_PYTHON` 指定已安装依赖的 Python；在有 Codex 桌面运行时的机器上自动向助手提供其 Python 路径。Excel 库等依赖不足时提示用户处理，不自动联网安装。
- `GET /api/codex/status` 检查连接和登录类型；不返回账号邮箱、密钥或令牌。
- `POST /api/codex/session` 创建任务目录；`POST /api/codex/upload` 上传最多 20MB 文件；`GET /api/codex/files` 查看文件。
- `POST /api/codex/run` 发起任务，返回 job ID；`GET /api/codex/job` 轮询状态、工具事件和成果；`POST /api/codex/cancel` 中止运行。
- `GET /api/codex/download` 下载任务输入/结果；路径校验与真实路径检查阻止越界文件下载。

## 工作流与执行范围

工作流文档每次运行从服务端加载，作为 developerInstructions；API 对话的纯文字能力限制不会用于 Codex。当前模块最近对话作为任务上下文，每次创建独立的临时 Codex 会话，避免接入其他桌面任务。长期决定仍需在当前对话中重述。

“查看/拟方案”使用只读沙箱；“执行已确认步骤”使用 workspaceWrite，写入范围为本次独立输出目录，关闭工具网络访问和临时目录写入扩展。读取访问仍受本机 Codex 的既有能力/版本约束，本实现用提示指定任务读取范围，并不保证 OS 级读取隔离。不会批准沙箱外访问，也不提供权限提升按钮。

任务文件在 `.workbench/<session>/input` 与 `output/<job>` 保存，上传名称附随机前缀以避免同名覆盖；输入副本为只读。下载只接受对应任务中的普通文件，不列出符号链接。停止/失败可能留下部分成果，需复核。

浏览器保存任务 ID、所选后端与未完成 job ID。刷新后可继续轮询；服务重启后内存 job 状态不恢复，但任务文件仍保留。每次运行最多 15 分钟，超时尝试中止。此版本面向可信用户的本机使用，不提供多人账户/服务器部署认证。

协议参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。实现使用本机 CLI 生成的协议结构进行核对。
