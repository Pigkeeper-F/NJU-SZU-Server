# 协作规则（两人协作）

> 适用仓库：`Pigkeeper-F/NJU-SZU-Server`（当前内容：流程智能体 Web 前端）
> 技术接口的唯一真相是 [`docs/contract.md`](docs/contract.md)（模块边界、Store API 签名、DOM id、CSS 类清单）。
> 本文只回答一个问题：**两个人同时改这个项目，哪里可以放手动，哪里必须先打招呼。**

---

## 0. 三条核心原则

1. **接口先行**：任何接口（Store API、全局对象名、DOM id、CSS 类、数据结构、localStorage 键）的变更，**必须先改 `docs/contract.md`，再改代码，并与对方同步**——顺序不能颠倒。
2. **文件分区**：每人只改自己名下的文件；共享文件（store.js / app.js / index.html / style.css / contract.md）**单人持有写权**，另一人只提建议或 PR。
3. **提交前跑自检**：`node tools/check-contract.js` 必须 `ALL_CHECKS_PASS`，这是机器可检的底线（详见 §6）。

---

## 1. 文件分区与并发安全等级

| 文件 / 区域 | 并发安全 | 谁能改 | 说明 |
|---|---|---|---|
| `js/sidebar.js` | 🟢 **可并发** | 甲 | 左栏：折叠 + 拖拽调宽 + 选项卡 |
| `js/tabs.js` | 🟢 **可并发** | 乙 | 模块条：模块卡 + 依赖链 + 删除保护 |
| `js/chat.js` | 🟢 **可并发** | 甲 | 模块空间消息列表 + 底部输入区；**唯一允许联网的文件**（只调同源 `/api/ai/chat`） |
| `js/workspace.js` | 🟢 **可并发** | 乙 | 工作台视图：研究空间 / 工作记录切换 |
| `js/panel.js` 等**新增**模块文件 | 🟢 **可并发** | 谁做谁写 | 新文件天然无冲突；但需在 `docs/contract.md` 登记，并在 `index.html` + `js/app.js` 接线 |
| `README.md` 不同章节 | 🟢 可并发 | 各自章节 | 别整篇重排 |
| `docs/` 下各自新建的文档 | 🟢 可并发 | 谁写谁管 | — |
| `js/store.js` | 🟡 **慎重（单人持有）** | 固定一人 | 数据层：全部 UI 模块的公共依赖，改签名会同时影响 4 个脚本 |
| `js/app.js` | 🟡 **慎重（单人持有）** | 固定一人 | 装配层：render 调用顺序、订阅、存在性守卫 |
| `index.html` | 🟡 **慎重（单人持有）** | 固定一人 | 脚本引入顺序 + 13 个挂载点 id，是全局约定 |
| `docs/contract.md` | 🟡 **章节归属** | 各改各的章节 | 接口变更必须与代码同一次提交 |
| `css/style.css` | 🟠 **单文件热点** | 见 §3 分区 | 两人都会想加样式，用"末尾追加分区"规避行级冲突 |
| `tools/check-contract.js` | 🟡 单人持有 | 固定一人 | 自检脚本本身要稳定，改判定规则需双方同意 |
| `server.js` / `.env.example` / `package.json` | 🟡 **慎重（单人持有）** | 固定一人 | 本地 AI 代理：**API Key 只从环境变量读，`.env` 绝不入库**；请求/响应字段变更会影响 `js/chat.js`，先改契约 §2 |
| `.gitignore` / 配置文件 | 🟡 谁改谁说明 | — | 变更需在提交信息里写清原因 |

> 线上可直接套用的分工建议：**甲 = `sidebar.js` + `chat.js` + `tools/`**；**乙 = `tabs.js` + `README.md`**；
> 共享四件套（`store.js` / `app.js` / `index.html` / `contract.md`）由**一人固定持有**，另一人走 PR 建议。

---

## 2. 为什么这些地方能并发（架构依据）

- 三个 UI 模块**零耦合**：`sidebar.js` / `tabs.js` / `chat.js` 之间没有任何直接调用，只通过两条契约通信——
  ① 各自暴露 `window.X = { render() }`；② 读写状态一律走 `Store` 的 API。
  因此两人各改一个文件时，**除非动了 Store 契约或挂载点，否则不可能互相破坏**。
