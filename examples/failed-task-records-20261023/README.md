# 未完成任务与历史故障记录（2026-10-23 快照）

用于接手开发者了解真实的失败、停止和待处理情况。本目录只保留脱敏状态记录，不是可导入或自动重放的任务备份；原任务与原始文件仍在原电脑的 `.workbench/`。

## 本次包含什么

| 记录 | 数量 | 含义 |
| --- | ---: | --- |
| `failed` | 3 | 旧 FAOSTAT 执行器当时报告小麦官方代码、年份/指标可用性或获取方案阻断，分类为 `reported_plan_blocker`；不证明研究需求确实不完整，也不证明当前版本仍有相同问题。 |
| `cancelled` | 1 | 文献任务记录为“已停止，阶段产物保留”。不据此推断技术失败或由谁停止。 |
| `waiting` | 1 | 旧文献执行器收到 FAOSTAT 数据任务，正在等待讨论模块归属、范围和获取方案。属于待讨论，不能标成程序崩溃。 |
| 历史 `error` 事件 | 1 | 后来已经完成的肉鸡任务曾遇到 Windows `WinError 5` 拒绝写入。记录不证明具体哪个进程占用。 |
| 历史访问/页面等待事件 | 8 | `attention` 中的登录/权限/验证、错误页和超时；保留原事件类型。 |
| 正常字段确认关口 | 1 | `attention/awaiting_confirmation`，分类为 `researcher_confirmation`；属于正常人工确认，不列为故障。 |

9 个已软删除的文献任务默认排除，未重新公开它们的内容。肉鸡案例的当前状态仍是 `completed/export`；只将其历史问题另存到事件表，不把已完成任务整体改称失败。完整扫描范围和来源指纹见 [provenance.json](provenance.json)。

当前代码已在 2026-10-20 的 FAOSTAT 修复中增加官方词典与获取入口自动核对，避免把应由执行器取得的技术代码反复交给研究者。这里保留的是旧任务原消息，本次只做记录快照，没有重新执行这些任务，因此不宣称这三次历史运行已被重试成功。继续时应使用新版执行器，沿用已审核业务范围自动核对代码和可用性，仅实际业务歧义再讨论。

## 文件

- [task-records.json](task-records.json)：5 条未成功终结或仍等待处理的任务记录，保留状态、阶段、时间、原消息、待讨论问题以及已有文件的相对名称、大小和 SHA256。文件内容未复制。
- [task-records.csv](task-records.csv)：同样 5 条记录的精简表，UTF-8 BOM。
- [historical-events.json](historical-events.json)：未删除文献任务的 10 条历史 `error/attention` 事件，保留事件时点与任务当前状态；其中 1 条是正常字段确认，不能按“异常”汇总。
- [provenance.json](provenance.json)：扫描计数、排除范围和源文件 SHA256。
- [verify_records.py](verify_records.py)：离线检查记录数、分类关系、引用和脱敏边界，不运行任务。

`message`、`questions` 来自真实记录；`error_class`、`interpretation` 和 `suggested_next_step` 是本次整理时增加的说明，不冒充已经查明的根因。时间保留来源 ISO 格式；`Z` 为 UTC，换成中国时间应加 8 小时。原文献任务没有单独创建时间时，使用最后一条持久事件时间，不补造时间。

本目录未包含账号、API Key、Cookie、登录会话、任何网址、原文/补材、原方案全文、模型输入、绝对本机路径或被删除任务内容。来源定位仅用相对记录名和文件指纹。原消息中的本机路径和 URL 被替换为显式移除标记；完整记录应在原电脑受控查看。

## 如何使用

```powershell
python examples/failed-task-records-20261023/verify_records.py
```

成功输出 `FAILED_TASK_RECORDS_CHECK_PASS`。仅需 Python 3.10+ 标准库。

接手开发者可以按 `task_id`、阶段、错误类别和保留文件指纹对照原电脑排查；必须在平台中明确选择原任务并确认规则后才能继续。把这些 JSON 复制到 `.workbench/` 不能恢复原始任务，不能自动重试，也不能替代材料或账号授权。
