# 研序 · 研究工作台 · 项目上下文

> 这份文件是**项目上下文的权威手写副本**（进版本库，跨机器带走）。
> `PROJECT-CONTEXT.md`（项目根目录，由 `project-context-hook.py` 在 SessionStart 自动刷新）
> 会自动采集 git 状态、目录结构、近期改动等**动态事实**，并把本文件同步进它的手写区。
> **要改上下文，改这份文件**，然后 `python D:/zcode-work/daily/scripts/project-context-hook.py --update .` 刷新。

## 1. 项目定位

把业务侧那套**两阶段九步科研流程**做成可执行的智能体工作台：

- **阶段一 · 开展研究并形成论文（6 步）**：① 文献调研 → ② 科学问题凝练与提取 → ③ 数据获取、清洗与处理
  → ④ 模型选择与运行 → ⑤ 图表绘制 → ⑥ 文章撰写与修改
- **阶段二 · 投稿到最终发表（3 步）**：⑦ 投稿前的核验与投稿 → ⑧ 回复审稿意见、修改与复核
  → ⑨ 接收后的校稿核验

**核心设计原则：流程是「先有 1 再有 2」**——一个环节做完并通过它的审核门，下一个环节才出现。
①和②里，机器负责把判断的素材准备好（检索式、逐篇要点、共识分歧、研究空白、候选问题、可行性初判），
**选哪条检索式、选哪个科学问题，是人的判断**。人机交替，不做一键全自动——这是刻意的，
全自动只会产出"看着漂亮、实则没用"的东西。

## 2. 目录与关键文件

| 路径 | 是什么 |
|---|---|
| `js/store.js` | 数据层：模块链、流程状态机、九步映射、环节参数、记忆持久化 |
| `js/chat.js` | 模块空间：状态条、任务说明卡、**调研面板**、**问题面板**、环节文档卡、对话 |
| `js/sidebar.js` | 左侧栏：任务、模块链、模型设置、调试台入口（仅 `?debug=1`） |
| `js/codex.js` | 本机 Codex 桥接：文献挖掘面板、文件分组、模块助手 |
| `js/tasks.js` | 独立研究任务：新建/切换/存档/备份恢复 |
| `js/guard.js` / `js/auth-*.js` | 登录与守卫（本地演示级门禁，非服务器认证） |
| `server.js` | 零依赖 Node 服务：静态服务 + 全部 `/api/*` + **调试台** |
| `tools/literature-research.js` | 环节①的要点抽取与研究空白归纳 |
| `tools/literature_search.py` | 检索阶段主脚本：Scholar + 开放 API 源，混合来源同批合并 |
| `tools/literature-sources.json` | 来源注册表（可执行 / 人工、语法与凭据），前后端共用 |
| `tools/research-question.js` | 选题冷启动、候选问题、问题说明书 |
| `tools/writing_build.py` | 环节⑥的 LaTeX 稿件生成（纯标准库） |
| `tools/debug-report.js` | **命令行诊断报告**（维护者日常用） |
| `docs/contract.md` | 契约：唯一对接依据，已到 §25 |
| `docs/debug-tool.md` | 调试台说明 + 排查手册 |
| `docs/quickstart-research-flow.md` | 全流程实跑指南（照着点一遍） |
| `docs/*-workflow-draft.md` | 各环节契约文档（定义/输入/执行/交付/检查/异常/需对齐内容） |
| `SOC-database-pipeline-clean/` | 师兄的 SOC 管线，被文献挖掘复用 |

## 3. 怎么跑

```bash
cd D:/zcode-work/report/flow-agent-web
node server.js                 # 或 npm start
# 浏览器 http://localhost:8123/
```

首次文献检索会自建 `.venv` 并装 Chromium/依赖。`.env` 是服务端配置（模型 / Key / 端口），已被 gitignore。

## 4. 调试

```bash
node tools/debug-report.js              # 中文诊断摘要：失败请求、慢请求、错误明细
node tools/debug-report.js --port 8124
node tools/debug-report.js --json
```

页面版 <http://localhost:8123/debug.html>（侧栏入口默认隐藏，地址栏加 `?debug=1` 才出现）。
详见 `docs/debug-tool.md`。

## 5. 踩过的坑（别再踩第二遍）

1. **模块级瞬态状态必须进 `js/chat.js` 的 `docSigOf()`**。`render()` 有「增量快速路径」，
   状态不在签名里就会被吞掉 → 界面"点了完全没反应"。**这个坑踩了两次**。