- `render()` 是幂等的：`app.js` 在每次状态变更后全量重渲染三者，谁也不需要"通知"谁。
- DOM 也是分区的：`#sidebar*` 归 sidebar.js、`#module-tabs`/`#module-chain` 归 tabs.js、
  `#module-space`/`#composer*` 归 chat.js。**跨容器读写 DOM 就是越界**。

**并发的四个前提**（任一被破坏，并发就变危险）：

1. 不改 `Store` 任何函数签名与事件 `type`；
2. 不改 `index.html` 的脚本顺序与挂载点 id；
3. 不新增未在契约登记的全局对象名；
4. 前端联网只允许 `js/chat.js` 里对同源 `/api/ai/chat` 的 `fetch`（契约 §2「两种运行模式」）——其他任何文件出现 `fetch` 都视为越界。

---

## 3. `css/style.css` 的追加分区规则（🟠 热点文件）

文件末尾已预留分区标记，**只在自己分区内追加**：

```css
/* ---- 分区 A：侧栏（sidebar.js）与输入区（chat.js composer） —— 负责人：A ---- */

/* ---- 分区 B：模块条（tabs.js）与消息区（chat.js msg-list） —— 负责人：B ---- */

/* ---- 分区 共用：跨模块公共样式 / 主题变量调整 —— 双方确认后由提交者追加 ---- */
```

纪律：

- ❌ **禁止整体格式化**本文件（编辑器/插件的"格式化文档"、改缩进、重排属性顺序都会制造整文件 diff）；
- ❌ 不在别人的分区里改样式，即使只是"顺手调一个像素"；
- ✅ 新类名带模块前缀（`.panel-xxx`），避免撞名；
- ⚠️ 改**主题变量**（`--bg` / `--accent` / `--border` …）与**共用类**（`.msg` / `.empty-state` / `.btn-send` …）属于公共资产，
  先在群里说一句或开 Issue，由提交者在"共用"分区追加覆盖规则，**不要直接改 `:root` 里的值**（那是全站观感）。
  当前主题是需求方指定的**固定白色主题（`#ffffff` + 近黑强调色）**，不跟随系统深色模式——这是产品决定，改动需确认。

---

## 4. 需要慎重的改动清单（改前必须做什么）

| 改动 | 影响面 | 改前必须做 |
|---|---|---|
| 改 `Store` 任意函数签名 / 返回值 | 4 个脚本全部可能受影响 | ① 改 `contract.md` §4 ② 群里同步 ③ 改完跑 `check-contract.js` + 手工回归 |
| 改/新增 `Store` 事件 `type` | 订阅方（app.js 及未来新模块） | 同上，并在 `contract.md` §5 事件表登记 |
| 改 `localStorage` **键名或数据结构** | **老用户数据会失效** | 必须做版本升级：新键 `fa_state_v2` + 迁移或兼容读取 + README 说明；禁止原地改结构 |
| 改 `index.html` 挂载点 id / 脚本顺序 | 所有脚本 | 同步 `contract.md` §8 / §7，并全局 grep 旧 id |
| 改 `app.js` 的 `renderAll()` 顺序 | 渲染结果（如 `--sidebar-w` 必须在读取宽度前写好） | 在提交信息里写明原因；顺序相关注释保留 |
| 改静态节点清单（`#composer-input`/`#btn-send`/`#btn-add-module`/`#btn-sidebar-toggle`/`#sidebar-resizer`） | 会**丢输入焦点与半截输入** | 这 5 个节点**只许改属性，禁止重建**；`check-contract.js` 会拦 |
| 改依赖链语义（追加接链 / 只有链尾可删 / `dependsOn` 规则） | 数据模型与两个 UI 模块 | `contract.md` §3 先行；属于产品级决定，必须双方确认 |
| 改主题变量与共用 CSS 类 | 全站观感 | 见 §3，走"共用"分区 + 确认 |
| 引入新依赖（框架 / CDN / ES module） | **违反项目硬约束** | 不允许。本项目是零依赖纯前端，`file://` 双击即用；`check-contract.js` 会拦 |

---

## 5. Git 协作流程

**分支与提交**

```bash
git pull --rebase                 # 开工前先同步
git switch -c feat/甲-sidebar      # 一人一分支，名字里带模块名
# ...改代码...
node tools/check-contract.js      # 提交前自检（必须 ALL_CHECKS_PASS）
git add -A && git commit -m "feat(sidebar): 支持双击手柄折叠"
git fetch origin && git rebase origin/main
git push -u origin feat/甲-sidebar
# 在 GitHub 上开 PR → 另一人 review → 合并到 main
```

