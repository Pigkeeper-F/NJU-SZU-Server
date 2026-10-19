# 文献挖掘·第二阶段 独立验证报告（V1）

- 验证者：zcode/v1（蜂群验收把关；不采信自述，关键结论均亲自复跑）
- 日期：2026-10-15
- 仓库：`D:\zcode-work\report\flow-agent-web`（分支 `literature-mining-stage2`，基线 `origin/main@1499524`）
- 隔离区：`D:\zcode-work\daily\.tmp\lit-stage2\v1\`（零真实网络、零仓库测试残留；未修改任何实现代码）
- 基线文档：`docs/literature-mining-stage2-design.md`（§3/§4/§9/§10/§12/§13）、`docs/contract.md` §21（§21.5 为待复核声明）
- 更新（T2，2026-10-15）：P0 修复复验 + 持久回归固化 + 文档同步（§0/§5/§7/§9/§10 已更新）

## 0. 总体判定（T2 更新）

**通过（原 1 项阻断级缺陷已修复并复验）**：`server.js` 的 extract 适配器注入曾缺 `jobDir`/`config`（真实网页链在 extract 阶段必失败）；T1 已修复为 `{ bridge: codex, jobDir: job.dir, config: job.config, python, onEvent }`（server.js:20）。复验证据（T2）：①真实模式（未加载任何 extract 补丁）A2 全链 **32/32 PASS**（`a2\run-fixed-real.log`，MODE=fixed-real）；②该注入路径已固化为仓库内持久回归 `tools/test-literature-http-stage2.js`（17 步全绿），并经**灵敏度验证**——模拟旧调用形态时该测试必在关口断言失败、文案与 P0 一致；③全量矩阵复跑零回归：node 全套 PASS、python `Ran 150 tests OK`、check-contract `ALL_CHECKS_PASS`。

除该修复外：CLI 全链、HTTP 语义、契约字段、安全守卫、不回归 11 条抽查均通过；原 3 项建议级已全部处置（§7），观察级 4 项保留，均不阻断。

## 1. 验证环境与方法

| 项 | 值 |
|---|---|
| Python | 3.13.7（openpyxl 3.1.5 / pypdf 6.20.1 本机可用） |
| Node | v24.19.0 |
| 隔离方式 | 最小工作区 + 桩脚本（仅替换 discover/fulltext 两个需要网络/浏览器的阶段；其余阶段跑仓库真实脚本） |
| 网络 | 零真实网络；fulltext 桩经真实 `literature_fulltext.run(fetcher=FakeFetcher)` 注入假网络层，调用记录落盘为证 |
| 浏览器 | 未实跑（纪律禁止）；UI e2e 未跑 |
| 桩替换点 | A1：monkeypatch `literature_pipeline.SCRIPTS`；A2：node preload 拦截 `child_process.spawn` 重映射阶段脚本（不改仓库文件） |

## 2. A. 隔离端到端

### A1 CLI 全链（discover→dedupe→fulltext→extract(--prepare/--check)→validate→export）

驱动（仓库真实 `literature_pipeline.py`，仅 discover/fulltext 换桩）：

```
PYTHONUTF8=1 python stubs/driver.py --config <job>\run_config.json --output-dir <job>            # run A
PYTHONUTF8=1 python stubs/driver.py ... --from extract --until export                             # run B
PYTHONUTF8=1 python stubs/driver.py ... --resume                                                  # run C
```

- run A（exit 0）：discover 7 条候选（2 批）→ dedupe 5 组（merged 2 / needs_review 1）→ fulltext 获取 2 篇（PDF 1/HTML 1）、摘要级 2、待补充 1 → extract `--prepare` 2 bundle → **停在 attention(extraction)**（设计关口语义）✓
- run B（exit 0）：extract `--check`「提取结果全部通过（2 篇）」→ validate「共 4 个参数行（通过 2，阻断 1，待审核 1）」→ export「已导出 7 篇文献、3 个参数行」→「流水线完成（extract → export）」✓
- run C（exit 0）：「全部阶段已完成，无需续跑。」✓
- `events.jsonl`：26 行、类型分布 stage 15 / result 10 / attention 1，无 error；键形状 `at/type/stage/message/extra?` ✓
- 规则实测命中：**阻断** `invalid_number`（GSC-001-R002，value_normalized="abc"）；**待审** `missing_doi`×3、`probable_duplicate`（GSC-B2-002 组、Jaccard 0.714）、`missing_unit` ✓
- 产物契约逐字段核对脚本 `verify_a1.py`：**54/54 PASS**，覆盖：candidates v2（batches[]/6 新字段/GSC-### 与 GSC-B2-###/DOI 归一化/CSV 17 列 BOM）、dedupe §3.4（exact 自动合并 auto_excluded_duplicate / probable 不静默、CSV 列序）、fulltext §3.5（12 键/状态域/unavailable 带 reason/相对 POSIX path/%PDF≥50KB）、bundle §3.6（10 键/paper_id==stem）、结果 7 键/行 10 键、validation §3.7、export §3.8（15/14 列、阻断行剔除、成对文件）
- 零网络证据：`stubs/fetcher_calls.json` 仅 5 次 fake 调用（ensure_ready/fetch_pdf/fetch_page×3）

### A2 HTTP 全链（真实 server.js + 隔离端口 8219）

模式一（未补丁，复现缺陷）**13/13**：
- `POST /search` 202 + 36 位 id；非法 until 创建前 400『阶段边界…』；`run_config.json` 落盘 `0o444` 且拒绝回写；缺省 until=discover 逐字不回归（stages.discover=done、resumeStage=dedupe、counters.candidates=7）
- `POST /advance` 200 → **job failed：`提取阶段缺少必要参数（bridge/jobDir/python）`，stages.extract=failed、resumeStage=extract**；失败点前的 dedupe/fulltext 产物已就绪（确证失败点就在 extract 适配器调用）

模式二（preload 补 `jobDir`/`config` 后，验证修复与其余链路）**32/32**：
- advance 停在 `needs_attention + stage=awaiting_confirmation + resumeStage=extract`；stages 中 extract 保持 `running`（W1a 实现选择，见观察项）
- 非法 confirmations 400『字段确认内容无效』；无效 id 400『无效检索任务标识』
- `POST /advance {confirmations}` → append-only 写 `confirmations.json`（by=researcher/kind=fieldDefinitions）→ extract→validate→export 全部完成、stages 全 done、resumeStage=null、counters.parameterRows=3
- events.jsonl 21 行全量审计合法；`extraction/check_report.json` 真实落盘；GET /jobs 找回任务
- GET /download 真实请求：parameters.csv（`text/csv; charset=utf-8` + BOM）、literature.xlsx（xlsx MIME）、fulltext/files/GSC-001.pdf（`application/octet-stream` + `%PDF` + 70282B）、dedupe.json（json MIME）；`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Content-Disposition: attachment; filename*=UTF-8''…` 齐全；未登记名 400『结果文件不存在』、穿越名 400
- 结束后仓库 `.workbench/literature` 零残留、`.venv` 已清理

## 3. B. 全量测试矩阵（逐条）

| # | 项 | 结果 | 关键输出 |
|---|---|---|---|
| B1 | `node tools/check-contract.js` | 通过 | `ALL_CHECKS_PASS`（脚本顺序/Store API/DOM id 78 个/类名 314 个/静态节点） |
| B2 | `node --check` ×17（server.js、js/codex.js、js/sidebar.js、js/chat.js、js/store.js + tools 全部改动/新增 js） | 通过 | 17/17 OK |
| B3 | `node tools/test-literature-connector.js` | 通过 | `LITERATURE_CONNECTOR_TESTS_PASS`（S0-S7） |
| B4 | `node tools/test-literature-http.js` | 通过 | `LITERATURE_HTTP_TESTS_PASS` |
| B5 | `node tools/test-literature-sources.js` | 通过 | `LITERATURE_SOURCES_TESTS_PASS` |
| B6 | `node tools/test-literature-guidance.js` | 通过 | `LITERATURE_GUIDANCE_TESTS_PASS` |
| B7 | `node tools/test-literature-extract.js` | 通过 | `LITERATURE_EXTRACT_TESTS_PASS` |
| B8 | `node tools/test-literature-ui-stage2.js` | 通过 | `LITERATURE_UI_STAGE2_TESTS_PASS`（69 项静态断言） |
| B9 | `node tools/test-llm-settings.js` | 通过 | `LLM_SETTINGS_TESTS_PASS` |
| B10 | `node tools/test-merge-store.js` | 通过 | `MERGE_STORE_TESTS_PASS` |
| B11 | `node tools/test-server-exec.js` | 通过 | `ALL_EXEC_TESTS_PASS`（76 通过 / 0 失败） |
| B12 | `python -m unittest discover -s tools -p "test_literature_*.py"` | 通过 | `Ran 150 tests OK` |
| B13 | `python tools/test_literature_ui.py` | **未跑** | 系统 python 有 playwright 模块且 `py_compile` 通过，但纪律禁止浏览器实跑，且该 e2e 需常驻服务（默认 8123）；理由双证 |

## 4. C. 契约逐条核对

### §21.1 状态机与 stage 词汇
- status 5 值不膨胀：代码与测试面核对通过；`awaiting_confirmation = status:needs_attention + stage` 动态验证（A2）；stage 词汇含全部新增值（codex.js 文案表 + ui-stage2 断言）。
- 「attention 暂停阶段 stages 保持 running」：动态证据（A2），设计 §4.3 未钉死该值，UI 以 resumeStage 判断——记为观察项，无阻断。

### §21.2 路由
- search：`until` 缺省 discover 逐字不回归、非法值创建前 400 文案 ✓（A2 动态）。
- advance：`{id, until?, confirmations?}`、允许状态、`字段确认内容无效`/`无效检索任务标识`/`检索任务不存在`/`任务已停止…`/`该任务已完成全部阶段`/`已有文献检索正在运行…` 文案静态 3 处/动态 A2 + http 测试 ✓；`until` 缺省 export ✓；请求体 64KB 上限沿用现有 readBody（静态）。
- jobs：`{jobs:[…]}` mtime 倒序、损坏跳过、limit 收敛（1–50/默认 20，非法值静默收敛）——探针 list(0)/list(200)/损坏文件实测 ✓。
- job 快照新字段 `stages/resumeStage/until/counters` ✓（A2 动态）；interrupted 语义不变（connector 单测 S3）。
- download：登记成员校验替代固定白名单 + 36 位 id 正则 + 反软链 lstat + 相对路径；MIME 映射 csv/json/xlsx/md→octet-stream——**动态 HTTP 实测 + symlink 探针实测反软链拒绝** ✓。
- **W1a 五项「实现选择」核对**：a) fulltext/files 按 status.json path 补登记 ✓；b) check_report.json 纳入交付物 ✓；c) 两条新 400 文案 ✓、/jobs limit 静默收敛（契约未规定，已记录）；d) stages 语义 ✓（含 attention 保持 running）；e) events push 规则与单阶段完成文案（S0 逐字回归 ✓）；f) discover advance 仅 verification/interrupted 加 `--scrape-current` ✓（静态）。以上均与 contract §21.2/§21.5 记载一致。

### §21.4 守卫
- X-Workbench 403（http 测试通过）；Host/Origin 同源守卫（`checkRequestGuards`，403 文案在案）；`.workbench` 不经静态服务暴露——动态 5 探针：`/.workbench/…`、`/%2e%2e/.env`、`/server.js`、`/tools/…` 全 403、`/index.html` 200；`no-store/nosniff/filename*` 实测；付费墙→unavailable 不绕过（A1 状态域 + policy 字段）。

### §10 不回归 11 条抽查
1. 来源白名单+拒绝文案：CLI 实测（google-scholar+scopus → exit 1『检索失败：尚未接通以下检索来源：scopus；请明确改为仅检索 Google Scholar，或等待相应连接器。』）✓
2. normalizeConfig 12 字段与文案：16 项探针全过（topic/query、来源重复/未知、年份边界、起>止、limit 1–10、string≤500、list≤30、executable 拒绝）✓
3. 首批 ≤10 三层：config `1–10`、py 侧入口校验（既有 generic 文案，git 基线同文案）、UI `field.max='10'` ✓
4. 候选字段/批内标题去重/GSC-###/pending_review/CSV BOM/防注入：A1 全链 + 探针（同批同标题去重=1；`safe_csv_cell('=cmd|calc')="'=cmd|calc"`；`safe_url('javascript:…')=""`）✓
5. 下载白名单语义+反软链：symlink 探针实测『结果文件不可下载』；未登记/穿越 400 ✓
6. needs_attention 人工验证全链：静态（py attention→connector→UI 按钮→`--scrape-current`/`--resume`）+ 单测；**真机 captcha 未实测**（禁网）
7. run_config `wx`+`0o444` 冻结不回写：A2 动态 ✓
8. 错误文案逐条：静态清单 17 条（含『检索超过 3 分钟…』『本地服务已重启…』『任务已停止；已完成的阶段产物保留』等）逐一在案；关键 6 条动态触发 ✓
9. 守卫（X-Workbench/Host/Origin/no-store/nosniff/静态屏蔽）✓
10. workflowPrompt 4 断言 + 反向断言：test-literature-guidance PASS ✓
11. UI 关键文案/行为：test-literature-guidance + test-literature-ui-stage2 + test_literature_ui.py 静态断言 PASS（真机渲染未测）✓

## 5. D. 重点待验证项结论

① **旧第一阶段 completed 任务 advance**：探针实测 `loadPersisted` → 无 batches[] 的 v1 candidates 判 `discover=pending`、`resumeStage=discover`（与 §4.4 判定表一致）。文档记载=§4.4 判据表（「batches[] 非空」）+§3.3 v1 兼容；**文档未显式说明「旧任务 advance 会重跑 discover」**——建议在设计 §4.4/契约 §21 补一句（建议级）。
② **真实 captcha→advance**：静态核对通过（search `attention(verification)` → needs_attention/resumeStage → advance 置 resumeCurrent → `--scrape-current`；fulltext captcha → `attention(verification)` exit 0 → advance `--resume`）；**真实 captcha 未实测**（禁网）。
③ **bundle 经 bridge V4/V6**：静态核对通过（`bridge.createSession()` 新会话策略；单条 user message 传全文；`maxCharsPerPaper` 截断/`truncated` 标记在 python 侧 bundle）；**未实测**（无真实 codex 调用）。
④ **共享层双路径一致性**：实测通过——有 `literature-common.py` 时 `_COMMON=literature-common`（真实加载），无则后备；两条路径 stdout NDJSON **逐字节一致**、validation.json 除 `generated_at` 完全一致。注：I1 笔记「I3/I4 下划线名 import 走后备」与现实现不符（I2/I4 双名探测→实际加载真共享层；I3 完全不引用共享层）——**本报告即该观察记录的更正**（T2 定稿，不改他人笔记）。
⑤ **续批 `--batch-index` 无网页触发路由**：确认（server.js/codex.js 无 batch 相关；契约 §21.2 无该路由）——记为已知缺口（与 W1b 记录一致）。
⑥ **设置页 §15.6/§15.7**：test-llm-settings PASS；check-contract DOM id/类名 PASS；§15.6 新 DOM id（llm-group-select/add/remove、llm-model-toggle/menu）与 6 个新类名均在 js/sidebar.js 与 css/workspace.css；§15.7 `POST /api/ai/test`（handleAiTest、403 守卫、FETCH_ALLOWED 扩展）在案 ✓。

## 6. E. 真实性抽查（亲自复跑 ≥2，实际 4 项）

1. **openpyxl 亲读导出 xlsx**：`literature.xlsx` sheet=['文献表']、表头 15 列与 §3.8 逐字一致、数值类型保留（year=int）；`parameters.xlsx` sheet=['参数明细']、14 列一致。
2. **对 download 路由真实 HTTP 请求**：4 类 MIME + BOM + 安全头 + 负例（A2）；静态服务 5 探针（403/200）。
3. **手工运行阶段 CLI 最小输入**：source 白名单混合来源 → exit 1 + 冻结文案（零网络，校验先于浏览器）。
4. **全链真实 spawn**：A1 run A/B/C 与 A2 双模式全部由真实 python/node 子进程执行（非 mock 直调）。

## 7. 发现的问题分级

### 阻断（P0，1 项）——已修复（T1）并复验（T2）

- 原记录：`server.js:20` extract 适配器 `runExtractStage({ bridge: codex, job, python, onEvent })` 未传 `jobDir`/`config`，函数首行守卫即失败（`提取阶段缺少必要参数（bridge/jobDir/python）`）——真实网页链 discover→…→extract 必失败，awaiting_confirmation 关口永不可达；缺口根因：connector 测试走 `defaultExtractStage`、extract 单测自传 jobDir/config、http 测试用 fake job，三处都绕开该注入点。
- 修复（T1，2026-10-15）：`server.js` 改为 `{ bridge: codex, jobDir: job.dir, config: job.config, python, onEvent }`。
- 复验（T2，本报告更新）：
  1. **真实模式复跑**：A2 harness 加 `V1_EXPECT_FIXED=1`（**不启用任何 extract 补丁**，preload 仅做发现/全文桩与 venv 重映射）→ 全链 **32/32 PASS**（advance→awaiting_confirmation→confirmations→extract/validate/export→download；证据 `a2\run-fixed-real.log`，MODE=fixed-real）。
  2. **持久回归固化**（本任务新增，机器可检护栏）：`tools/test-literature-http-stage2.js`——真实 server.js 注入 + 桩 discover/fulltext + 真实 dedupe/extract/validate/export + download 关键断言；17 步全绿，输出 `LITERATURE_HTTP_STAGE2_TESTS_PASS`；已登记 README 测试清单。
  3. **灵敏度（falsification）**：以 `NODE_OPTIONS` 注入「还原旧调用形态」补丁复跑该测试 → 在关口断言处失败，错误文案与 P0 完全一致（证据 `t2\falsify-run.log`）——证明该护栏确实能抓住此回归，而非形式断言。

### 建议（P1，3 项）——已处置

1. 旧第一阶段 completed 任务 advance 会按 §4.4 判定表重跑 discover：已补记至 `docs/contract.md` §21.2.2（含 D7 兜底说明）。
2. `counters.parameterRows` 口径**定案**：= **导出交付的参数行数**（export 阶段覆写；本例 validate 中间值 4 → export 覆写 3，属预期语义，非缺陷）。
3. pypdf pin 文档不一致：已同步——`docs/literature-mining-stage2-design.md` §8.1 改为 `pypdf>=4,<7`（与 `requirements-literature.txt` 一致，并附 pin 说明）。

### 观察（P2，4 项）

1. validation.json 的 `counts` 比 §3.7 示例多 `literature_total/literature_blocking/literature_pending` 三键（向后兼容扩展，可接受）。
2. `/jobs` 非法 limit 静默收敛（1–50/默认 20）而非 400；契约未规定非法值行为（可接受，如实记录）。
3. 单条 dedupe 组标 `merge_confidence="exact"/max_score=0.0`（I2 已声明解释；§3.4 未定义单条组取值域）；attention 暂停阶段 stages 保持 `running`（W1a 实现选择，§4.3 未钉死）。
4. T1 复跑 A2 harness 时未先 seed，曾触发真实 `python -m venv` 在仓库留下 `.venv`（内含 pip 空环境、marker 为 stub 态）。T2 已恢复基线（移除 `.venv`，仓库回到「无 .venv」）；新持久测试内置 venv/pip/playwright 的 spawn 拦截，不会再产生该副作用。**不含任何实现代码改动**。

## 8. 未验证项与残余风险

- **真实网络/浏览器全链**：Google Scholar 真机 captcha→advance、fulltext 真抓取/验证码、付费墙真页面——未实测（纪律禁网禁浏览器）。
- **真实 CodexBridge 提取**：120k 字符 bundle 经 codex 传输与模型输出（V4/V6）——未实测（无真实 codex 调用）。
- **UI 真机 e2e**：test_literature_ui.py 未跑（需服务+Chromium；纪律禁浏览器实跑）；前端仅静态断言 + W1b 的 DOM 桩冒烟。
- **V2 固定开销实机计时**、**V7 大 job 压测**（数百候选下 jobs/下载分组性能）、**pypdf 中文 PDF 真实质量**——未跑；V3 已由 I2 单测 + 本报告 D④ 复核。
- **仓库内持久回归已固化**：`tools/test-literature-http-stage2.js` 覆盖真实 server 注入 → advance → extract 路径（T2）；阻断修复的落地建议（重跑 connector/http + 真实 advance 冒烟）已由 T2 全量矩阵完成。
- Windows 超时只杀直接子进程（沿用 I1 观察，当前阶段脚本无孙进程）。

## 9. 与设计 §12/§13 对照结论

- §12 待验证 V1-V7：V1（结果页 DOI/year/authors 可得性）仅 fixture/单测层；V2 未实测数字；V3 通过（I2 单测 + D④ 复核）；V4/V6 静态通过、未实测；V5 降级路径通过、中文质量未实测；V7 未压测。
- §12 待裁决 D1-D9 落地复核：D1 jobs ✓、D2 needs_attention+stage ✓、D3 GSC-B<n>-### ✓、D4 figure2data 未接入 ✓、D5 依赖已入 requirements 且 §8.1 pin 已对齐 `<7` ✓、D6 600s ✓（代码 600000ms）、D7 接受 ✓、D8/D9 预留 ✓。
- §13 验收①-⑧：①阶段 CLI ✓（A1+单测）；②中间 JSON ✓（A1 54 项字段核对）；③目录/日志/断点续跑 ✓（A1 runC + A2 events.jsonl + S3 单测）；④A/B/C 档 ✓（D④ + 复用映射）；⑤校验导出 ✓（B 规则实测+归档策略单测）；⑥来源注册表 ✓（探针+单测）；⑦依赖/PYTHONUTF8 ✓（S2 单测 + 静态）；⑧所有权/接线点 ✓（git status 与文件核对）。

## 10. 附录：证据文件（仓库外隔离区）

- `D:\zcode-work\daily\.tmp\lit-stage2\v1\a1\`：`runA/B/C.stdout.log`、`verify_a1.py`（54/54）、`job/`（全链产物）、`stubs/fetcher_calls.json`
- `D:\zcode-work\daily\.tmp\lit-stage2\v1\a2\`：`run-unpatched.log`（13/13，复现阻断）、`run-patched.log`（32/32）、`run-fixed-real.log`（T2 真实模式 32/32，MODE=fixed-real）、`preload.js`、`a2_run.js`
- `D:\zcode-work\daily\.tmp\lit-stage2\v1\c\`：`c_probes.js`（16/16）、`static_probe.js`（5/5）
- `D:\zcode-work\daily\.tmp\lit-stage2\v1\d\`：`d_probes.js`（8/8）、`shared/`（双路径一致性实验）
- `D:\zcode-work\daily\.tmp\lit-stage2\v1\t2\`：`falsify-require.js`、`falsify-run.log`（护栏灵敏度验证，预期失败且文案与 P0 一致）
- 仓库内（T2）：`tools/test-literature-http-stage2.js`（持久回归，17 步）；`docs/contract.md` §21.2.2 补记；`docs/literature-mining-stage2-design.md` §8.1 pin 对齐；`README.md` 测试清单登记
