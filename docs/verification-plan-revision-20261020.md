# AI 总结并修改方案验证 · 2026-10-20

## 实现

- 已有方案的卡片提供“AI 总结并修改方案”，含已审核状态；以完整当前方案与最近讨论生成完整修订草稿。
- 请求沿用本模块所选模型；AI 不自动审核或执行。未发送输入保留并提示先发送。
- 失败、超限、历史归档失败、期间方案或讨论变化均不覆盖原方案。
- 新增 fa_doc_history_v1 保存被替换方案；可查看历史并恢复为草稿。版本随浏览器备份导出，原 fa_state_v1 结构不变。
- 修订/恢复后需重新审核；下载未授权时主按钮灰显。已存在文件与运行产物未被改写。

## 自动验证

- `node tools/test-plan-revision.js`：PLAN_REVISION_TESTS_PASS。覆盖完整长基线、最近修改、所选模型、草稿状态、历史持久化与深拷贝、恢复不自动审核、网络失败、并发修改和新讨论、存储失败、未发送输入保留及长度校验。
- `node tools/test-calculation-plan.js`、`node tools/test-download-routing.js`、`node tools/test-workflow-parallel.js`、`node tools/test-merge-store.js`、`node tools/test-source-download.js`、`node tools/test-module-templates.js`：通过。
- `node tools/check-contract.js`：ALL_CHECKS_PASS；修改的 JS 语法检查通过。

## 实际网页与模型验证

仅在 localhost:18126 独立测试源操作，不改动用户18125浏览器任务。

1. 原已审核下载方案可见新修订按钮。
2. 记录测试修改要求：TM 2024 只保留 Import Quantity / Export Quantity，金额取消，其他既定要求保留，未定范围仍待确认。
3. 点击新按钮，通过实际本机 Codex 生成完整修订稿；输出含数量两指标、排除金额、范围待确认、原字段代码/单位/标记和20MB限制，未执行真实下载。
4. 当前方案变为草稿，下载按钮停用；历史方案包含原已审核版本。
5. 恢复原版本后仍为草稿，修订稿作为另一历史版本保留；刷新后两个历史版本仍在。
6. 原18125服务经启动器检查后安全更新，原任务、对话与文件保留。

截图：`../../../更新备份/20261020-plan-revision/AI总结并修改方案按钮.png`。