2. **模型输出永远当不可信输入**。免费模型会不按 JSON 输出、把整段 JSON 塞进字段。
   `tools/research-question.js` 有三层兜底（校验 → 扫描抠取 → 按行挑），新解析处照抄这个模式。
3. **CSS：flex 容器里的 `flex: 0 0 100%` 必须配 `flex-wrap: wrap`**，
   否则旁边的文本被挤成每行一个字符（检索式竖排那次）。
4. **模型通道**：`minimax/minimax-m3.1-flash:free` 可用；同名的付费通道**无额度**。
   免费通道慢（1–4 分钟）且会间歇性 502，服务端已做 3 次 / 4 分钟预算的退避重试。
5. **浏览器 localStorage 里的旧凭证会覆盖设置里的模型分组**：`research_api_keys_v1`
   优先于「设置」→ 症状是"测试连通通过、AI 对话却报无法连接"。
   清除：`localStorage.removeItem('research_api_keys_v1')`。
6. **模块助手默认是「本机 Codex」**，没登录会红字；①的调研面板走服务端 API 不受影响，
   但要对话追问得切「API 对话」。
7. **内置浏览器 Playwright 点击会超时** → 改用 `evaluate` 里的 DOM click。
8. **浏览器开着多个标签页时，按 `tabs.list()[0]` 取会读错页面**——先列 tab、按 URL/标题匹配再取。
9. 改前端要**重启服务 + 强刷浏览器**（静态资源是 no-store，但保险起见）。
10. `PROJECT-CONTEXT.md` 是**自动生成**的，别手改、也别提交进 git（每次会话都变）——改 `docs/project-notes.md`。

## 6. 当前进度

**已落地并实测跑通**：

- 九步主流程（step/type 合流、逐步解锁、契约先行）——契约 §22
- 上游产物汇聚（exec 的 `upstream` / `upstreamJobs` / `params`）——契约 §22.6
- 环节①文献调研：冷启动 → 检索 → 人工初筛 → 逐篇要点/共识分歧/研究空白——契约 §23
- **多源检索（2026-10-22）**：Scholar + PubMed / PMC / OpenAlex / Europe PMC / Semantic Scholar
  可在同一批合并；支持按源检索式（`queries`）、跨源 DOI/标题去重、逐源命中/失败展示；
  Scholar 验证码打断时开放源结果先落盘（批次 `status: "partial"`）
- 环节②科学问题凝练：候选问题 → 人选 → 问题说明书——契约 §24
- 环节⑥文章撰写：目标期刊手填、LaTeX 生成器、AAAI/NeurIPS/ICML 规范——契约 §22.7 / §23.5
- 调试台：服务端缓冲 + 调试页 + 命令行报告 + 文档——契约 §25

**未做**：

1. 环节⑦⑧⑨ **只有契约文档，无执行代码**
2. 环节⑥的**正文内容**仍靠人在模块对话里写；脚本只做结构化 + 转 LaTeX
3. 环节③的输入还没从②的问题说明书派生（"衔接"的最后一环）
4. 少量文献卡在 Scholar 人机验证（需手动过，不自动绕过）
5. 个别全文的要点抽取失败；「局限」字段几乎全是「文中未说明」（原文没明写）
6. 开放源作业的**全文获取**还没联调（`literature_fulltext.py` 只验证过 Scholar 路径）

## 7. 下一步建议顺序

1. 开放源作业的全文获取联调（`literature_fulltext.py` + 开放源候选的 `fulltext_links`）
2. 跑通②：①过审核门 → ②生成候选问题 → 采用一条 → 说明书 → 审核环节文档 → 过门 → ③
3. 让③的检索式与目标字段从②的问题说明书派生
4. 做⑦的生成器（自查清单 + 投稿材料包 + 封面信）——离"能交差"最近

## 8. 前几轮的会话 ID（要翻上下文时用）

| 会话 | 内容 |
|---|---|
| `sess_786b6dcf-856d-4a8f-bd8c-cd854d6aff4f` | 九步主线起源：账号系统 → 流程模块说明卡 → 审核门控 → 多项目 |
| `sess_b01b446a-639a-40d7-9fc5-3a8cf6296bde` | 文献挖掘第二阶段蜂群 + 上次「拉取多智能体会话」 |
| `sess_e4ec80fd-734f-4df8-8f45-7ceda9e570c3` | 文献挖掘实现与人工校验（旧凭证根因） |
| `sess_41f0b621-612b-4497-a525-b42cc6fbfc1c` | 业务流程图设计 + draw.io 制图工具链 |
