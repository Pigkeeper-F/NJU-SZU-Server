# 数据下载执行入口修复 · 2026-10-20

## 问题与修复

下载模块的“按审核方案开始执行”误接 LiteratureUI.start，导致 FAOSTAT TM 2024 任务追问检索式、文献纳排与原文提取字段。

现将下载模块三个执行位置统一连接至 CodexUI.openDownload，再走公开文件下载接口 /api/codex/fetch-source。下载区域直接显示主入口与能力边界；方案被编辑或下载窗口打开后发生变化，均须重新审核。助手提示词仅在文献挖掘声明文献执行能力。既有误入批次保留为折叠记录；可刷新、停止旧批次与下载已有成果，但不在数据下载中启动、继续文献提取或把旧问题注入新下载对话。

## 已验证

- `node tools/test-download-routing.js`：DOWNLOAD_ROUTING_TESTS_PASS。真实生产下载函数的路由、审核快照失效、下载记录、错误文献启动拒绝、旧批次存储与历史保留、对话上下文隔离。
- `node tools/test-source-download.js`：SOURCE_DOWNLOAD_TESTS_PASS。控制源字节、大小上限、地址边界、跳转、SHA、原件不变与清洗交接。
- `node tools/test-calculation-plan.js`：CALCULATION_PLAN_TESTS_PASS。下载方案执行按钮进入文件下载窗口，计算和绘图审核路径保持。
- `node tools/test-literature-guidance.js`、`node tools/test-module-templates.js`：通过。
- `node tools/check-contract.js`：ALL_CHECKS_PASS；修改的 JS 语法检查通过。

## 网页验证

在独立 localhost:18126 测试源操作，未修改用户 localhost:18125 的研究任务。

1. 下载模块显示“按方案下载数据”，没有新文献批次入口；未审核时不能下载。
2. 手写界面验证用 TM 2024 下载方案，保存、审核后主入口启用。
3. 点击主入口打开 download-dialog，显示已审核方案、实际文件地址和文件名清单；没有调用文献检索。
4. 未提供真实官方导出文件，未执行实际下载，不将界面验证写作研究成果。
5. 原18125服务经启动器确认无运行任务后安全更新助手提示，原文件和任务存储保留。

截图：`../../../更新备份/20261020-download-routing/下载数据执行入口.png`。

## 当前范围

公开 HTTP(S) 文件下载每次1–5个、每个20MB；数据库查询网页不是实际下载文件。FAOSTAT 按年筛选、分页 API、大文件自动拆分/导出尚未接入。本修复不声称已下载2024贸易矩阵。