**提交信息约定**（中文说明，前缀统一）：

| 前缀 | 用途 |
|---|---|
| `feat(模块):` | 新功能（如 `feat(tabs): 支持双击重命名模块`） |
| `fix(模块):` | 缺陷修复 |
| `docs:` | 仅文档（含 `contract.md`） |
| `style(css):` | 纯样式调整 |
| `chore:` | 工具 / 配置 / 自检脚本 |

**Review 只看四件事**（另一人 3 分钟能看完）：

1. 有没有动共享四件套（`store.js`/`app.js`/`index.html`/`contract.md`）？动了是否同步了契约？
2. 有没有动 §4 清单里的"慎重项"？动了是否有说明？
3. `check-contract.js` 是否通过（贴输出或 CI 结果）？
4. 自己模块的功能是否在浏览器硬刷（`Ctrl+F5`）后手工过了一遍？

**冲突处理**

- 规则：**谁后提交谁负责合并**，且必须"原样保留对方的区块"（尤其 `style.css` 分区与 `contract.md` 章节）；
- `index.html` / `store.js` 冲突：不要凭感觉取舍，直接找对方确认意图后再合；
- 数据文件（如果有人提交了 `fa_state_v1` 的导出样例）不要合，改为在 `docs/` 里写样例说明。

**不要提交**：临时文件 / 备份副本（`*.bak`、`*.old`、`index copy.html`）、编辑器个人配置、`node_modules`（本项目本就没有）。

---

## 6. 提交前自检（每人每次都做）

```bash
node tools/check-contract.js     # 机器可检：脚本顺序 / Store API / DOM id / CSS 类 / 全局导出 / 禁用能力 / 静态节点
```

它检查的 7 项见脚本头部注释；失败时会直接指出"哪个文件引用了不存在的东西"。
**另外必须人工过一遍**（脚本查不了运行期行为）：

1. 浏览器 `Ctrl+F5` 硬刷，自己的模块功能走一遍；
2. 涉及多模块的改动，把对方模块的关键路径也点一遍（如改 `tabs.js` 就顺手点一下侧栏折叠）；
3. 改了接口 → 确认 `contract.md` 已更新、对方已知晓。

---

## 7. 建议分工（可直接沿用）

| 角色 | 独占文件 | 说明 |
|---|---|---|
| **甲** | `js/sidebar.js`、`js/chat.js`、`tools/check-contract.js` | 左栏体验 + 消息空间 + 输入区 |
| **乙** | `js/tabs.js`、`README.md` | 模块条 / 依赖链 / 用户文档 |
| **共享（固定一人持有写权）** | `js/store.js`、`js/app.js`、`index.html`、`docs/contract.md`、`css/style.css` 的共用分区 | 另一人提 PR 或 Issue 建议 |

交接点（需要双方都在场/知情）：

- 新增 UI 模块（要同时改 `index.html` 加 `<script>` + `app.js` 加 render 调用 + `contract.md` 登记）；
- 改数据结构或 localStorage 键（涉及老数据兼容）；
- 改主题与共用 CSS。

---

## 8. 常见问题

**Q：我只是想在自己模块里加个 class，为什么也要守分区规则？**
A：因为 `style.css` 是单文件，行级冲突只能靠"物理分区"规避。你在自己分区追加，对方永远不用解你的冲突。

**Q：能不能直接在 main 上改？**
A：能，但只有一种情况：**单人独占文件的单行改动**（例如改自己模块里的一句文案）。任何涉及共享文件、接口、
样式的改动都走分支 + PR——这不只是流程洁癖，是因为"没人 review 的接口变更"就是下一个 bug 的来源。

**Q：发现对方的分区写了有问题的样式，怎么办？**
A：提 PR 或 Issue 说明，让对方改；**不要直接改**。同理适用于 `store.js` 与 `app.js`。

**Q：项目以后要加服务端（仓库名是 Server）怎么办？**
A：届时把前端整体挪到 `frontend/`（一次纯移动提交，不要顺手改内容），服务端代码放 `server/`，
两份各自的协作规则再按同样思路各写一份；本文档继续放在根上做总约定。
