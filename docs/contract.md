# 流程智能体 Web 前端 · 接口契约（v1，由 T1 交付）

> 合并提示（2026-10-14）：本文包含贡献版的历史九步写作流程、旧页面布局与当前数据研究工作台的契约，部分旧段落不再对应现行入口。当前运行入口与模块顺序以根目录 README、`docs/workflow-drafts.md` 和源码为准；环节文档、执行内核、账号与备份的接口章节仍供实现参考。贡献版旧流程的浏览器记录在合并版中保留为历史模块，不会转换成数据研究模块。

> 本文件是 T2 / T3 / T4 / T5 并行开发的**唯一对接依据**。除本文件明示的全局对象与 DOM 节点外，
> 各模块不得互相依赖内部实现，也不得修改他人交付的文件。

---

## 1. 目录结构

```
flow-agent-web/
├── index.html          # T1 交付：单页骨架 + 挂载点 + 脚本顺序（勿改）
├── css/
│   └── style.css       # T1 交付：全站样式（勿改；如需新样式请在本文件末尾追加并由 T1/T5 统一负责）
├── js/
│   ├── store.js        # T1 交付：数据层 window.Store（勿改）
│   ├── sidebar.js      # T2 交付：window.Sidebar
│   ├── tabs.js         # T3 交付：window.ModuleTabs
│   ├── chat.js         # T4 交付：window.ModuleSpace
│   ├── app.js          # T5 交付：window.App（装配 + 订阅）
│   ├── api-keys.js     # API 配置入口：供应商菜单 + 本地密钥保存
│   └── workspace.js    # 首页体验层：研究空间 / 记录 / 项目详情
└── docs/
    └── contract.md     # 本文件
```

---

## 2. 硬性技术约定

1. **零依赖**：不用任何框架/库；禁用 ES module（`import`/`export`/`type="module"`）、
   `crypto.subtle`、外部 CDN、外部字体与图片。全部用传统 `<script src>` 普通脚本。
2. **两种运行模式**：双击 `index.html` 可使用本地 UI 与 localStorage；要启用 AI 回复则运行
   `npm start` 并从 `http://localhost:8123/` 打开。前端只允许以 `fetch` 调用同源
   `POST /api/ai/chat`，不得直接访问第三方模型服务。页面可把用户在「添加 API」弹窗中输入的
   API Key 保存到当前浏览器 localStorage，并只随同源本地代理请求发送。
3. **全局对象约定**：每个 UI 模块挂载一个全局对象，只暴露 `render()`（**名字以各任务说明为准，务必一致**）：
   - `window.Sidebar     = { render: function () {} }`  ← T2（js/sidebar.js）
   - `window.ModuleTabs  = { render: function () {} }`  ← T3（js/tabs.js）
   - `window.ModuleSpace = { render: function () {} }`  ← T4（js/chat.js）
   - `window.App         = { render: function () {} }`  ← T5（js/app.js，内部依次调用上面三个）

   `render()` **内部自行调用 `Store.getState()` 读取最新状态**，不接受参数、不返回有意义的值。
4. **不使用 `DOMContentLoaded`**：脚本全部置于 `</body>` 之前，执行时 DOM 已就绪，直接跑即可。
5. **状态只从 `Store.getState()` 读**：任何模块都**不得**直接改 `getState()` 的返回值（那是深拷贝，
   改了不会有任何效果），也不得缓存跨事件的旧 state。所有写入必须走 Store 的 API。
6. **渲染由 app.js 统一调度**（见 §7）：UI 模块不要自己调用 `Store.subscribe`。
7. **`render()` 必须可重复调用且安全**：会被高频调用（拖拽时每帧、每次输入消息）。
   - 允许 `innerHTML = ''` 重建**自己负责的容器内部**（`#sidebar-tabs` / `#module-tabs` / `#module-space` 内部）。
   - **禁止重建 `#composer` / `#composer-input` / `#btn-send` / `#btn-add-module` / `#btn-sidebar-toggle` /
     `#sidebar-resizer`** 这些静态节点，只允许改它们的属性（`disabled` / `placeholder` / `value` / `title` / class）。
     否则输入框焦点与半截输入会被抹掉。
8. `getState()` 是**深拷贝**：读一次存局部变量即可，不要放进循环体。

---

## 3. 状态结构

```js
state = {
  sidebar: { collapsed: false, width: 240 },      // collapsed: bool；width: 180~520 整数
  tabs: [ { id: "flow", name: "流程" } ],          // 左侧栏选项卡；当前只有 flow，逻辑通用
  activeTabId: "flow",
  modules: [ module ],                             // 模块链（数组顺序即依赖顺序）
  activeModuleId: null                             // 当前模块 id 或 null（无模块时）
}

module = {
  id: "mod_xxxxx",            // 唯一字符串
  name: "模块1",
  dependsOn: null,            // 单上游 id；并列准备与计算汇合点为 null，使用 getUpstreamModules 查询
  createdAt: "2026-09-22T02:00:00.000Z",   // ISO 字符串
  messages: [ message ]
}

message = {
  id: "msg_xxxxx",
  role: "user" | "assistant" | "system",
  text: "已 trim 的非空文本",
  at: "2026-09-22T02:00:00.000Z"           // ISO 字符串
}
```

**流程关系（2026-10-20 更新）**：下载数据、数据清洗、文献挖掘为并列准备环节，均可向「模型调整与计算」提供材料；不要求依次完成或三个全部通过。计算后的展示顺序为「绘图 → 结果核查与定位 → 人工审核」。计算模块名称固定为「模型调整与计算」，direct / modify 等方式保留为子选项；参数更新、活动数据更新作为既有计算子环节保留。

数组只表示展示顺序。`dependsOn` 保留原字符串或 null 结构，记录单上游；并列准备及计算汇合点为 null。`Store.getUpstreamModules(id)` 返回当前任务中实际存在的直接上游模块深拷贝：计算返回三条准备路径；后续环节返回其前置阶段；历史写作流程继续沿原 dependsOn。读取旧任务时按 type 调整展示顺序与单上游关系，未标 type 的旧数据按旧序映射；保留 ID、对话、文档、运行记录、状态与当前选择，规则和文件会话仍按原 ID 关联，不移动或自动混合文件。

**添加、审核与删除**：`addModule(name?)` 可按固定名称直接建立任一准备环节或计算入口（兼容旧名称「计算」「直接计算」「修改计算」）；省略名称时补下一个缺失环节。准备环节审核通过后进入计算，不自动串到另一个准备环节；其余阶段进入自己的下游。删除判定使用真实上游关系，不把并列准备互相锁住。历史任务不因未选计算方式而丢弃下游记录，切换计算方式不删除模块。

---

## 4. Store API 精确签名（照抄调用）

```js
// —— 读 ——
Store.getState()                            // -> state 深拷贝（只读快照）
Store.subscribe(fn)                         // -> unsubscribe()；fn(evt)，evt = { type, payload }
                                            //    注册时不立即回调，只在变更后回调

// —— 模块链 ——
Store.addModule(name?)                      // -> module 深拷贝（按固定名称建立；省略 name 补缺失环节；
                                            //    同时把 activeModuleId 指向新模块）
Store.selectModule(id)                      // -> true | false（id 不存在 -> false；
                                            //    已选中同一个 -> true 且不触发事件）
Store.getUpstreamModules(id)                // -> 直接上游模块深拷贝数组；非法 id 返回 []，不修改状态
Store.removeModule(id)                      // -> { ok: true } | { ok: false, reason: "有下游模块依赖，不能删除" }
                                            //    另：id 不存在 -> { ok:false, reason:"模块不存在" }
Store.renameModule(id, name)                // -> true | false（name 空 / 模块不存在 -> false）
Store.appendMessage(moduleId, text, role)   // -> message 深拷贝 | null
                                            //    模块不存在、或 text.trim() 为空 -> null
                                            //    role 非 user|assistant|system 时按 "user" 处理
                                            //    不改变 activeModuleId

// —— 侧栏 / 选项卡 ——
Store.setSidebar(patch)                     // patch: { collapsed?: bool, width?: number }
                                            // -> sidebar 深拷贝；width 夹取 180~520，非法值忽略
                                            //    仅在值真正变化时才触发事件
Store.selectTab(id)                         // -> true | false
Store.resetAll()                            // -> 重置为默认 state 深拷贝（调试用）

// —— 常量（可选，避免硬编码） ——
Store.EVENT.MODULE_ADD      === 'module:add'
Store.EVENT.MODULE_SELECT   === 'module:select'
Store.EVENT.MODULE_REMOVE   === 'module:remove'
Store.EVENT.MODULE_RENAME   === 'module:rename'
Store.EVENT.MESSAGE_APPEND  === 'message:append'
Store.EVENT.SIDEBAR_CHANGE  === 'sidebar:change'
Store.EVENT.TAB_SELECT      === 'tab:select'
Store.EVENT.STATE_RESET     === 'state:reset'

Store.LIMITS = {
  STORAGE_KEY: 'fa_state_v1',
  SIDEBAR_MIN: 180, SIDEBAR_MAX: 520, SIDEBAR_DEFAULT: 240,
  ROLES: ['user', 'assistant', 'system']
}
```

**返回的都是深拷贝**：可以随便改返回值、存起来，都不会影响内部状态；但也不会"写回"。
想改状态只能调用上表方法。

---

## 5. 变更事件（`Store.subscribe(fn)` 收到的 `{ type, payload }`）

| type | payload | 触发时机 |
|---|---|---|
| `module:add` | `{ module, index, activeModuleId }` | `addModule()` 成功后 |
| `module:select` | `{ id }` | 切换到不同模块 |
| `module:remove` | `{ id, module, activeModuleId }` | 删除没有下游使用的模块成功后 |
| `module:rename` | `{ id, name }` | 改名成功且名字有变化 |
| `message:append` | `{ moduleId, message, role }` | 追加消息成功后 |
| `sidebar:change` | `{ collapsed, width, changed: ['collapsed','width'] }` | 折叠态或宽度真正变化后 |
| `tab:select` | `{ id, name }` | 切换选项卡 |
| `state:reset` | `{ state }` | `resetAll()` |

**约定**：任何变更都是"先落盘（localStorage）→ 再同步依次调用订阅者"。订阅者抛出的异常会被 Store
捕获并 `console.error`，不影响其它订阅者，也不会中断状态变更。

> ⚠️ 拖拽调宽时 `sidebar:change` 会高频触发。**T2 建议**：`pointermove` 中直接
> `document.documentElement.style.setProperty('--sidebar-w', px + 'px')` 实时跟手，
> 在 `pointerup` 时才调用一次 `Store.setSidebar({ width: px })` 落盘（也可以在拖动中节流调用）。
> 拖动期间给 `<body>` 加 `sidebar-resizing` 类以禁用过渡动画。

---

## 6. 持久化与容错

- localStorage 键：**`fa_state_v1`**（`Store.LIMITS.STORAGE_KEY`）。
- 读取时任何异常（JSON 语法错误、结构不是对象、字段类型不对、依赖指向不存在的模块、重复 id…）
  都会**静默回退到默认 state**，**绝不抛异常**；非法字段按字段级修复（例如 width 非数字→240、
  `activeModuleId` 指向不存在模块→指向最后一个模块）。
- localStorage 不可用（隐私模式 / 配额满）时静默降级为纯内存，不影响页面功能。
- 调试：控制台执行 `Store.resetAll()` 可清空回默认；`localStorage.removeItem('fa_state_v1')` 后刷新同理。

---

## 7. 装配契约（T5 的 app.js 照此实现）

```js
(function () {
  'use strict';

  function renderAll() {
    window.Sidebar.render();       // 顺序固定：先侧栏（写 --sidebar-w / 折叠类）
    window.ModuleTabs.render();    // 再顶部模块选项卡条（含 #module-chain 依赖链概览）
    window.ModuleSpace.render();   // 再模块独立空间 + 底部输入区
  }

  // 初始：确保默认选项卡被选中，然后全量渲染一次
  Store.selectTab('flow');
  renderAll();

  // 任何状态变更 -> 全量重渲染（各 render() 必须幂等、廉价、安全，见 §2.7）
  Store.subscribe(function (evt) {
    if (window.console && console.debug) console.debug('[event]', evt.type, evt.payload);
    renderAll();
  });

  window.App = { render: renderAll, renderAll: renderAll };
})();
```

- 顺序固定为 `store.js → sidebar.js → tabs.js → chat.js → app.js → api-keys.js → codex.js → workspace.js`。
- 当前呈现层采用对话优先布局：`#module-tabs` 与新增按钮位于左侧栏，添加 API 位于侧栏底部（折叠时仍可用）；主区仅保留当前模块标题、Codex 文件面板、对话和输入区。项目顶部栏、项目名称编辑、导出记录、项目备忘面板与模块标题上方的“研究空间”小字已移除；原浏览器保存的数据不删除。历史 T1–T5 骨架描述中的“顶部模块条”以此为准；受保护静态节点与状态 API 保持兼容。
- 模块脚本之间**不得**在加载期互相调用；所有跨模块调用只能发生在 `render()` / 事件回调里。
- 若某模块脚本缺失（例如 T2 未完成），app.js 需对 `window.Sidebar` 等做存在性判断以免整页报错。
- **T5 实装补充（js/app.js，均不影响上表语义）**：① 每个 `render()` 单独 `try/catch`，单个模块抛错
  不波及其它两个；② 默认选项卡按 `state.tabs` 兜底（优先 `flow`，缺失时取第一个）；③ `window.Store`
  缺失或签名不全时**不启动订阅**，改为页面顶部插入红色提示条（`#app-error`，内联样式，不改 style.css）
  并 `console.error`；④ 无论启动成功与否都挂载 `window.App = { render, renderAll }`。

---

## 8. DOM 挂载点 id 表

| id | 归属 | 说明 |
|---|---|---|
| `#sidebar` | T2 | `<aside>`；折叠类 `.sidebar-collapsed` **加在这里** |
| `#sidebar-header` | 静态 | 栏头，内含标题与折叠按钮 |
| `#btn-sidebar-toggle` | T2 绑定 | 点击 → `Store.setSidebar({ collapsed: !state.sidebar.collapsed })` |
| `#sidebar-tabs` | T2 渲染 | 选项卡列表容器，T2 可自由重建其内容 |
| `#sidebar-resizer` | T2 绑定 | 6px 拖拽手柄，`cursor: col-resize`；折叠时被 CSS 隐藏 |
| `#main` | 静态 | 主区 `<main>` |
| `#module-tabs` | T3 渲染 | **模块卡容器**（T3 可自由重建其内容；「＋」按钮**不在此容器内**） |
| `#module-chain` | T3 渲染 | 依赖链概览容器（条内右侧，如 `模块1 → 模块2 → 模块3`）；留空时 CSS 自动隐藏 |
| `#btn-add-module` | T3 绑定 | 静态节点，在 `.module-tabs-bar` 内、`#module-chain` 之后；T3 只绑定 click，勿重建 |
| `#module-space` | T4 渲染 | 模块独立空间挂载点；T4 在其中创建 `.module-header` / `.msg-list` / `.empty-state` |
| `#composer` | 静态 | 底部输入区容器；T4 可改其 class/属性/内部文本，勿重建 |
| `#composer-input` | T4 绑定 | `<textarea rows="1">`，自适应高度 |
| `#btn-send` | T4 绑定 | 发送按钮 |

DOM 层级（`index.html` 已固定）：

```
body > .app-shell
        ├── aside#sidebar.sidebar
        │     ├── #sidebar-header.sidebar-header > .sidebar-title + #btn-sidebar-toggle.icon-btn
        │     ├── #sidebar-tabs.sidebar-tabs
        │     └── #sidebar-resizer.sidebar-resizer
        └── main#main.main
              ├── .module-tabs-bar > #module-tabs.module-tabs + #module-chain.module-chain + #btn-add-module.module-tab-add
              ├── #module-space.module-space
              └── #composer.composer
                    └── .composer-row > #composer-input.composer-input + #btn-send.btn-send
                    └── .composer-hint
```

> T2 若要在侧栏底部放小字提示，直接往 `#sidebar` 内追加 `.sidebar-hint`（CSS 已备好，折叠时自动隐藏）。

---

## 9. CSS 类清单

| 类名 | 用途 / 写法约定 |
|---|---|
| `.app-shell` | 顶层 flex 容器（左栏 + 主区），已 `height: 100vh` |
| `.sidebar` | `<aside>` 本体，宽度取 `var(--sidebar-w)` |
| `.sidebar-collapsed` | 折叠态：**加在 `#sidebar` 元素上**（CSS 也兼容 `body.sidebar-collapsed`）→ 宽度 44px、隐藏选项卡与手柄 |
| `body.sidebar-resizing` | 拖拽中加在 `<body>`：禁用宽度过渡、光标 col-resize、禁选中 |
| `.sidebar-header` / `.sidebar-title` | 栏头与标题 |
| `.icon-btn` | 栏头里的方形图标按钮（折叠按钮） |
| `.sidebar-tabs` | 选项卡列表容器（纵向 flex） |
| `.sidebar-tab` / `.sidebar-tab-active` | 选项卡项 / 选中态（T2） |
| `.sidebar-resizer` | 右侧 6px 拖拽手柄；hover 或加 `.is-active` 时高亮 |
| `.sidebar-hint` | 侧栏底部小字提示（T2 追加；折叠时 CSS 自动隐藏） |
| `.main` | 主区（纵向 flex：选项卡条 / 空间 / 输入区） |
| `.module-tabs-bar` | 顶部条外层（横向 flex：模块卡列表 + 依赖链概览 + ＋按钮） |
| `.module-tabs` | 模块卡滚动列表容器（横向滚动，隐藏纵向；`flex:1`） |
| `.module-chain` | 依赖链概览（条内右侧，`max-width:38%`，`:empty` 时自动隐藏；窄屏隐藏） |
| `.module-tab` / `.module-tab-active` | 模块卡 / 选中态（T3） |
| `.module-tab-title` | 卡内模块名（`text-overflow: ellipsis`，建议 `title` 放全名） |
| `.module-dep` | 依赖徽标，建议文案：首模块 `起点`，其余 `← 上游模块名`（T3） |
| `.module-tab-del` | 卡内删除按钮（×）；有下游依赖时可加 `disabled` 属性，Store 也会拒绝 |
| `.module-tab-add` | `#btn-add-module` 的样式（虚线方框 ＋） |
| `.module-space` | 模块独立空间（纵向 flex，自身纵向滚动） |
| `.module-header` / `.module-header-title` / `.module-header-meta` | 模块空间头部（模块名 / 依赖来源 / 消息数），T4 可选使用，已含下边框与间距 |
| `.msg-list` | 消息列表容器（居中，`max-width: var(--content-max)`，纵向 gap） |
| `.msg` | 消息气泡基类（`white-space: pre-wrap`，长词自动换行） |
| `.msg-user` | 用户气泡：右对齐、主题色底、白字 |
| `.msg-assistant` | 助手气泡：左对齐、面板底色 |
| `.msg-system` | 系统提示：居中、虚线上边框、灰字小号 |
| `.msg-text` | 气泡内文本（可选，`.msg` 本身已 `pre-wrap`） |
| `.msg-meta` | 气泡内时间戳（等宽小字；用户气泡内自动右对齐变白） |
| `.empty-state` / `.empty-state-title` / `.empty-state-hint` | 空状态（无模块 / 无消息） |
| `.composer` / `.composer-row` | 底部输入区容器 / 一行布局（居中 `max-width`） |
| `.composer-input` | textarea：`min-height:40px`、`max-height:180px`、聚焦高亮 |
| `.btn-send` | 发送按钮；`:disabled` 有降透明度样式 |
| `.composer-hint` | 小字提示（窄屏隐藏） |
| `.hidden` | 工具类：`display:none !important` |

主题变量（`:root`，**全局固定白色主题**：`--bg/--panel` 为 `#ffffff`、`--panel-2` 为 `#f7f8fa`、强调色 `--accent` 为近黑 `#111827`；**不跟随系统深色模式**）：
`--sidebar-w`、`--sidebar-collapsed-w`、`--sidebar-min`、`--sidebar-max`、`--font`、`--mono`、
`--bg`、`--panel`、`--panel-2`、`--border`、`--text`、`--muted`、`--accent`、`--accent-soft`、
`--accent-line`、`--danger`、`--danger-soft`、`--radius`、`--radius-lg`、`--shadow`、`--transition`、
`--content-max`(880px)。

**侧栏宽度的唯一开关**：`document.documentElement.style.setProperty('--sidebar-w', w + 'px')`
（由 T2 的 `render()` 负责，CSS 兜底值 240px）。

---

## 10. 各模块推荐实现要点

### T2 `js/sidebar.js`（`window.Sidebar`）
1. `render()`：读 `state.sidebar` → 写 `--sidebar-w` 到 `:root` → 给 `#sidebar` 切
   `.sidebar-collapsed` → 用 `state.tabs` / `state.activeTabId` 重建 `#sidebar-tabs`
   （`.sidebar-tab` + 选中 `.sidebar-tab-active`，点击 → `Store.selectTab(id)`）。
2. `#btn-sidebar-toggle` 的 click **只绑定一次**（加载期绑定即可），回调里用
   `Store.getState().sidebar.collapsed` 取当前值再取反。
3. 侧栏底部小字提示：往 `#sidebar` 末尾追加一个 `.sidebar-hint` 元素（CSS 已备好，折叠时自动隐藏），
   只创建一次，`render()` 里更新文案即可。
4. 拖拽：`#sidebar-resizer` 上 `pointerdown` → `setPointerCapture` → `pointermove` 用
   `e.clientX` 得到新宽度（可 `clamp(180, 520)`，用 `Store.LIMITS`）→ 实时写 `--sidebar-w`；
   `pointerup/cancel` → 移除 `body.sidebar-resizing` → `Store.setSidebar({ width })`。
   折叠态下不响应拖拽。可选：手柄双击切换折叠态。

### T3 `js/tabs.js`（`window.ModuleTabs = { render }`）
1. `render()`：重建 `#module-tabs`：对 `state.modules` 逐个生成
   `.module-tab(.module-tab-active)`，内部 `.module-tab-title` + `.module-dep` + `.module-tab-del`；
   用 `data-id` 记录模块 id（用 `textContent` 写文案，避免拼接 HTML 注入）。
   `.module-dep` 文案：首模块 `起始`，其余 `← 上游模块名`（与任务说明中的「← 上一模块名」一致）。
   `state.modules` 为空时 `#module-tabs` 放一个 `.empty-state-hint` 或留空（＋按钮始终可见）。
2. **依赖链概览**写进 `#module-chain`（条内右侧的独立静态容器，不在 `#module-tabs` 里）：
   文案形如 `模块1 → 模块2 → 模块3`；无模块时置空字符串（`:empty` 时 CSS 自动隐藏，无需手动控制）。
3. 事件用**委托**绑在 `#module-tabs` 上（只绑一次）：点卡片 → `Store.selectModule(id)`；
   点 `.module-tab-del` → `e.stopPropagation()` 后 `Store.removeModule(id)`，返回
   `{ok:false}` 时把 `reason` 用 `Store.appendMessage(state.activeModuleId, reason, 'system')`
   提示出来（T4 会渲染成系统气泡）。
   `.module-tab-del` 在存在下游依赖时给 `disabled` + `title="有下游模块依赖，不能删除"`。
   ⚠️ **必须同时保留 `#module-tabs` 上捕获阶段的 `pointerdown` 兜底**（T3 实测：真实浏览器点击 disabled
   控件只派发 `pointerdown`、**完全不派发 `click`**），否则「被拒 + 系统提示」这条验收项无法成立。
   维护者不得删除或改写该分支（js/tabs.js `onTabsPointerDown`，另含 600ms 去抖）。
4. `#btn-add-module`（**静态节点已存在**，位于 `.module-tabs-bar` 内、`#module-chain` 之后）
   click → `Store.addModule()`（只绑一次）。**不要自己再创建 / 重建这个 ＋ 按钮**，否则页面会出现两个。
5. 可选：双击 `.module-tab-title` → `prompt('重命名模块', 当前名)` → `Store.renameModule(id, 输入)`。
6. 选中卡滚动进视野：`el.scrollIntoView({ inline: 'nearest', block: 'nearest' })`。

### T4 `js/chat.js`（`window.ModuleSpace = { render }`）
1. `render()`：读 `state.modules` / `state.activeModuleId`：
   - 无模块 → `#module-space` 内放 `.empty-state`（提示点右上 ＋ 新建模块），并 `#composer-input` 禁用；
   - 有模块 → 可选放 `.module-header`（`.module-header-title` 放模块名、`.module-header-meta` 放
     「依赖：← 上游模块名 / 起始」与「消息 N 条」）+ 重建 `.msg-list`，逐条按 `message.role` 生成
     `.msg.msg-user|.msg-assistant|.msg-system`，内含 `.msg-text` 与 `.msg-meta`
     （`at` 用 `new Date(at).toLocaleTimeString()` 之类格式化）；
     messages 为空 → `.empty-state`（标题放模块名，提示放依赖来源）。
   - 渲染后把 `#module-space.scrollTop = scrollHeight` 滚到底部。
   - **不要重建 `#composer-input`**：只更新 `disabled` 与 `placeholder`。
2. 发送：`#btn-send` click 与 `#composer-input` 的 `keydown`（Enter 且非 Shift）→
   取 `value` → `Store.appendMessage(activeModuleId, text, 'user')`；返回非 null 时清空输入框、
   重新自适应高度。空文本或没有选中模块时直接忽略。
3. 自适应高度：输入时 `el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px'`。
4. AI 对话模式可通过同源 `POST /api/ai/chat` 请求本地代理；不得直接请求第三方模型服务。

### T5 `js/app.js`（`window.App`）
见 §7；另需在 `Store` 不存在时给出明确报错提示，并在控制台暴露 `window.Store` 便于调试。

---

## 11. 手工验收清单（T5 / 联调）

1. 双击 `index.html`：左栏显示「流程」选项卡，选中态高亮；主区顶部只有「＋」，空间区为空状态。
2. 点「＋」三次 → 生成 模块1 → 模块2 → 模块3，卡片依次带 `← 模块1`、`← 模块2` 徽标（模块1 显示 `起点`），
   且新建模块自动成为当前模块。
3. 删除 模块2 → 被拒，且出现系统提示「有下游模块依赖，不能删除」；删除 模块3 → 成功。
4. 每个模块的消息各自独立：在 模块1 发消息，切到 模块2 看不到。
5. 拖拽手柄 → 宽度实时变化并夹在 180~520；松手后刷新页面宽度保持。
6. 折叠按钮 → 侧栏收到 44px，刷新后仍是折叠态。
7. 刷新页面：模块链、消息、侧栏宽度/折叠态全部恢复（localStorage `fa_state_v1`）。
8. 控制台 `Store.resetAll()` → 回到初始状态。

---

## 12. 流程模块与人工审核门控（v5 新增）

按业务流程图把 9 个步骤做成"带说明 + 带审核状态"的模块。**契约先行补记**（对应提交：流程模块说明卡与审核流转）。

### 12.1 数据结构新增字段（module 上，均可缺省、向后兼容）

| 字段 | 类型 | 说明 |
|---|---|---|
| `step` | string \| 缺省 | 流程步骤 key（`literature` / `question` / `data` / `model` / `chart` / `writing` / `submit` / `rebuttal` / `proof`）。手工新建的模块没有该字段 |
| `spec` | object \| 缺省 | 任务说明：`{ goal, todo: string[], output, acceptance }`——即界面上「本模块要做什么」卡片的四行 |
| `status` | `'todo' \| 'doing' \| 'review' \| 'approved'` | 审核状态；缺省/非法值一律按 `'todo'` 处理 |
| `approvedAt` | string \| 缺省 | 审核通过时间（ISO） |

> ⚠️ **归一化陷阱（已修）**：`normalizeModule()` 在文件开头加载 localStorage 时就会用到 `MODULE_STATUSES`。
> 该常量必须与其他常量一起声明在**文件顶部**——若声明在文件后段，`var` 提升会让加载期的值是 `undefined`，
> 归一化抛错 → 整个状态回退成默认（表现为"刷新后模块全丢"）。

### 12.2 新增 API（照抄调用）

```js
Store.initFlowModules()          // -> { created, firstId }；按 FLOW_STEPS 建缺失的流程模块（已存在同 step 的跳过）
Store.setModuleStatus(id, st)    // -> boolean；st 取 todo|doing|review|approved
Store.submitModule(id)           // -> boolean；doing|todo -> review（提交人工审核）
Store.approveModule(id)          // -> { ok, nextId, nextName }；置 approved 并**自动把 activeModuleId 切到下一个模块**
Store.rejectModule(id, note?)    // -> boolean；review -> doing，note 非空时写入一条 system 消息
Store.FLOW_STEPS                 // 9 步只读快照：[{ key, name, spec }]，说明文案的唯一定义处
Store.LIMITS.MODULE_STATUSES     // ['todo','doing','review','approved']
```

### 12.3 新增事件

| type | payload | 触发时机 |
|---|---|---|
| `flow:init` | `{ created, ids }` | `initFlowModules()` 建出至少一个模块后 |
| `module:status` | `{ id, status, nextId? }` | 状态变更（submit / approve / reject / setModuleStatus）后 |

### 12.4 界面行为约定

- **侧栏底部按钮**「按业务流程初始化 N 个模块」（`sidebar.js`，`.sidebar-flow-btn`）：缺几个提示几个，9 步齐了自动隐藏。
  放在侧栏而非模块空间空状态的原因：`workspace.js` 的 `decorateSpace()` 在无模块时会 `replaceChildren` 换掉 `#module-space`，放那里的按钮会被覆盖。
- **模块空间顶部顺序**：`模块头` → `状态条`（状态徽标 + 提示 + 动作按钮）→ `说明卡` → `消息列表`。
  状态条放在最前是刻意的：保证「提交审核 / 确定（通过）」永远在首屏可见。
- **滚动位置**：当前模块**没有消息时滚到顶部**（保证说明卡可见），有消息时才滚到底部。
- **审核流转**：待开始/进行中 → `完成并提交审核` → 待审核 → `确定（通过）`（自动跳到下一模块）/ `打回重做`（回进行中，附系统提示）。
- **模块卡片状态徽标**（`tabs.js`，`.module-status`）：○ 待开始 / ◐ 进行中 / ⏳ 待审核 / ✓ 已通过。
- 样式位于 `css/style.css` 追加分区（`.spec-*` / `.status-*` / `.module-status` 在「共用」区，`.sidebar-flow-btn` 在「A」区）。

### 12.5 手工验收（已实测通过）

1. 侧栏点「按业务流程初始化 9 个模块」→ 生成 ①…⑨，全部 `todo`，卡片徽标 `○○○○○○○○○`。
2. 进入 ① → 看到「本模块要做什么」（目标 / 要做的事 / 产出 / 验收要点）→ 点「完成并提交审核」→ 徽标变 `⏳ 待审核`，出现「确定（通过）」「打回重做」。
3. 点「确定（通过）」→ ① 变 `approved`（卡片徽标 ✓），**并自动跳到 ②**。
4. 刷新页面 → 9 个模块、① 的 `approved`、说明卡内容全部保留（`fa_state_v1`）。

---

## 13. 项目管理（本地多项目，v6 新增）

- **当前项目** = `state.modules`（键 `fa_state_v1`）+ 项目名（键 `research_workspace_meta_v1` 的 `name` 字段，由 `workspace.js` 读写；store 只读写其中 name）
- **归档项目** = 键 `fa_projects_v1`：`[{ id, name, savedAt, modules, activeModuleId }]`

### 13.1 新增 API

```js
Store.createProject(name)    // -> { ok, name, archived }；先把当前工作区归档进历史，再清空模块并写入新项目名
Store.openProject(id)        // -> { ok, name, moduleCount }；当前工作区先归档，再载入所选项目的模块
Store.listProjects()         // -> [{ id, name, savedAt, moduleCount }]（轻量视图，不含模块内容）
Store.currentProjectName()   // -> string（读 meta 键的 name，缺失回「我的研究项目」）
Store.PROJECTS_KEY           // 'fa_projects_v1'
Store.PROJECT_META_KEY       // 'research_workspace_meta_v1'
```

### 13.2 新增事件

| type | payload | 触发时机 |
|---|---|---|
| `project:create` | `{ name, archived }` | 新建项目成功后（archived 为归档结果的 `{id,name}` 或 null） |
| `project:open` | `{ id, name }` | 打开历史项目成功后 |

### 13.3 界面约定

- 侧栏「当前项目」文字右侧的 `+` 按钮（`.project-add-btn`，`title="新建项目"`）→ 展开 `.project-new-bar`
  （输入框 + 确定 / 取消；Enter 确定、Esc 取消）。输入框独占一行、按钮另起一行——侧栏太窄，同排会把按钮挤成竖排文字。
- 确定后执行 `location.reload()`：项目名存在 workspace 的 meta 键里，刷新一次保证侧栏/详情/页面标题三处一致。
- `.project-history`：存在归档时列出「历史项目 (N)」与各项（`名称（N 模块）`），点击即切换（切换前同样先归档当前工作区）。
- **没有任何模块的当前项目不会被归档**（避免产生空归档）。
- 样式：`.project-*` 位于 `css/style.css` 追加分区 A（sidebar.js 归 A）。

### 13.4 手工验收（已实测通过）

1. 点「当前项目」右侧 `+` → 输入「实验二：投稿返修」→ 确定：项目名（侧栏 + 页面标题）变为新名、模块清空为 0、出现「历史项目 (1) · 我的研究项目（9 模块）」。
2. 点历史项 → 切回：项目名恢复「我的研究项目」、9 个模块回归、① 的 `approved` 状态完好、历史项目列表清空。


## 14. 账号系统（2026-10-13 集成）

### 14.1 文件与引入顺序
- 工作台 index.html：js/auth-config.js → js/auth-storage.js → js/guard.js →（原渲染脚本链）。守卫保证未登录访问工作台一律 `location.replace("login.html")`。
- 登录/注册页 login.html / register.html：js/auth-config.js → js/auth-storage.js → js/auth-pages.js（+ css/auth.css）。已登录访问这两页自动跳 index.html。
- 来源：`web-account-system` 项目整体移植；账号存储对象由 window.Store 改名 **window.AuthStore**（避免与工作台数据层 Store 撞名）；window.Session / window.AuthCrypto 保持原名。

### 14.2 存储键与跳转规则
- 账号表键 `wa_accounts`（username/salt/passHash/createdAt，盐化 SHA-256，前端演示级）；会话键 `wa_session`（字符串用户名）。
- 注册：第一段测试码（js/auth-config.js 的 APP_CONFIG.testCode，当前 **nailong**；改测试码只改这一处并同步本节）→ 第二段账号+密码（≥6 位、两次一致、重复账号拒绝）→ 成功跳 login.html。
- 登录：账号+密码校验（失败统一提示「账号或密码错误」，防账号枚举）→ 成功写会话跳 index.html（工作台）。
- 退出：工作台左下角 ⎋ 按钮 → Session.clear() → location.replace("login.html")。
- 工作台侧栏底部显示当前用户名（#auth-user，取 window.AuthUser）。

### 14.3 手工验收（已实测）
错误测试码拦截 / 正确码解锁 / 密码不一致拦截 / 注册成功跳登录 / 重复账号拦截 / 错误密码拦截 / 登录进工作台 / 侧栏显示用户名 / 刷新保持登录 / 退出回登录页 / 未登录直闯 index.html 被挡。


## 15. 体验升级（2026-10-13）

### 15.1 数据备份 / 恢复
- 顶栏「⤓ 备份」：把工作台数据打包为 JSON 下载（`app:"yanxu-workspace"`, version 1, data 含
  `fa_state_v1` / `fa_projects_v1` / `research_workspace_meta_v1` / `fa_current_project_id_v1`）。
  **不含 `fa_llm_settings_v1`（其中含 API Key，绝不进备份文件）**。
- 顶栏「⤒ 恢复」：选择备份文件 → 校验 `app` 与 `data` 结构 → confirm 覆盖 → 写入 localStorage → reload。
  账号（wa_accounts / wa_session）不受恢复影响。
- 实现位置：js/workspace.js；相关 id：`backup-project` / `import-project` / `import-file`。

### 15.2 记录搜索
- 工作记录视图顶部搜索框 `#records-search`：按消息文本做大小写不敏感过滤，实时重渲染；
  匹配数显示于 intro（「匹配 N 条记录：」），无匹配显示空状态提示。

### 15.3 消息迷你 Markdown 渲染
- 用户 / AI 消息经 `renderRichText()`（js/chat.js）渲染支持子集：``` 代码块、`行内代码`、
  **加粗**、*斜体*、- / 1. 列表、# ~ ### 标题；系统消息保持纯文本。
- **实现约束（安全）**：全部经 document.createElement / textContent 构造，零 innerHTML，
  与「消息文本零 HTML 拼接」的注入防护完全兼容；不渲染链接（避免钓鱼面）。
- 渲染后 `.msg-text` 的 textContent 为去标记的纯文本（如 `**x**` → `x`）。

### 15.4 AI 系统提示词（可选）
- 齿轮「模型」页新增 `#llm-system-prompt`（textarea，上限 2000 字），保存于 `fa_llm_settings_v1.systemPrompt`。
- 请求体 settings 透传（js/chat.js readLlmSettings）→ 服务端注入：chat-completions 协议在 messages
  头部插入 `{role:"system"}`；responses 协议使用顶层 `instructions` 字段。留空则不注入。

### 15.5 手工验收（已自动化实测）
备份 toast / 导入恢复（模块、消息、项目名）/ 搜索过滤与空态 / Markdown 各语法渲染 + XSS 防护 /
系统提示词保存与请求体透传 —— 全部通过（测试脚本 cdp-features.mjs，26 项）。

### 15.6 设置页 · 模型分组（2026-10-15）

「模型」设置从单套配置升级为**多分组**：一个 Base URL + 一个 API Key 构成一个分组，分组内维护多个模型名
（模型行左侧 ▼ 展开本组模型列表）。存储键不变，结构升级为 v2；旧 v1 形状读取时自动迁移为一个「默认分组」。

```js
// localStorage 键 fa_llm_settings_v1（v2）
{
  version: 2,
  activeGroupId: "g-…",
  groups: [{
    id: "g-…", name: "分组 1",
    baseUrl: "https://…", apiKey: "sk-…",
    protocol: "chat-completions" | "responses",
    model: "deepseek/deepseek-v4-flash",   // 当前选中模型
    models: ["…"],                          // 本分组模型列表（保存时当前模型自动并入）
    systemPrompt: ""                        // 上限 2000 字
  }]
}
```

- 公共读写/解析函数在 `Store.llmSettings`（js/store.js）：`read()`（读 + 规范化）、`write(norm)`、
  `normalize(raw)`（含 v1→v2 迁移与脏数据容错）、`resolve(raw)`（→ 请求体 settings，全空返回 null）、
  `clear()`、`activeGroup(norm)` / `addGroup(norm, name)` / `removeGroup(norm, groupId)` /
  `updateGroup(norm, groupId, fields)`。
- 请求体透传语义不变：js/chat.js `readLlmSettings()` 改为经 `Store.llmSettings.resolve` 解析当前激活分组；
  服务端注入逻辑（chat-completions → system 消息 / responses → instructions）不变。
- 新增 DOM（设置弹窗内动态创建，id 引用用单引号，不进 index.html）：`#llm-group-select`（分组下拉）、
  `#llm-group-add`（＋新建分组）、`#llm-group-remove`（删除当前分组）、`#llm-model-toggle`（▼ 模型列表按钮）、
  `#llm-model-menu`（列表弹层）；`#llm-model`、`#llm-base-url`、`#llm-api-key`、`#llm-protocol`、
  `#llm-system-prompt` 沿用原 id。新增样式类（css/workspace.css 末尾追加分区）：`.settings-group-row`、
  `.model-picker`、`.model-caret-btn`、`.model-menu`、`.model-menu-item`、`.model-menu-empty`（展开态用 `.is-open`）。
- 行为：点「保存」写当前分组字段（当前模型自动并入 `models`）；切换/新建/删除分组前先静默落盘当前表单；
  只剩 1 个分组时拒绝删除（用「清除」恢复默认，回到服务端 .env）；模型列表为空时弹层显示提示文案。
- 测试：tools/test-llm-settings.js（node，vm 加载 store.js + localStorage stub）：v1 迁移 / 分组增删改查 /
  模型自动并入 / 脏数据容错 / clear 后 resolve 为 null。

### 15.7 设置页 · 测试连通（2026-10-15）

- 「模型」页操作区新增「测试连通」按钮 `#llm-test-btn`（quiet-button，动态创建 id 单引号引用）。
- 点击后用**表单当前值**（未保存也生效；留空字段省略 → 回落服务端 .env）请求同源
  `POST /api/ai/test`，由服务端以最小消息（「连通性测试：请只回复 pong」，20s 超时）实调上游；
  结果写入 `#llm-settings-status`：✓ 显示延迟与模型名（有回复时附回复摘录）；✗ 显示失败原因。
- 服务端契约（server.js `handleAiTest`）：配置解析与 `/api/ai/chat` 完全一致（resolveModelConfig +
  credential 回落）；无 Key → 503；上游 4xx → 400；网络失败 / 上游 5xx / 空回复 → 502；
  成功 → 200 `{ ok, latencyMs, model, protocol, reply }`。
- 联网口径：js/sidebar.js 因此获准发起该**同源**接口的 fetch（check-contract.js `FETCH_ALLOWED`
  扩展一项）；其余联网规则不变（前端零第三方直连）。


## 16. 环节文档（2026-10-14）

为每个流程模块增加一份「环节文档」：用户与 AI 协商出的**标准格式文档**，既是该环节的产出物，
也是**环节间契约**（下游环节据此对接），可人工审核。设计原话：『执行之前得结构化成一个标准格式的文档』
『每个环节都文档化了』。此章节为 T2（文档区 UI）/ T3（执行内核）的对接依据。

### 16.1 数据结构（`module` 新增可选字段 `doc`）

```js
module.doc = null | {
  content: "非空字符串",        // 已 trim；长度 ≤ MAX_DOC_CHARS（20000）
  status: "draft" | "approved", // 审核状态；非法值一律按 "draft"
  updatedAt: "2026-10-14T02:00:00.000Z", // 最后写入时间（ISO）
  approvedAt: "2026-10-14T02:00:00.000Z" | null // 审核通过时间；draft 时恒为 null
}
```

- 无文档时 `doc === null`（**不是** undefined）。手工新建的模块、`initFlowModules()` / `addModule()`
  新建的模块 `doc` 初始即为 `null`。
- **刷新必须保留**：`normalizeModule()` 已把 `doc` 纳入归一化（与 `step` / `spec` / `status` / `approvedAt`
  同级）。空 content、超长 content、非法结构一律降级为 `null`；`draft` 时强制 `approvedAt = null`，
  保证「落盘 → 读取」幂等。

### 16.2 新增 API（照抄调用，全部同步）

```js
Store.saveDoc(moduleId, content)  // -> doc 深拷贝 | null
                                  //    content 非字符串 / trim 后为空 / 长度 > 20000 -> null（状态不变）
                                  //    首次创建 doc{status:'draft', approvedAt:null}
                                  //    已存在则覆盖 content，并把 status 打回 'draft'、approvedAt=null
                                  //    模块不存在 -> null
Store.approveDoc(moduleId)        // -> true | false（无 doc 或模块不存在 -> false）
                                  //    置 status='approved'、approvedAt=now、updatedAt=now
Store.rejectDoc(moduleId, note?)  // -> true | false（无 doc 或模块不存在 -> false）
                                  //    置 status='draft'、approvedAt=null
                                  //    note 去首尾空白后非空时，向该模块消息流追加一条
                                  //    system 消息：'文档打回：' + note
Store.LIMITS.MAX_DOC_CHARS        // 20000
Store.LIMITS.DOC_STATUSES         // ['draft','approved']
```

- 返回 `doc` 均为**深拷贝**（可随意修改/保存，不影响内部状态）。
- 空内容、超长返回 `null` 属于**正常校验失败**（非异常），由 UI 层给出提示。

### 16.3 新增事件

| type | payload | 触发时机 |
|---|---|---|
| `doc:save` | `{ moduleId, doc, created }` | `saveDoc()` 成功且状态未变更后（`created` 区分首次建/改稿） |
| `doc:approve` | `{ moduleId, doc }` | `approveDoc()` 成功后 |
| `doc:reject` | `{ moduleId, note, doc }` | `rejectDoc()` 成功后（`note` 为 trim 后文本，可能为空串） |

> 对应 `Store.EVENT.DOC_SAVE` / `DOC_APPROVE` / `DOC_REJECT` 常量。

### 16.4 审核语义（状态机）

```
        saveDoc                approveDoc
 (null) ---------> draft  ----------------> approved
                     ^                         |
                     |        rejectDoc(note)  |
                     +------------------------ +
```

- 状态只有 **draft / approved** 两种（与模块 `status` 的四态状态机相互独立，互不联动）。
- **改稿即打回**：任何一次 `saveDoc`（哪怕是已通过后再编辑）都会把状态重置为 `draft` 并清空 `approvedAt`，
  需重新走审核 —— 保证「已通过的文档」永远是当前所见版本。
- **打回附带说明**：`rejectDoc` 的 `note` 非空时写入该模块的消息流（`role:'system'`），
  T2 的消息列表会渲染成系统气泡，形成可追溯的审核记录。

### 16.5 上限与容错

- **单份文档上限 20000 字**（`MAX_DOC_CHARS`，与单条消息 `MAX_MESSAGE_CHARS` 同量级）：
  超长返回 `null`，由 UI 提示；避免超长文档撑爆 localStorage 配额（配额满会静默降级为纯内存，刷新即丢）。
- 归一化对空 content / 超长 content / 非法 `doc` 结构一律回退为 `null`，**绝不抛异常**。

### 16.6 手工/自动化验收

1. `node --check js/store.js` 通过。
2. `node tools/check-contract.js` 输出 `ALL_CHECKS_PASS`。
3. 逻辑测试（内存 stub localStorage 加载 store.js）：空内容 `saveDoc` → `null`；保存成功 `status==='draft'`；
   `approveDoc` 后 `approved`；再 `saveDoc` 回 `draft` 且 `approvedAt===null`；`rejectDoc` 带 note 后该模块
   出现系统消息；非法 `moduleId` 全返回 `null`/`false`；>20000 字 → `null` —— 全部通过。


## 17. 服务端扩展端点（2026-10-14）

T3 新增两个端点，落地服务端能力节点：`/api/ai/compose`（环节文档 / 代码生成）与 `/api/code/exec`
（受限执行）。实现见 `server.js` 的 `handleCompose` / `handleExec`，**都先经过已有的
`checkRequestGuards`**（Host 本机校验 + Origin 同源校验 + 每分钟 30 次限流，见 §14），未通过返回
403 / 429，语义与既有 `/api/ai/chat` 一致。模型配置解析已抽为公共函数 `resolveModelConfig`，
`handleChat` 与 `handleCompose` 复用，优先级：请求体 `settings` > 服务端 `.env`。

### 17.1 POST /api/ai/compose

**入参**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mode` | `'doc' \| 'code'` | 是 | `doc`=生成《环节标准文档》；`code`=生成单文件 node 脚本。其它值 → 400 |
| `module` | object | 否 | `{ name, spec:{goal,todo[],output,acceptance}, doc? }`；`doc` 可为字符串或 §16 的 `{content}`。用于拼提示词 |
| `messages` | array | 否 | `[{role:'user'\|'assistant', text}]`，即对话记录；沿用 `normalizeMessages` 归一化 |
| `settings` | object | 否 | `{baseUrl, model, apiKey, protocol, systemPrompt}`，规则同 `handleChat` |

**提示词模板**：内嵌于 `server.js` 常量 `COMPOSE_DOC_TEMPLATE` / `COMPOSE_CODE_TEMPLATE`。
`doc` 模式要求模型输出四个固定二级小节（`## 环节目标` / `## 输入与数据说明` /
`## 处理与验收标准` / `## 注意事项`）；`code` 模式约定脚本读工作目录 `input` 文件、结果写
`output` 文件、零第三方依赖、无网络请求。

**出参**

| 状态 | 响应 | 语义 |
|---|---|---|
| 200 | `{ text: string }` | 模型输出（已 trim） |
| 400 | `{ error }` | JSON 非法 / body 非对象 / `mode` 非法 / 上游 4xx |
| 503 | `{ error }` | 无 API Key（未传且环境未配 `AI_API_KEY`） |
| 502 | `{ error }` | 无法连接上游 / 上游 5xx / 空回复 |
| 500 | `{ error:'服务端内部错误' }` | 兜底异常 |

> 上游错误语义与 `/api/ai/chat` **完全一致**。
> **超时**：compose 的上游调用超时为 **180s**（生成代码属长输出任务；对话端点 `/api/ai/chat` 保持 60s）——2026-10-14 E2E 实测修复。

### 17.2 POST /api/code/exec

**入参**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `lang` | `'node' \| 'python'` | 是 | 白名单外（如 `ruby`）→ 400 |
| `code` | string | 是 | 非空脚本源码 |
| `confirm` | `true` | 是 | **必须严格等于 `true`**，否则 400（防误触发） |

**出参**（仅在执行真正发生后返回）

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | 脚本退出码为 0 时为 `true` |
| `stdout` / `stderr` | string | 各截断至 20KB，发生截断时末尾追加 `[已截断]` |
| `artifacts` | `[{name,size}]` | 工作目录内除脚本文件外的产物文件 |
| `dir` | string | 本次执行的临时目录（`os.tmpdir()/yanxu-exec-<随机>`） |
| `ms` | number | 执行耗时（毫秒） |
| `code` | number \| null | 退出码（超时或被信号终止时可能缺省） |
| `error` | string | 仅失败时出现 |

**错误 / 特殊语义**

| 状态 | 场景 | 响应 |
|---|---|---|
| 400 | `confirm` 非 `true` | `{ error:'拒绝执行：必须显式传 confirm:true …' }` |
| 400 | `lang` 非法 | `{ error:"lang 必须是 'node' 或 'python'。" }` |
| 400 | `code` 为空 | `{ error:'code 必须是非空字符串。' }` |
| 400 | python 解释器找不到 | `{ error:'本机未找到 python 解释器（已尝试 python / python3 / py）。' }` |
| 200 | **执行超时（> 15s）** | `{ ok:false, error:'执行超时', … }`（**200 而非 5xx**：进程被正常收管，属业务结果） |
| 200 | 脚本非零退出 | `{ ok:false, error:'执行失败（退出码 N）', … }` |

> **注意**：超时与脚本报错都以 **HTTP 200 + `ok:false`** 返回，调用方应以 `ok` 判断成败，
> 不要用 HTTP 状态码区分。

### 17.3 安全边界（执行内核）

本端点产品需求即「AI 生成的代码在本机跑」，因此防护是**多层叠加**而非拒绝执行：

1. **本机 Origin 校验**（`checkRequestGuards`，已有）：第三方来源（如 `http://evil.example.com`）
   一律 403，恶意网页无法借本机服务执行代码；
2. **`confirm` 显式确认**：`body.confirm !== true` 直接 400，防误触发 / 防被顺手调度；
3. **临时目录隔离**：每次执行在 `os.tmpdir()` 下新建 `yanxu-exec-<随机>` 目录并以其为 cwd，
   不污染项目目录，脚本与产物均落在该目录；
4. **语言白名单**：仅 `node` / `python`；python 解释器按 `python` → `python3` → `py` 探测
   （探测结果以 Promise 缓存），探测不到直接 400；
5. **15s 超时 SIGKILL**：防死循环 / 长任务占满本机；
6. **输出截断 20KB**：stdout / stderr 各自截断并加 `[已截断]`，防超大输出打爆内存与响应体；
7. **spawn argv 直传**：不拼 shell 字符串，杜绝命令注入。

> **残余风险（明示）**：脚本以当前用户权限运行，仍可读写该用户可访问的文件、发起网络请求
> （约定禁止但未强制沙箱）。若需强隔离，应在更外层引入容器 / 低权限账户。

### 17.4 自动化验收

`node tools/test-server-exec.js`（node 直跑，起 `server.js` 子进程 `PORT=8199`，零依赖）覆盖：
exec 正常 / 产物 artifacts / 超时 kill / 输出截断 / confirm 缺失 400 / lang 非法 400 /
第三方 Origin 403 / compose 无 key 503 / python 执行（解释器可用时），全通过输出
`ALL_EXEC_TESTS_PASS`。实测本机 17 项通过 / 0 失败（含 python 路径）。


## 18. 执行记录与结果确认（2026-10-14）

为每个流程模块增加一份「执行记录」`run`：记录本次运行的结果（状态 / 时间 / 工作目录 / 产物），
并引入**结果确认门**与**三级归因打回**。设计原话：『数据一旦出错后面全白干，结果必须人确认』。
此章节为 W2（服务端 exec 落库）/ W3（前端结果确认 UI）的对接依据。

### 18.1 数据结构（`module` 新增可选字段 `run`）

```js
module.run = null | {
  status: "ran" | "confirmed",   // ran=已运行待人工确认；confirmed=人工已确认；非法值一律降级为 null
  at: "2026-10-14T02:00:00.000Z",// 本次运行时间（ISO）
  dir: "…/yanxu-exec-xxxx",      // 执行产物所在目录；缺省为空串
  artifacts: [ { name: "out.csv", size: 1024 } ] // 产物清单；size 非有限数字按 0
}
```

- 无记录时 `run === null`（**不是** undefined）。手工新建的模块、`initFlowModules()` / `addModule()`
  新建的模块 `run` 初始即为 `null`。
- **刷新必须保留**：`normalizeModule()` 已把 `run` 纳入归一化（与 `doc` / `step` / `spec` / `status`
  同级）。缺 `status`、`status` 非法、结构非法一律降级为 `null`；`artifacts` 仅保留合法的
  `{name,size}` 项，保证「落盘 → 读取」幂等。

### 18.2 新增 API（照抄调用，全部同步）

```js
Store.markRun(moduleId, info)     // -> run 深拷贝 | null（模块不存在 -> null）
                                  //    info = { dir?, artifacts? }（均可选）
                                  //    置 status='ran'、at=now；dir 非字符串按 ''，artifacts 仅留合法 {name,size}
                                  //    无论此前有无 run 都覆盖（再次执行即重新进入待确认）
Store.confirmRun(moduleId)        // -> true | false（无 run 或 status!=='ran' 或模块不存在 -> false）
                                  //    置 status='confirmed'
Store.rejectRun(moduleId, cause, note?) // -> true | false
                                  //    cause 仅接受 'data' | 'code' | 'doc'，否则 false；无 run 或模块不存在 -> false
                                  //    成功：run 清空（=null），并向该模块消息流追加一条 system 消息
                                  //         '结果复核打回（归因：数据/代码/标准）'
                                  //         （note 去首尾空白后非空时追加 '：' + note）
Store.LIMITS.RUN_STATUSES         // ['ran','confirmed']
```

- 返回 `run` 均为**深拷贝**（可随意修改/保存，不影响内部状态）。
- 校验失败返回 `null` / `false` 属于**正常结果**（非异常），由 UI 层给出提示。

### 18.3 新增事件

| type | payload | 触发时机 |
|---|---|---|
| `run:mark` | `{ moduleId, run }` | `markRun()` 成功后 |
| `run:confirm` | `{ moduleId, run }` | `confirmRun()` 成功后 |
| `run:reject` | `{ moduleId, cause, note }` | `rejectRun()` 成功后（`note` 为 trim 后文本，可能为空串） |

> 对应 `Store.EVENT.RUN_MARK` / `RUN_CONFIRM` / `RUN_REJECT` 常量。

### 18.4 状态机与三级归因语义

```
        markRun                confirmRun
 (null) ----------> ran  ----------------> confirmed
                     |
                     |  rejectRun(cause, note)
                     +------------------------> (null)（打回，归因写入系统消息）
```

- **确认门**：`ran` 只表示「跑完了」，产物未经人工确认；只有 `confirmRun` 置 `confirmed` 才算通过。
  「结果必须人确认」——避免错误结果流入下游环节（数据一旦出错后面全白干）。
- **三级归因**（`cause`）决定问题回溯到哪一环，是「打回即定位责任环节」的关键：

  | cause | 中文 | 语义 |
  |---|---|---|
  | `data` | 数据 | 输入数据有问题（缺失 / 异常 / 单位 / 去重不当） |
  | `code` | 代码 | 处理脚本有问题（算法 / 参数 / 单位换算等实现偏差） |
  | `doc`  | 标准 | 环节标准文档（§16 `doc`）描述不清 / 定义有误，需先改文档 |

- **打回即清空**：`rejectRun` 成功后 `run` 置 `null`（回到未执行态），并写入一条系统消息，
  W3 的消息列表会渲染成系统气泡，形成可追溯的复核记录。
- 与模块 `status`（§12 四态）、`doc.status`（§16 draft/approved）**相互独立**，互不联动。

### 18.5 手工/自动化验收

1. `node --check js/store.js` 通过。
2. `node tools/check-contract.js` 输出 `ALL_CHECKS_PASS`。
3. 逻辑测试（内存 stub localStorage 加载 store.js）：
   `markRun` 后 `run.status==='ran'`；`confirmRun` 后 `confirmed`；再次 `markRun` 覆盖回 `ran`；
   `rejectRun('code','单位换算导致偏差')` 后 `run===null` 且该模块出现系统消息「归因：代码」；
   非法 `cause`（如 `'other'`）→ `false`；无 `run` 时 `confirmRun` 与 `rejectRun` 都返回 `false`；
   重新加载（模拟刷新）后 `run` 保留 —— 全部通过。


## 19. 服务端扩展 v2（2026-10-14 · W2）

在 §17 两个能力节点之上做四项扩展，落地「数据清洗闭环（数据进 / 结果审 / 归因）」的服务端一半。
实现见 `server.js`，W3（前端）按本章冻结接口调用。

### 19.0 全局：请求体上限

`MAX_BODY_BYTES` 由 **64KB → 2MB**（**全端点统一**：`/api/ai/chat`、`/api/ai/compose`、`/api/code/exec`）。
超限时 `readBody` 提前 reject，端点返回 `400 { error }`（文案为「请求必须是有效 JSON，且大小不超过 2MB。」）。
抬高上限是为让 exec 能携带数据文件；真正的大小约束由 §19.2 的业务校验负责。

### 19.1 `/api/ai/compose` 新增 `template`

**入参**（在 §17.1 基础上新增一个可选字段）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `template` | `'standard' \| 'align' \| 'mining'` | 否 | 缺省 `'standard'`；其它值 → `400 { error:"template 必须是 'standard'、'align' 或 'mining'。" }` |

其余字段（`mode` / `module` / `messages` / `settings`）与出参语义**完全不变**（§17.1）。

**模板常量（`server.js` 内嵌）与选择规则**

| mode | template | 使用的提示词常量 | 期望产出 |
|---|---|---|---|
| `doc` | `standard` | `COMPOSE_DOC_TEMPLATE` | 通用《环节标准文档》（四小节，同 §17.1） |
| `doc` | `align` | `COMPOSE_ALIGN_TEMPLATE` | 《数据对齐规则文档》：`## 对齐目标与范围` / `## 维度与口径映射` / `## 对不上时的系数拆分方案` / `## 校验与验收标准` |
| `doc` | `mining` | `COMPOSE_MINING_TEMPLATE` | 《文献参数挖掘规则文档》：`## 挖掘目标与输入` / `## 参数表结构（字段定义）` / `## 提取规则与来源定位` / `## 质量控制与验收标准` |
| `code` | `standard` | `COMPOSE_CODE_TEMPLATE` | 通用单文件脚本（读 input、写 output，同 §17.1） |
| `code` | `align` | `COMPOSE_CODE_ALIGN_TEMPLATE` | 对齐脚本：读输入数据与对齐参考表 → 写 `aligned.csv` |
| `code` | `mining` | `COMPOSE_CODE_MINING_TEMPLATE` | 挖掘脚本：遍历 `papers` 目录下论文文本 → 写 `params.csv`（首行表头） |

- `align` 的核心是**对不上时如何拆分系数**（一对多 / 多对一的按比例拆分、系数估计与优先顺序、无法对齐的兜底）。
- `mining` 的核心是**结构化参数表 + 提取规则**（字段定义表明确单位/类型/必填/缺失处理；来源定位到摘要/方法/结果/表格/图注；范围值与多值取值规则；不得臆造）。
- 校验顺序：`mode` 校验 → `template` 校验 → 无 Key 503，因此 `template` 非法时**即使无 Key 也返回 400**。

### 19.2 `/api/code/exec` 新增 `files`（数据文件）

**入参**（在 §17.2 基础上新增一个可选字段）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `files` | `[{ name: string, content: string }]` | 否 | 文本数据文件；执行前写入本次执行目录，脚本可用相对路径读取 |

**文件名净化（安全边界，必须遵守）**

对每个文件项：**只取 `path.basename(name)`**，再检查是否含 `..` / `/` / `\` 或为空名：

- 取 basename 后仍非法的（或 `name` 非字符串、`content` 非字符串）→ **丢弃该项**（不报错、不中断请求）；
- 结果保证只会落在执行目录内（例如 `../../etc/passwd` → `passwd`；`..\evil.txt` 在 Windows 上取 basename 得 `evil.txt`，在其它平台含 `\` 被丢弃）；
- 因此**任何情况下都不会写到执行目录之外**。

**大小限制**

| 限制 | 阈值 | 超限结果 |
|---|---|---|
| 单个文件（UTF-8 字节数） | ≤ 512KB | `400 { error:'单个数据文件不能超过 512KB：<name>' }` |
| `files` 总量（UTF-8 字节数） | ≤ 1MB | `400 { error:'数据文件总量不能超过 1MB。' }` |
| `files` 非数组 | — | `400 { error:'files 必须是数组。' }` |

> 大小校验按**字节数**（`Buffer.byteLength(content,'utf8')`）而非字符数。

**出参**：在原字段（§17.2）之外新增 `fallback: boolean`（见 §19.3）；`artifacts` 逻辑不变
（工作目录内除脚本文件外的文件，**上传的数据文件也会出现在其中**）。

### 19.3 `/api/code/exec` 执行目录策略（用户可见）

| 项 | 规则 |
|---|---|
| 根目录（base） | 优选环境变量 `YANXU_RUN_DIR`（非空时）；否则 `path.join(os.homedir(), 'yanxu-runs')` |
| 子目录名 | `<Date.now()>-<随机 6 位 base36>`（如 `1739520000000-a1b2c3`） |
| 创建失败回退 | base 递归创建或子目录创建失败时，回退 `os.tmpdir()` 下的 `mkdtemp('yanxu-exec-')` 目录 |
| 返回标注 | 出参 `dir` 为本次执行目录（语义不变）；`fallback: true` 表示走了 `os.tmpdir()` 回退，`false` 表示正常用户可见目录 |

- 目录策略只影响「产物落在哪」；`§17.3` 的其余安全边界（confirm / 语言白名单 / 15s 超时 / 20KB 截断 / argv 直传）全部不变。
- 执行目录**执行后不自动删除**（便于用户在文件管理器里查看产物）。

### 19.4 `/api/ai/chat` 新增 `module`（环节上下文注入）

**入参**（新增一个可选字段）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `module` | object | 否 | `{ name, spec:{goal,todo[],output,acceptance}, upstream:[{name, doc}] }`（各子字段均可选） |

**注入规则**（`module` 为普通对象时生效；缺省/非对象时**完全沿用旧行为**）

1. 最终 system 提示 = **环节上下文** + （如有）用户自定义 `settings.systemPrompt`，用 `\n\n` 连接；
2. 环节上下文首行固定为：
   `你正在支持科研流程环节「{name}」；本环节目标：{goal}；验收要点：{acceptance}。`
   （`name` 缺失显示「（未命名）」，`goal` / `acceptance` 缺失显示「（未填写）」）；
3. 若有 `upstream`，追加一节：
   ```
   【上游已确认产出摘要】
   - {上游 name}：{doc 摘要}
   - …
   ```
   其中 `doc` 支持字符串或 §16 的 `{ content }`；**每段截断至 400 字、全部合计截断至 1200 字**，超长处补 `…`；
4. 用户自定义 `settings.systemPrompt`（若填了）拼接在上述内容**之后**。

**协议兼容**：`chat-completions` 协议注入为 `messages[0] = {role:'system', content}`；
`responses` 协议注入为请求体 `instructions`。两条路径均通过既有的 `cfg.sysPrompt` 合成机制生效，
不新增分支。

> 无 `module` 且无 `systemPrompt` 时，请求体**不含** system/instructions —— 与 W1 之前的行为逐字一致。

### 19.5 自动化验收

`node tools/test-server-exec.js`（起 `server.js` 子进程 `PORT=8199`，`YANXU_RUN_DIR=$TMP/yanxu-test-runs` 保证隔离）新增：

- **[10]** 上传 `input.csv` → 脚本读取其内容写 `result.txt` → 产物内容正确；`dir` 位于 `YANXU_RUN_DIR` 下且 `fallback===false`；
- **[11]** `files` 名为 `..\evil.txt` 与 `../../evil2.txt` → 状态 200（sanitize）或 400（丢弃），且执行目录**上一层/上两层**均无 `evil.txt` / `evil2.txt`；
- **[12]** 单文件 600KB → 400；三文件合计 1.2MB → 400；
- **[13]** `template='bogus'` → 400；`template='align'` 有 Key 时 200、无 Key 时 503（不算失败）；
- **[14]** chat 带 `module` 且无 Key → 503 语义不变；
- **[15]** chat 带 `module` + 假 Key（`baseUrl` 指向未监听端口）→ 502（证明环节上下文构建未崩溃）。

全通过仍输出 `ALL_EXEC_TESTS_PASS`（实测 31 通过 / 0 失败，1 项 SKIP 视环境 Key 而定）。
## 20. 服务端扩展 v3（2026-10-14 · X1）

第三批服务端扩展：compose(code) 迭代反馈闭环、compose(diagnose) AI 自动定位、exec URL 下载
（含 SSRF 防护）、产物文本预览。实现见 `server.js`；纯函数 `isPrivateHost` / `buildComposePrompt` /
`buildDiagnosePrompt` / `parseDiagnoseJson` 经 `module.exports` 导出供测试 require
（`server.js` 已加 `require.main === module` 守卫：直接运行才监听端口，被 require 无副作用）。
零依赖原则不变。

### 20.1 compose(code) 迭代反馈（feedback）

**入参**新增可选 `feedback = { stderr?: string, note?: string }`（仅 `mode:'code'` 生效）：

- `stderr` 截**尾部 2000 字**、`note` 截前 1000 字，拼接进 code 提示词尾部：
  `【上一轮执行失败信息（stderr）】…`、`【上一轮人工反馈】…`，并追加固定一句
  「本次生成的代码必须避免上述问题。」；
- `feedback` 缺省时提示词与旧行为**逐字一致**；
- 另从 `messages` 原始数组扫描**最近 3 条** `role:'system'` 且以「文档打回：」或
  「结果复核打回：」开头的消息（每条截 500 字），以 `【上轮反馈线索】` 段注入提示词——
  **doc 与 code 模式均生效**（文档打回后重生成文档时也要看到打回理由）；
- system 消息仅作为线索扫描，仍**不进**【对话记录】（`normalizeMessages` 防提权规则不变）。

**出参**不变（`{ text }` / 400 / 503 / 502 / 500，语义同 §17.1）。

### 20.2 compose(diagnose) AI 自动定位

**入参** `{ mode:'diagnose', module?:{name,spec}, doc?:string|{content}, code?:string,
exec?:{ok, stderr?, artifacts?}, issue?:string }`（除 `mode` 外全可选；`exec.stderr` 截尾部 2000 字）。
提示词要求模型**只输出一个 JSON**：`{"level":"data|align|code","reason":"推断理由(≤150字)"}`。
三级含义：`data`=数据本身问题 / `align`=对齐或标准文档问题 / `code`=生成的代码问题。

**出参**：

| 响应 | 条件 |
|---|---|
| `{level, reason}` | 服务端解析成功（容忍 ` ```json ` 围栏与前后杂质文本，取 `{…}` 片段 parse；`level` 必须 ∈ data/align/code 且 `reason` 为非空字符串） |
| `{text}` | 解析失败 → 原样输出，前端降级为普通文本展示 |

错误语义（400 / 503 / 502 / 500）与 doc/code 模式完全一致；上游超时同为 300s。

### 20.3 exec URL 下载（urls）

`/api/code/exec` 入参新增可选 `urls = [{ name?, url }]`（与 `files` 并存；非数组 → 400，
单项结构非法丢弃）。每条 URL **独立处理，单条失败不影响其余**：

1. 协议仅 `http` / `https`，否则该条失败（error 注明协议）；
2. **SSRF 防护**：hostname 命中私网 → 该条失败（error 含「SSRF」）。判定抽为导出纯函数
   `isPrivateHost(hostname)`，规则：`localhost`（含 `*.localhost`）、`*.local`、`0/8`、`10/8`、
   `127/8`、`169.254/16`（链路本地）、`172.16/12`、`192.168/16`、`::1`、`::`、`::ffff:` 映射 IPv4；
   非法点分（缺段 / 段>255）宁拒勿漏；
   **测试例外**：环境变量 `YANXU_ALLOW_PRIVATE_HOST=1` 时放行私网（仅供测试下载本机静态文件，
   生产环境勿设）；
3. 单文件 ≤512KB（边收边限量，超限该条失败）；30s 超时；非 2xx 该条失败；
4. `name`：优先用传入 `name`（与 files 同 sanitize 规则），否则取 URL path 的 basename
   （同 sanitize；URL 解析后立即确定，失败条目也尽量携带）；
5. 下载文件写入本次执行目录（与 files 同目录），脚本可直接读取。

**出参**新增 `downloaded: [{ name, ok, size?, error? }]`（仅 urls 非空时出现；
ok=true 带 `size`，ok=false 带 `error`）。

> **残余风险（明示）**：`isPrivateHost` 只做 hostname 字面判断，不做 DNS 解析校验——
> 公网域名解析到私网 IP（DNS rebinding）不在防护范围内；重定向（redirect: follow）后的
> 目标地址也不再复检。强对抗场景应在外层加出口代理 / 防火墙策略。

### 20.4 产物预览（preview）

exec 返回前，对 `artifacts` 中扩展名 ∈ {`.csv`, `.txt`, `.json`, `.md`} 且 ≤200KB 的文件，
读**前 50 行**、截 **10KB**（超出补「…」）填入 `preview` 字段；其余文件（二进制 / 超大 /
读取失败）不带 `preview`。纯展示用途，不参与执行。

### 20.5 自动化验收

`node tools/test-server-exec.js` 新增 [16]–[22]：

- **[16]** compose(code) feedback 注入：mock 上游（127.0.0.1:8198）抓取真实提示词，断言含
  stderr 片段、「文档打回：」/「结果复核打回：」线索与固定收尾句；`buildComposePrompt`
  纯函数直验；system 消息不进【对话记录】；
- **[17]** feedback 缺省 / 无打回线索 → 提示词不含任何新增段（行为不变）；doc 模式有打回线索时也注入；
- **[18]** `isPrivateHost` 纯函数：localhost/127.x/10.x/192.168.x/172.16-31.x/::1/0.0.0.0/
  *.local/非法 IP → true；github.com/8.8.8.8/172.32.0.1 → false；
- **[19]** diagnose：mock 返回合法 JSON → `{level, reason}`；非 JSON / 非法 level → `{text}`；
  围栏容忍纯函数直验；
- **[20]** urls：localhost / 10.x 默认拒绝（error 含 SSRF）、`ftp:` 该条失败、单条失败不影响
  执行、urls 非数组 → 400；
- **[21]** `YANXU_ALLOW_PRIVATE_HOST=1`（第二实例端口 8201）：下载 server 公开资产
  `/js/auth-config.js`（size 与源文件一致、真实写入执行目录、脚本可读）+ 404 条目失败其余继续 +
  600KB 条目超 512KB 失败（mock `/big.txt`）；`/package.json` 仍不对外公开；
- **[22]** artifacts preview：out.csv 多行内容正确、60 行截到 50 行、`.bin` 无 preview。

全通过仍输出 `ALL_EXEC_TESTS_PASS`（实测 76 通过 / 0 失败，1 项 SKIP 视环境 Key 而定）。
# 2026-10-14 补充：设置中的本机 Codex 登录

`POST /api/codex/login` 启动 app-server 官方 ChatGPT 浏览器登录；已有登录状态时返回 `{loggedIn:true}`，未登录时返回 `{loggedIn:false,authUrl}`，完成或失败通知后释放待登录状态。沿用本机 Host、Origin 与工作台请求头保护。凭据由 Codex 保存，浏览器只接收官方登录 URL 与连接状态。

连接控件 `codex-connection` 默认隐藏，首次打开“设置 → 模型”时由 sidebar.js 移入模型设置页。登录、检查连接、后端与模型选项由 CodexUI 管理；后端/模型仍按模块保存，未选择模块时更新新模块的默认值（`fa_codex_connection_v1`）。主模块面板保留文件与执行按钮，不显示登录和模型配置。

`POST /api/ai/compose` 可选 `backend:'codex'` 与 `codexModel`，只读生成文档/代码或诊断文本，继续使用现有模板、反馈和返回结构。生成的代码仍经过原人工确认与执行接口；没有自动执行。`CodexUI.getModel(mod)` 返回当前模块的模型。
# 环节与规则模板对应（2026-10-14）

下载模块使用下载方案；清洗模块使用清洗规则或数据对齐规则；直接计算使用现有代码运行说明，修改计算使用计算修改方案；文献挖掘默认使用参数提取模板；核查使用核查原则。通用历史模块仍保留原三种模板。只有一种适用模板时显示其名称，不出现选择框。

compose 请求的 module 增加可选 type/mode/doc，服务端按真实模块类型添加职责约束；代码生成沿用该模块所选模板和已审核文档。直接计算不提供生成新代码入口，运行现有代码继续使用原按钮。既有 doc、规则历史和执行记录不作结构迁移。

# 数据下载执行与清洗交接（2026-10-14）

下载模块支持确认规则或审核下载方案后打开下载弹窗，填写公开 HTTP(S) 文件地址与文件名，明确点击“开始下载”。原始文件保存到当前任务 input，每个文件上限 20MB，最多 5 个地址；不修改内容、不执行用户代码。下载记录保存规则文本、来源、大小、SHA-256 和成功/失败状态。跳转、域名解析、大小和超时均受限；需要登录/检索的网页须另行确定获取方式。

`POST /api/codex/fetch-source`：`{sessionId, rules, source:{url,name}, confirm:true}`，返回文件及记录。`POST /api/codex/import-input`：`{sessionId, sourceSessionId, names, confirm:true}`，复制选中的原始文件到清洗 input。两者沿用工作台同源与请求头保护。后端下载无需模型登录，AI 对话仍需要配置模型。

下载完保留待确认状态；点击“确认文件并进入清洗”才导入下游并记录确认。允许部分失败后重新下载，已有成功文件与日志保留。清洗模块以最近确认交接的批次为当前输入，历史原始文件保留但不自动合并；研究者补传的文件加入当前批次。已下载不等于年份、范围等科学条件自动验收通过。

下载优先使用 `SOURCE_DOWNLOAD_PROXY` 或协议对应的 `HTTPS_PROXY`/`HTTP_PROXY`，Windows 未指定时读取已启用的系统 HTTP 代理。代理隧道连接经校验的源 IP，HTTPS 仍校验证书；不将代理信息写入下载记录。

# 审核方案后的文献获取小流程（2026-10-14）

`tools/literature-flow.js` 编排已审核方案 → 执行方案解析 → Europe PMC/Crossref 检索 → 筛选 → 获取开放全文或研究者上传材料 → 带出处提取 → 人工核查。首批最多 20 条候选、3 篇全文；不是全量综述检索。不获取受限全文、不以摘要冒充全文数据。方案缺关键要求、获取失败或证据不明确时进入 waiting，保留问题、进度和部分产物，研究者答复后续跑当前步骤。材料中的指令按不可信来源处理。原始方案冻结并记录哈希，变更后须重新审核并新开运行；科学规则的补充答复记录为 decisions。

新增同源接口：`POST /api/codex/literature/start {sessionId,plan:{content,status:'approved'},confirm:true,backend?,model?,credential?,settings?}`；`GET /api/codex/literature/status?session=…&id=…`；`POST /api/codex/literature/resume {sessionId,id,plan,answer,paperDecisions?:[{paperId,inputName?,skip?}],confirm:true,…模型配置}`；`POST /api/codex/literature/cancel {sessionId,id}`。模型配置只在内存中使用，不写入运行记录。状态为 running/waiting/failed/cancelled/completed，stage 为 plan/search/screen/acquire/extract/review；状态与 checkpoint 落盘，服务重启时可继续，原件与历史结果不覆盖。completed 表示产物已生成、待人工核查，不自动批准数据。

新增 `js/literature.js`，导出 `window.LiteratureUI={render,isBusy,context}`；独立 DOM section 动态挂在 Codex 面板之后、module-space 之前。仅对 download-data/literature-mining 显示。后端按模块存储运行标识的新键 `research_literature_runs_v1`，不迁移或覆盖旧任务数据。审核后主按钮“按审核方案开始执行”；等待时提供答复框、上传材料关联及显式跳过选项，按钮“提交答复并继续”；运行可停止，刷新恢复。材料上传使用原 upload 路由的新增 `material` 组（PDF/XML/TXT/MD/CSV/TSV/XLSX），不作为清洗输入自动合并。原链接下载改为辅助入口。数据 CSV 的字段含 paper_id、field、value、unit、conditions、source_file、location、quote、status；quote 必须对应实际材料位置，数值无证据时留空并标为需讨论。清洗交接只复制提取 CSV，原材料与出处记录仍保留。

新增 `tools/material-reader.py` 用已有 Python 读取 XML、文本、CSV/TSV/XLSX/PDF；PDF 使用已有 pypdf/pdfplumber/PyMuPDF 之一，无库/扫描件/超限时明示问题，不自动安装或偷偷截断。新增 `.literature-panel` 系列样式与 script 接线。自检仍用 check-contract.js，新增 tools/test-literature-flow.js 验证检索获取、证据、等待续跑、重启与版本约束。

CodexUI 增加 `session(id) / refresh(id) / getConnection(mod) / setInputBatch(id,batch)` 供文献编排面板复用原文件会话和模型配置；LiteratureUI 增加 start(mod)。import-input 增加可选 sourceGroup:'input'|'output'（默认 input），允许把已人工核查的提取 CSV 交给清洗。脚本顺序在 codex.js 后增加 literature.js；check-contract.js 同步登记新 UI 文件、全局对象与同源 fetch 白名单，其他校验不变。

CSV 另含 paper_title/doi/source_url，由服务端来源记录填写，不要求这些元数据出现在正文数值证据中。fields 仅列测量变量，单位、实验条件、论文信息和定位状态使用已有元数据列；解析时规范这些标准字段。allowMissing 仅在审核方案/明确答复允许缺失留空时生效，缺数值不得自动补零。问题历史、提取版本与各阶段模型配置记入运行记录；最新 CSV 是便于交接的别名，不删除之前版本。

下载模块顶栏显示当前获取方案的审核状态，“查看方案”定位到本模块文档卡片；普通对话以当前已审核方案作为依据。旧下载规则历史仍保留，供旧直链任务核查使用；其他模块的规则弹窗与版本不变。

# 2026-10-15 上游 Scholar 合并

合入 origin/main 1499524 的文献配置、Scholar 连接器、候选导出、手动验证续查、Python 最小环境及 macOS CLI 路径支持。保留本地设置登录、已审核方案执行、Europe PMC/Crossref、材料读取、证据验证、问题续跑与清洗交接。`/api/literature/*` 专供只发现候选；`/api/codex/literature/*` 保持完整执行，两者共享 ScholarConnector（server.js 的 scholar 变量），不混用 job id。

tools/scholar-flow.js 将完整方案中的 google-scholar 查询交给上游连接器并读取 candidates.json；将冻结运行配置、检索时间、来源与候选文件复制进本批输出。完整流程先按方案筛选，再获取 PDF/XML 或等待上传，搜索片段字段只存 snippet，不冒充摘要或全文证据。captcha 时保存当前 Scholar job id 和配置；人工完成后点“验证后继续执行”，仅对未变更配置读取当前结果页，其他来源不被默默替代。source 支持 europepmc/crossref/google-scholar；每源每检索式最多10条，总候选上限20，全文仍最多3篇。未明确要求 Scholar 的既有方案不自动切来源。文献挖掘模块原上游“从对话整理规则/手动填写/确认配置并检索”折叠为“只找候选文献”，不要求完整方案审核；完整获取依然需要已审核方案。

归档文件不可覆盖；同一已完成查询续跑时核对文件一致性并复用，不重新写只读配置。候选规则整理沿用模块所选 Codex 模型，不强制切到其他模型。tools/test-scholar-flow.js 用模拟检索与材料验证真实连接器 → 验证等待/续跑 → 全文 → 引文校验 → 归档复用；不依赖在线 Scholar 或模型额度。


## 21. 文献挖掘·第二阶段（2026-10-15 · D1c 冻结，W1a/W1b 接线依据）

第二批文献挖掘扩展：把「首批候选检索」连接器升级为六阶段流水线（`discover` 候选检索 → `dedupe` 跨来源归并 → `fulltext` 全文获取 → `extract` 可追溯提取 → `validate` 校验 → `export` 文献表/参数明细表），并在全文提取前增设「研究者确认字段含义与单位」硬关口。完整设计（阶段脚本 CLI、中间 JSON、任务目录树、SOC 复用映射、校验规则、任务切分）见 `docs/literature-mining-stage2-design.md`；本章只冻结**网页接口层**契约。§1–§20 全部保持不变，本章为纯增量。

### 21.1 阶段与状态机

- `job.status` 仍为 5 值：`running / needs_attention / completed / failed / cancelled`，**不新增取值**。
- `job.stage` 词汇表扩展：新增 `dedupe / fulltext / extraction / validation / export / awaiting_confirmation`；原值（`queued/environment/browser/search/save/verification/failed/completed/cancelled/interrupted`）全部保留。
- 人工关口：字段确认复用 `status=needs_attention`，用 `stage="awaiting_confirmation"` 与验证码关口 `stage="verification"` 区分；前端按 stage 渲染不同操作（验证按钮 / 字段确认表单）。
- 新人工关口的产品口径不变：验证码仍交人工、不自动绕过；字段确认仍以研究者确认为准，不把 AI 建议当已确认科学规则。

### 21.2 API 契约

#### 21.2.1 POST /api/literature/search（扩展）

- 入参：`{ config, resumeCurrent?, until? }`。
- `until` 可选，取值 ∈ `discover|dedupe|fulltext|extract|validate|export`；**缺省 `discover`**，与第一阶段行为逐字一致；非法值在创建任务前 400『阶段边界必须是 discover–export 的有效阶段名』。
- 其余校验、并发守卫、错误文案全部不变（不回归清单见设计文档 §10）。

#### 21.2.2 POST /api/literature/advance（新增）

- 入参：`{ id, until?, confirmations? }`：
  - `id`：36 位任务 id；
  - `until`：可选，缺省 `export`（跑到流水线末尾或下一个硬关口）；
  - `confirmations`：可选，`{ fields: [ …fieldDefinitions 结构… ] }`，仅在 `stage="awaiting_confirmation"` 时提交；服务端追加写入 `<job>/confirmations.json` 后从 `extract` 续跑。
- 允许状态：`completed`（`resumeStage` 非空）、`needs_attention`、`failed`（含 interrupted；从 `resumeStage` 重试当前阶段）。
- 出参：200 = 公开 job 快照（同 GET /job 结构）；400 错误文案：
  - 无效 id『无效检索任务标识』；不存在『检索任务不存在』；
  - `cancelled` 或 `resumeStage` 为空：『任务已停止，不能继续；请发起新检索』/『该任务已完成全部阶段』；
  - 非法 `until`：『阶段边界必须是 discover–export 的有效阶段名』；`confirmations` 结构非法：『字段确认内容无效』；
  - 并发冲突沿用『已有文献检索正在运行，请等待或停止后重试』；
  - 请求体上限 64KB，超限 400（同现有 readBody 语义）。
- 守卫：属 `POST /api/literature/*`，自动适用 `X-Workbench: 1`（403『请从工作台发起请求』）。
- 验证码关口的 advance 等价于 resumeCurrent（脚本带 `--scrape-current`）；上述两条恢复路径并存，`resumeCurrent` 行为不变。
- 旧第一阶段任务（`job.json` 无 `stages`/`resumeStage` 字段）：按设计 §4.4 产物判定表重建——其 `candidates.json` 无 `batches[]` 时 discover 视为 pending，advance 会从 discover 重跑该任务（跨批可能产生的重复由 dedupe 兜底，设计 §12 D7；如需平滑复用旧结果属后续增强）。

#### 21.2.3 GET /api/literature/jobs（新增）

- `?limit=` 取 1–50，默认 20；返回 `{ jobs: [公开快照…] }`，按 `job.json` mtime 倒序；损坏任务跳过。
- 用途：刷新/换页后找回历史任务（第一阶段仅 localStorage 记住最后一个 job）。

#### 21.2.4 GET /api/literature/job（扩展）

公开快照新增可选字段（均可缺省、向后兼容）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `stages` | `{stage: "pending"\|"running"\|"done"\|"failed"\|"skipped"}` | 各阶段状态表 |
| `resumeStage` | string\|null | 下一待执行阶段；running 或全流程完成时为 null |
| `until` | string | 本次运行的阶段边界 |
| `counters` | object | 各阶段主计数（candidates/uniqueGroups/fulltextFetched/extractedPapers/parameterRows） |

`count` 语义与 `events`（截尾 30 条）不变；interrupted 恢复语义不变（`status=failed` + `stage=interrupted` + 原文案），新增 `stages/resumeStage` 使 interrupted 任务可经 advance 续跑。

#### 21.2.5 GET /api/literature/download（扩展）

- 路由与响应头不变（`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`filename*=UTF-8''`）；`name` 校验由固定白名单改为**该任务已登记交付物成员校验**（`job.files`），并保留：36 位 id 正则、反软链 `lstat`、仅允许任务目录内相对路径。
- Content-Type 映射扩展：`.csv → text/csv; charset=utf-8`、`.json → application/json; charset=utf-8`、`.xlsx → application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`、`.md → text/markdown; charset=utf-8`，其余 → `application/octet-stream`。
- 交付物命名（登记用相对 POSIX 路径）：`run_config.json`、`candidates.json|csv`、`dedupe/dedupe.json|csv`、`fulltext/status.json`、`fulltext/files/<paper_id>.pdf|txt`、`extraction/inputs/<paper_id>.json`、`extraction/<paper_id>.json`、`extraction/check_report.json`、`validation/validation.json|md`、`export/literature.csv|xlsx`、`export/parameters.csv|xlsx`、`export/export_report.md`。
- 登记规则：`result.files` 先过静态模式表再登记；`fulltext/files/*` 因 result 事件只带 `status.json`，由连接器按 `fulltext/status.json` 各 item 的 `path` 补登记（W1a 实现）。

#### 21.2.6 既有路由不变承诺

`POST /prepare`（指令文本与 202/400 语义）、`POST /search`（缺 `until` 时行为）、`GET /job`（旧字段与旧值）、`GET /download`（安全头）、`POST /cancel`（discover 阶段文案『检索已停止；持久浏览器保持打开』）全部保持第一阶段语义；`cancel` 在非 discover 阶段新增文案『任务已停止；已完成的阶段产物保留』。

### 21.3 数据与文件契约（摘要，全文见设计文档 §3/§4）

- `run_config.json`：现有 12 字段保留 + 可选 v2 字段（`batch / fieldDefinitions / templates / fulltext / extraction / limits`）；仍以 `flag:'wx'`+`mode:0o444` 冻结写入、永不回写。
- `confirmations.json`（新增）：`{records:[{at, by:"researcher", kind:"fieldDefinitions", fields:[…], note}]}`，append-only；为全文提取的有效字段定义来源。
- 任务目录：`.workbench/literature/<jobid>/` 新增 `confirmations.json`、`events.jsonl`、`dedupe/`、`fulltext/`、`extraction/`、`validation/`、`export/`（完整目录树见设计文档 §4.1）。
- `events.jsonl`（新增）：`{"at","type","stage","message","extra"?}` 一行一事件、追加写；唯一写入者 = 任务驱动方（连接器 / pipeline.py）；`job.json` 的 `events` 仍是 UI 展示缓存（截尾 30）。
- 阶段脚本 NDJSON 事件协议不变（`stage/attention/error/result`，字段与退出码见设计文档 §2.2/§2.3）；`attention.stage ∈ {verification, awaiting_confirmation}` → 驱动方置 `needs_attention` 并记录 `resumeStage`。

### 21.4 安全与守卫（不变项重述）

- 新 POST 路由（advance）自动继承 `X-Workbench: 1` 与 Host/Origin 校验；GET 路由不新增守卫（同现状 job/download）。
- `.workbench` 不经静态服务暴露；文件访问只经 download 的登记校验。
- 不绕过访问控制：验证码人工处理、付费墙全文标 `unavailable`，均按已确认规则（`docs/literature-mining-alignment.md`）。

### 21.5 自动化验收（W1a/W1b 实现后补齐，格式同 §17.4/§20.5）

`node tools/test-literature-connector.js`（W1a，已实测通过，输出 `LITERATURE_CONNECTOR_TESTS_PASS`）：
S0 原 mock 单阶段回归（start 缺省 `until=discover` 行为与文件登记逐字不变）；S1 桩阶段脚本工作区
`advance→…→download` 冒烟（失败重试、awaiting_confirmation 关口、confirmations 追加、stages/resumeStage/
counters、交付物登记与下载、events.jsonl）；S2 剥离父进程 UTF-8 变量后 spawn 中文事件无 U+FFFD；
S3 interrupted（服务重启遗留 running）按产物重建并可 advance 续跑；S4 cancel 双文案；S5 advance/snapshot
守卫边界；S6 `.literature-ready` marker v2（requirements sha256 变更感知、旧纯文本 marker 过期）；
S7 jobs 列表（mtime 倒序、limit 收敛、损坏记录跳过）。

`node tools/test-literature-http.js`（W1a，已实测通过，输出 `LITERATURE_HTTP_TESTS_PASS`）：
原 5 条零回归断言 + search 非法 `until` 400 + advance 路由（403；400 无效 id/不存在/已完成全部阶段）+
jobs 列表 + download 登记校验与新 MIME（csv/xlsx/md 实测 Content-Type 与 no-store/nosniff 安全头；
未登记名、穿越名 400）。

`python tools/test_literature_ui.py` / `node tools/test-literature-ui-stage2.js`（W1b）：
awaiting_confirmation 表单与继续流程（保留既有文案断言）。

全套 node/python 回归（check-contract、test-merge-store、test-server-exec、test-literature-sources、
test-literature-guidance、test-literature-extract、`python -m unittest discover -s tools -p "test_literature_*.py"`）
实测全通过，0 失败。

---

## 22. 九步研究流程（2026-10-20 · 业务两阶段九步落地）

### 22.1 背景与定位

业务侧的科研流程分两阶段、共九步：

- **阶段一 · 开展研究并形成论文（六步）**：① 文献调研 → ② 科学问题凝练与提取 → ③ 数据获取、清洗与处理
  → ④ 模型选择与运行 → ⑤ 图表绘制 → ⑥ 文章撰写与修改
- **阶段二 · 投稿到最终发表（三步）**：⑦ 投稿前的核验与投稿 → ⑧ 回复审稿意见、修改与复核
  → ⑨ 接收后的校稿核验

其中 ③④⑤（数据获取与清洗 / 模型选择与运行 / 图表绘制）**复用既有能力节点**（`download-data` /
`clean-data` / `calculation` / `plotting`），本轮新补 ①②⑥⑦⑧⑨ 六个环节。

### 22.2 数据模型：`step` 与 `type` 合流

模块同时带两个字段：

| 字段 | 含义 | 取值 |
|---|---|---|
| `step` | 业务环节（九步中的第几步） | `literature`/`question`/`data`/`model`/`chart`/`writing`/`submit`/`rebuttal`/`proof` |
| `type` | 能力节点类型 | 既有 `FIXED_MODULES` 九类 + 新增 `RESEARCH_TYPES` 六类 |

- `Store.RESEARCH_TYPES`：`literature-research`（文献调研）、`question-formation`（科学问题凝练）、
  `writing`（文章撰写）、`submit`（投稿前核验与投稿）、`rebuttal`（回复审稿意见）、`proof`（校稿核验）。
- `Store.RESEARCH_STEP_IMPL`：业务环节 → 能力模块展开（如 `data` → `['download-data','clean-data']`，
  展开的模块在链上依次串联）。
- `Store.RESEARCH_STEP_WORKFLOW`：业务环节 → 契约文档名（与 `server.js` 的 `WORKFLOW_FILES` 同名）。
- **旧数据兼容**：读取时凡带 `step` 的模块，其 `type` 若不在 `RESEARCH_TYPES ∪ FIXED_MODULES` 内，
  仍落到 `legacy-writing`（只作历史展示，不丢数据）；此前是无条件改写，现改为有条件保留。

### 22.3 Store API 新增 / 变更

| API | 签名 | 说明 |
|---|---|---|
| `startFlow` | `() => { ok, id, name, step, created }` | **语义变更**：现在按第 ① 步的 `impl` 展开建模块（文献调研），返回新增模块数 |
| `initFlowModules` | `() => { created, firstId }` | 一次性建满九步（已存在的能力类型跳过） |
| `setModuleParam` | `(id, key, value) => boolean` | 写环节参数（只接受字符串，单值截断 500 字符） |
| `RESEARCH_TYPES` / `RESEARCH_STEP_IMPL` / `RESEARCH_STEP_WORKFLOW` | 只读快照 | 供 UI 与服务端对齐 |

`approveModule` 的补链逻辑按 `step` 分流：带 `step` 的模块按业务环节推进（先补齐本环节剩余能力模块，
再推进下一环节）；无 `step` 的固定模块仍走 `addModule()`。两条链互不干扰。

### 22.4 模块字段：`params`

模块新增 `params`（对象，键值均为字符串），归一化时保留（否则刷新即丢）。当前唯一用途：
**文章撰写环节的「目标期刊」**——在模块说明卡里手填，随对话上下文与执行参数传到 AI 与执行脚本。

### 22.5 服务端：`WORKFLOW_FILES` 新增六个键

新增 `literature-research` / `question-formation` / `writing` / `submit` / `rebuttal` / `proof`
六个键，分别指向 `docs/` 下同名契约文档（格式：定义 / 输入 / 执行 / 交付 / 检查 / 异常 / 需对齐内容）。
`flowStepInstructions()` 的合成指令降级为**兜底**（仅对认不出 type 的历史写作流模块生效）。

### 22.6 执行内核：上游产物汇聚（`/api/code/exec`）

文章撰写等环节要基于上游模块产出的图表 / 数据 / 文稿工作，而此前模块上下文只带 400 字环节文档、
**产物文件不向下游流动**。本轮新增三条入参：

| 字段 | 类型 | 说明 |
|---|---|---|
| `upstream` | `[{ name, dir }]` | 上游模块的产物目录。**只允许读取本工作台自己的产物根目录**（`<项目>/.workbench`、执行根目录 `YANXU_RUN_DIR` 或 `~/yanxu-runs`、系统临时目录）；不在根内 → 该项丢弃并在响应 `upstreamDropped` 里说明原因 |
| `upstreamJobs` | `[jobId]` | 文献挖掘作业 id（uuid 形式），服务端解析为 `<项目>/.workbench/literature/<jobId>` |
| `params` | object | 环节参数（如 `{"journal":"…"}`），归一化后写成 `params.json` 落在执行目录 |

行为：脚本启动**前**把上游产物复制进 `<执行目录>/upstream/<模块名>/`，并写 `upstream_manifest.json`
（`{items:[{module,file,size,path}]}`）说明映射关系。响应新增 `upstream: { copied:[…], manifest }`。
上限：目录 ≤10、单目录文件 ≤200、单文件 ≤20MB、总量 ≤60MB。

### 22.7 文章撰写环节（⑥）产物

`tools/writing_build.py`（纯标准库）在执行内核里运行，读取 `params.json` / `upstream_manifest.json` /
`upstream/**` / 可选的 `manuscript.md`，产出：

| 产物 | 说明 |
|---|---|
| `manuscript.tex` | LaTeX 主稿：目标期刊写在注释里；章节按草稿的二级标题切分；每张上游图生成一个 `figure` 环境（`figures/<名>`） |
| `references.bib` | 上游有 `.bib` 就并入，没有则写占位条目（并进待补清单） |
| `manuscript.md` | 正文副本（便于通读评审） |
| `<图表文件>` | 从上游收拢的图表，**平铺落在执行目录根下**（执行内核的产物清单只收顶层文件，放子目录就下载不到；`\includegraphics` 直接引用平铺后的文件名） |
| `build_report.md` | 生成报告：目标期刊 / 草稿来源 / 收拢了哪些上游产物 / 待补清单 |

### 22.8 手工验收清单（本轮）

1. 侧栏点「按业务流程初始化」→ 只出现 ①文献调研 一个模块；通过审核后依次出现 ②科学问题凝练、
   ③数据获取（展开为 下载数据 + 数据清洗）、④计算、⑤绘图、⑥文章撰写、⑦投稿、⑧回复审稿、⑨校稿。
2. 刷新页面：上述链条与各环节的 `step` / `type` / `spec` / 审核状态全部保留（不再退化成 legacy-writing）。
3. 文章撰写模块的说明卡底部出现「目标期刊」输入框；填「XXX」后刷新仍在。
4. 在文章撰写模块执行 `tools/writing_build.py`（lang=python）→ 产物列表出现 `manuscript.tex` /
   `references.bib` / `build_report.md`；上游有图时 `figures/` 里有图。
5. 上游有产物目录时，响应 `upstream.copied` 非空，且执行目录里存在 `upstream/<模块名>/` 与
   `upstream_manifest.json`；传入不在允许根内的目录 → `upstreamDropped` 里有记录且未复制。

---

## 23. 文献调研环节（①）· 目标期刊规范（2026-10-20 · 补齐第一阶段）

### 23.1 环节①与「文献挖掘」的关系

按主人口径**拆成两个独立环节**：

| | 文献调研（环节①） | 文献挖掘（能力节点） |
|---|---|---|
| 目标 | 为研究决策服务 | 为计算模块服务 |
| 产出 | 逐篇要点、共识分歧、研究空白清单 | 参数表（供计算用） |
| 字段口径 | 这篇研究了什么、结论是什么、局限在哪 | 这个参数多少、什么单位 |
| 底层 | 共用检索 / 去重 / 全文的产物（`candidates.json`、`fulltext/files/*.txt`） | 同左 |

### 23.2 新端点 `POST /api/literature/research`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `jobId` | string | 是 | 已完成首批检索的文献作业 id |
| `settings` | object | 否 | 模型设置（前端齿轮里的分组），留空回落服务端 `.env` |
| `credential` | object | 否 | 「添加 API」的活跃凭证 |

**流程**：读 `candidates.json` → 读 `fulltext/files/*.txt` 并按 candidate_id / 标题匹配回候选 →
分批调模型抽要点 → 调模型做横向归纳 → 产物落盘。

**出参**：`{ ok, meta, files[], notes[], synthesis{consensus,disagreements,gaps}, gaps[], error }`。

**产物**（写在作业目录 `research/` 下，已加入 `DELIVERABLE_PATTERNS`，可从作业面板下载）：

| 文件 | 内容 |
|---|---|
| `research/notes.json` / `notes.csv` | 逐篇要点：研究问题 / 数据来源 / 方法 / 结论 / 局限 + 题录 + `evidence`（全文 / 仅题录） |
| `research/synthesis.json` / `synthesis.md` | 共识、分歧（每条带出处 id） |
| `research/gaps.json` / `gaps.md` | 研究空白清单：空白描述 + 支撑依据（哪篇的什么结论）+ 可检验方向 |

**诚实性约束**：只有题录（无全文）的文献，`evidence` 标「仅题录」，提示词明令不得推断方法细节与结论；
模型没给出的字段一律落「文中未说明」；模型输出不合法时不崩，如实记 `error` 并仍留下过程产物。

### 23.3 目标期刊规范（`tools/writing_build.py` 的 `JOURNAL_GUIDES`）

目标期刊在文章撰写环节手填，模块参数 `params.journal`（新建时默认 **AAAI**）。命中规范表时：

- 换用该刊模板：`\documentclass{aaai26}` + `natbib/times/helvet/courier/balance`，参考文献样式 `aaai26.bst`；
- 双盲期刊的 `\author` 写匿名占位，并在注释里写明作者/单位/基金/致谢不得出现；
- 硬约束（页数、摘要词数、关键词数、图表分辨率、禁改行距等）写进 `manuscript.tex` 头部注释
  与 `build_report.md` 的「写作约束清单」，并提示模板文件需自行从当届 Author Kit 下载；
- 未命中时按通用 `article` 结构生成，并在注释与报告里**标明未按任何期刊约束**。

已收录：AAAI（aaai26）、NeurIPS、ICML。页数/词数等每年可能微调的数值均标注「以当年 Author Kit 为准」。

### 23.4 前端（保持简洁）

环节①在模块空间里只有一个紧凑面板：主题输入 + 检索式输入 + 一个「检索并生成要点」按钮 + 一行状态。
跑完把要点数/空白数/产物文件名显示在面板下方，并往模块对话里追加一条系统消息。目标期刊是
说明卡底部的一行输入框，不另起面板。

### 23.5 回归

`node tools/test-literature-research.js`（mock 模型，不联网）：24 项断言全通过，覆盖
正常路径、产物落盘、诚实性兜底、脏 JSON 不崩、无候选报错、提示词含「仅题录不得推断」的硬要求。

---

## 24. 环节①冷启动 + 人工初筛 · 环节②科学问题凝练（2026-10-20）

### 24.1 为什么补这两块

数据挖掘（文献挖掘）是**题目已知**的流程：入口是 `topic + query + targetFields`，检索式由已定的问题倒推。
而环节①是**题目未知**（人手上只有一个模糊想法）、环节②是**要靠人判断**（从空白里挑值得做、做得动的问题）。
所以这两环的形态是**人机交替**，不是一键全自动。

### 24.2 环节① · 选题冷启动 `POST /api/literature/research-plan`

入参 `{ idea, settings?, credential? }` → 出参 `{ idea, dimensions:[{name,keywords[]}], queries:[{query,rationale}] }`。

提示词要求：3–5 个检索维度、3 条不同角度的检索式（宽口径 / 聚焦方法 / 聚焦对象）、
必须是 Google Scholar 能直接跑的语法、不得编造文献。

### 24.3 环节① · 人工初筛

- `GET /api/literature/candidates?id=<jobId>`：候选清单（id / 标题 / 作者 / 年 / 期刊 / DOI / 摘要片段），只回题录层字段。
- `POST /api/literature/research-screen`：入参 `{ jobId, keep[], exclude[{id,reason}] }` →
  写 `<作业目录>/research/screening.json`。
- 要点抽取（`/api/literature/research`）会**读这份初筛记录**：只对 `keep` 里的候选抽要点，
  被排除的条目连同理由进 `research/screening_result.json`（可回看、可追溯）；没有初筛记录则全部保留。

### 24.4 环节② · 科学问题凝练 `POST /api/research/questions`

独立前缀 `/api/research/`（自成一个 handler，不挂在 `/api/literature/` 下）。

| action | 入参 | 出参 |
|---|---|---|
| `candidates` | `{ idea, upstreamJobIds[], settings? }` | `{ ok, candidates[] }` |
| `specify` | `{ idea, choice, upstreamJobIds[], settings? }` | `{ ok, markdown, candidate }` |

- **上游产物由服务端自己读**：`upstreamJobIds` → `.workbench/literature/<id>/research/{gaps,notes}.json`，
  前端不（也不该）把文件内容原样回传。
- 候选问题字段：`statement / hypothesis / variables[] / boundary / gapRefs[] / basis[{id,what}] / feasibility`。
- **硬要求（代码兜底，不只靠提示词）**：候选必须至少有一条 `gapRefs` 和一条 `basis`，否则丢弃；
  模型的输出不可全信。材料不足时**允许返回空数组**——那是正确答案，不硬凑。
- 说明书用 Markdown 固定小节：研究问题 / 可检验形式 / 研究对象与关键变量 / 边界条件 /
  与文献空白的对应 / 可行性初判 / 预期贡献。

### 24.5 衔接：①→② 真正接上的那一环

环节①检索成功后把作业 id 写进**模块参数** `params.researchJobId`（归一化保留，刷新不丢）；
`collectUpstreamArtifacts` 除 exec 产物目录与 `CodexUI.literatureJobId` 外，**多读这个来源**，
于是环节②能拿到上游的空白清单与文献要点。

### 24.6 前端（保持简洁）

- 环节①面板：`想法` + `生成检索式`（→ 候选检索式，点一条填入）＋ `检索式` + `检索` →
  **检索后不直接抽取**，先列候选让人勾选（默认全勾）→ `确认初筛并生成要点`。
  刷新后按 `params.researchJobId` 自动恢复候选清单。
- 环节②面板：`想法` + `生成候选问题` → 候选卡片（陈述 / 假设 / 变量 / 边界 / 对应空白 / 文献依据 / 可行性）+ `采用这条`
  → 说明书写入**环节文档**（走人工审核门），它就是下游③数据获取、④方法选择的输入契约。

### 24.7 回归

`node tools/test-research-question.js`（mock 模型）：22 项断言全通过，覆盖冷启动解析、候选生成的
依据硬过滤、材料不足返回空数组、说明书固定小节、人工初筛过滤与留档、初筛记录被要点抽取读取。
`node tools/test-literature-research.js`：24 项断言全通过。

### 24.8 上游重试与错误映射（2026-10-20 实测后补）

真链路连跑发现免费通道会间歇性回 `Upstream model provider is temporarily unavailable`
（候选问题那一步 4 次里失败 3 次、第 4 次才成功）。据此补两件事：

- **服务端退避重试** `callModelWithRetry(cfg, messages, timeoutMs, attempts=4)`：只对
  「临时不可用 / 额度不足 / 限流 / 网络失败 / 超时」这类瞬时错误重试（2s、4s、6s 退避），
  输入类错误直接抛出，不做无谓重试。四个模型调用点（选题拆解、要点抽取、候选问题、问题说明书）
  全部走这个包装。
- **错误状态码区分** `researchErrorStatus(message)`：上游类问题 → **502**（前端提示"稍后重试"），
  输入/前置条件类问题 → **400**（前端提示"先做 XX"）。不区分的话，上游抖一下会被前端
  当成"你填错了"，误导使用者。

### 24.9 逐步解锁语义（2026-10-21 修正）

主人在界面上验收时指出：「流程多智能体要求的是先有 1 再有 2，先有一个模块后才有下一个模块」。
此前入口误用了 `initFlowModules()`（一次铺满十环），把流程的强依赖语义抹平了。已改回：

| 入口 | 行为 |
|---|---|
| `Store.startFlow()` | **只建第①步**（文献调研），这是正常推进路径 |
| `Store.initFlowModules()` | 一次铺满九步——仅"先看全貌"用，不是推进路径 |
| `Store.approveModule(id)` | 该模块通过审核门时，**只补出下一个**模块 |

实现：`ensureStepModules(step, onlyOne)` 增加 `onlyOne` 开关——为真时建完一个就停；
`buildNextFlowModule()` 先补本环节剩下的（一次一个），本环节齐了才推进下一业务环节（同样一次一个）。
于是链条严格线性：1 → 2 → … → 10，每过一个审核门才长出一个。

三个入口统一走 `startFlow()`：`新建任务`对话框的 research 分支（js/tasks.js）、
侧栏「按业务流程开始（九步研究流程）」按钮（js/sidebar.js）、空模块空间里的流程入口（js/chat.js）。

实测（内置浏览器 8124 实例）：新建九步任务 → 只有 1 个模块（①文献调研）；
通过①的审核门 → 变 2 个并自动选中②。

---

## 25. 调试台（2026-10-20）

出问题时不用猜：服务端把最近的请求与异常记在内存环形缓冲里，调试页一把拉出来。

### 25.1 服务端

- **环形缓冲** `debugLog`（上限 200 条，只在内存、进程重启即清、不落盘、不含请求体与密钥）：
  每条 `/api/…` 请求记一行 `{ seq, at, level, kind, method, path, status, ms }`；
  `level=error` 的行（HTTP ≥400、uncaughtException、unhandledRejection、前端上报）会额外带
  `error` / `stack` 摘要。**Key 一律脱敏**（`Bearer ***` / `apiKey=***`）。
- **未捕获异常**：`process.on('uncaughtException' | 'unhandledRejection')` 只记录不退出——
  本地开发工具要一直活着。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/debug/state?limit=` | GET | 服务状态、运行时长、Node 版本、当前 `.env` 模型、文献作业数、错误计数、最近请求与错误 |
| `/api/debug/logs?limit=` | GET | 原始日志数组 |
| `/api/debug/client-error` | POST | 前端 JS 错误上报 `{ where, message, stack }` |

### 25.2 前端

- **`debug.html` + `js/debug.js`**：独立工具页（`http://localhost:8123/debug.html`），**不进
  index.html 的脚本列表**，不污染主界面。
  **可见性约定**：这个页面主要是给维护者（AI）用的，所以侧栏入口**默认不出现**——
  只有地址栏带 `?debug=1` 时才显示「调试台」链接。维护者日常用 `node tools/debug-report.js`
  拿命令行摘要，不必开页面。
- `js/debug.js` 的联网权限**仅限 `/api/debug/*` 只读**（已加入契约自检的 `FETCH_ALLOWED`）。
- **主界面错误上报**：`js/chat.js` 装 `window.onerror` 与 `unhandledrejection`，
  统一 POST 到 `/api/debug/client-error`（失败静默，不影响主流程）。

### 25.3 文档

用途、边界与**排查手册**（看到什么 → 什么意思 → 怎么办）见 `docs/debug-tool.md`；
README 的「调试」段给了一条命令的用法。

### 25.4 验收

1. 打开 `/debug.html`：显示服务状态、运行时长、`.env` 模型、Key 有无、文献作业数、请求/错误计数。
2. 「最近请求」表逐条显示 时间 / 级别 / 类型 / 方法 / 路径 / 状态 / 耗时。
3. 在主界面制造一个 JS 错误 → 调试页「错误」表出现该条（中文正常显示）。
4. 侧栏底部「调试台」链接可跳转到该页。

---

## 26. 多源检索：Scholar + 开放 API（2026-10-22）

### 26.1 来源注册表

单一真相仍是 `tools/literature-sources.json`；`state=executable` 的 6 个来源可自动执行：

| key | 显示名 | 接入 | 人工 |
|---|---|---|---|
| `google-scholar` | Google Scholar | browser | 可能需过验证码 |
| `pubmed` | PubMed | api | 否 |
| `pmc` | PMC | api | 否 |
| `openalex` | OpenAlex | api | 否 |
| `semantic-scholar` | Semantic Scholar | api | 否（无 Key 时共享池限流） |
| `europe-pmc` | Europe PMC | api | 否 |

`cnki` / `wanfang` / `web-of-science` / `scopus` 是 `state=registered`（人工源），
程序化启动仍按冻结文案拒绝，只能走导出清单导入。

### 26.2 运行配置新增 `sourceQueries`（可选）

```json
{ "query": "通用检索式", "sources": ["google-scholar", "pubmed"],
  "sourceQueries": { "pubmed": "\"soil organic carbon\"[Title/Abstract] AND fertilization[Title/Abstract]" } }
```

- 键必须是本次 `sources` 中启用的来源；值为非空字符串（≤600 字符）。
- 未列出的来源回落到顶层 `query`；不带 `sourceQueries` 的旧配置行为不变。
- JS `normalizeConfig` 与 Python `validate_config` 双层校验。

### 26.3 执行语义

- 顺序：先开放 API 源（不启动浏览器），再 Scholar。
- 单源失败不拖垮整批：`sources[]` 元信息记 `status=error` 与 `error`；其余源照常。
- 跨源去重：DOI 归一化后相同，或标题去标点/大小写后相同 → 同一篇，保留先到的
  结构化来源（开放 API 源排在 Scholar 前面，摘要更完整）。
- Scholar 验证码/启动失败而开放源已有结果时：先落盘（批次 `status="partial"`），
  发 `result` + `attention` 两个事件；作业状态为 `needs_attention`，验证后重新检索补齐。
- 批次 `scope`：纯开放源 `open_api_candidates`，混合 `mixed_candidates`，
  纯 Scholar 仍 `first_page_candidates_only`。

### 26.4 端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/literature/sources` | GET | 可执行来源清单 `{ sources: [{ key, label, access, manual }] }`，前端据此渲染来源多选 |
| `/api/literature/candidates?id=` | GET | 新增 `scope`、`sources[]`（逐源检索式/URL/条数/状态/错误）、`source_counts` |
| `/api/literature/research-plan` | POST | 请求新增可选 `sources: string[]`；响应新增 `sources` 与 `perSource[]` |
| `/api/literature/search` | POST | 接受 26.2 的 `sourceQueries` |

`research-plan` 的 `perSource` 每项为 `{ source, query, rationale }`；
模型漏写的来源用通用检索式补齐并在 `rationale` 标注「沿用通用检索式」。

### 26.5 前端

- 环节①调研面板：来源多选（来自 §26.4 端点，含「免验证」标记）、多源时逐源检索式输入框、
  按源检索计划「用这条」、检索完成后逐源显示命中数/失败原因。
- 上述面板状态（`sources` / `perSource` / `sourceResults`）必须进 `js/chat.js` 的 `docSigOf()`，
  否则会被增量渲染快速路径吞掉（§22 已知坑）。
- 文献挖掘配置面板的来源清单同步为 6 个可执行源 + 4 个人工源。

### 26.6 验收

```bash
python tools/test_literature_search.py        # 19 项，含混合来源/DOI 去重/部分落盘
python tools/test_literature_search_open.py   # 80 项，来源注册表与请求构造
node tools/test-literature-sources.js         # 注册表 + normalizeConfig（含 sourceQueries）
node tools/test-research-question.js          # 选题拆解（含 perSource）
node tools/test-literature-ui-stage2.js       # 多源面板静态检查
node tools/check-contract.js                  # ALL_CHECKS_PASS
```

## 2026-10-19 本地整合：六阶段与已审核方案流程

`/api/literature/*` 由共享的 ScholarConnector（server.js 中的 scholar）承载六阶段任务，包含 start/advance/list/snapshot/cancel/download；提取适配器显式传入 bridge/jobDir/config/python/onEvent。`/api/codex/literature/*` 继续由 LiteratureFlow 承载已审核方案执行、上传材料补充和清洗交接，两类运行标识不混用。文献模块将原候选检索折叠卡升级为默认展开的“文献检索与提取（六阶段）”，保留已有审核方案入口。新旧入口共用原同源服务、浏览器存储键与 Codex 设置登录；新六阶段的准备、继续与字段确认在旧流程运行时禁用。Python 子进程同时保留系统代理、已取消守卫和显式 UTF-8 编码。设置页 API 分组及测试连通控件随当前后端切换显示；契约检查同时登记 sidebar.js 与 literature.js 的同源请求权限。

## 2026-10-19 模型目录与运行时发现

新增内部模块 `tools/codex-runtime.js`：显式 `CODEX_BIN` 优先；Windows 自动发现 `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe` 中最新安装的可执行文件，缺省时回落 npm 原生程序与 PATH；macOS 保留桌面内置 CLI。启动脚本不再将 CODEX_BIN 固定为旧 npm 程序。`/api/codex/status` 保持原返回结构，使用所选运行时的 `model/list`，跟随 nextCursor 收集全部可见模型并按精确 model 标识去重。前端所有模块共用此目录，连接状态显示模型数量；既有选择继续保留，当前目录不可用的旧选项禁用并提示重新选择。模型名称与调用标识不替换、不手写固定列表。

首次读取账号若遇到特定工作区路由发现超时，使用同一 CLI 的官方 `login status` 命令核对已有本机登录；只有命令成功且明确识别登录类型时才回退，不读出、修改或另存凭据。模型目录和登录状态不替代实际推理成功检查。六阶段新任务将当前模块选择（或账号默认）的模型写入 `config.extraction.model` 后冻结，后续按冻结配置提取，不能只改变对话模型而仍用其他默认提取模型。

## 2026-10-19 文献页面入口整理

文献挖掘主页面仅提供六阶段任务入口。原 LiteratureFlow 在文献模块仅展示已有批次的折叠记录及续跑、补传、交接，不再提供开始新一批的按钮；下载模块继续使用原方案入口。已审核文献方案卡片指向上方统一执行区域，不调用第二套开始接口。

原页内工作流说明移到按需打开的原生 dialog，使用按钮触发 DOM 自定义事件 `literature-help-open`，由 workspace.js 管理弹窗和关闭；不新增全局对象或存储键。新增样式 `.literature-overview`、`.literature-help-dialog`、`.literature-help-head`、`.literature-legacy-history`；旧主页面不再插入 `.literature-workflow` 大块说明。任务卡标题为“文献任务”，配置折叠区显示“本次检索设置（点击查看或修改）”，运行范围标签显示“本次做到哪一步”。模型、科学规则、任务记录与 API 路由保持现有契约。

## 2026-10-19 多来源检索与人工登录

六阶段 discover 接入 Google Scholar、知网（cnki）、Web of Science 核心合集（web-of-science）；万方、Scopus、PubMed 仍 registered，执行时明确拒绝。运行配置新增可选 `sourceQueries`：已登记来源 key 到非空检索式字符串的映射，单项最多 2000 字；未设置的来源沿用 `query`。旧任务、Scholar 查询和前 13 个配置字段保持兼容。每来源每批最多 10 条，不将三来源合计数量误称为单来源上限。

`tools/literature_browser.py` 提供可注入/可测试的浏览器适配：复用本机持久检索浏览器，为各任务各来源绑定独立标签页；根据实际 DOM 执行检索并读取真实结果。遇到登录、验证码、缺少机构权限或不能识别结果页时返回 attention，不把阻拦页当零命中。用户只在数据库官方网页中输入凭据；平台不接收或导出密码、Cookie、SSO URL/令牌。浏览器会话状态仍仅在本机忽略目录。网页访问权限不等于全文权限；fulltext 阶段仍逐项登记实际获取结果。

`literature_search.py` 按选择来源顺序执行，`discovery-state.json` 保存配置指纹、批次、各来源完成记录和当前等待来源（内部检查点，不是可下载成果）。已完成来源的候选立即保存；某来源等待登录时不会丢掉先前候选。相同任务 advance 从待处理来源继续，不重新检索已完成来源；来源/检索式变更则启动新任务。候选保留 source_key；编号分别 GSC-/CNKI-/WOS-，跨批保持 B<n> 前缀；跨来源重复留到 dedupe 归并并保留来源。applied_filters/deferred_rules 按真实执行登记，发表年份不冒充实验年份。

discover 的 attention 事件增加 `source` 和 `reason`（login/verification/access_required/results_unrecognized），可附已生成 files；节点向网页公开 `attention:{source,reason}`，从磁盘恢复该状态。页面据此显示当前来源、问题和“打开登录/检索页面”“检查并继续”按钮。continue 使用原 job id 和运行边界，通过 advance 续跑，不创建新批次。验证码由用户完成；页面仍可停止或查看先前成果。

新增同源 `POST /api/literature/browser {id}`：只接受已存在且 discover 阶段等待人工处理的任务，按其冻结来源打开/前置该任务绑定的官方标签页，不接受任意 URL、命令、文件路径或凭据；沿用 X-Workbench、Host、Origin 防护。返回 `{opened:true,source,label}`，不返回浏览器调试地址或登录信息。运行中的任务拒绝此操作，以免改变检索页面。新内部 CLI `literature_browser.py --open-source <key> --output-dir <job目录>` 从任务配置/检查点决定固定来源页面。

检索规则整理同时保留用户已确认的 sourceQueries；建议不能替代用户确认。UI 在来源选择后提供独立检索词，未填写时说明沿用默认检索式。sourceQueries 参与冻结配置一致性检查。六阶段入口说明与工作流提示同步列出三来源及人工登录续跑；不宣称已完成未经实际验证的账户检索。

人工登录恢复的 advance 即使未传 until，也沿用 job.until；普通继续保持原缺省 export 行为。目标阶段不得早于 resumeStage。等待人工处理的任务可取消，已有材料保留。部分 discover 产物明确 discovery_complete=false，服务重启不能据此跳过尚未检索的来源。WOS 每次提交前确认主题（Topic）字段；无法识别字段或结果页即暂停。手动修改结果页查询后不得用子串匹配冒充冻结检索式，必要时重新提交原查询。

验证：新增 tools/test-literature-login.js（等待来源、部分成果、重启恢复、原 id/边界续跑、停止与打开页面守卫）；tools/test_literature_browser.py 用 DOM mock 验证登录/验证码/机构权限/明确零命中/未知布局/稳定标签/WOS Topic/敏感信息过滤；tools/test_literature_search.py 验证三源、独立查询、部分检查点及重启续跑。既有六阶段 HTTP 提取/校验/导出端到端测试及全部阶段 Python 回归通过。CUA 核对三来源选择、检索词输入和刷新保留。实际 WOS 站点重定向后在当前网络连接重置，尚未用研究者机构账号验证授权后搜索；知网亦未代用户完成认证，实际站点布局或权限失败保持显式等待/错误，不能以 mock 测试声称真实数据库已检索成功。

浏览器 API 依据既有 SOC 实现以及 Playwright 官方 BrowserContext.new_cdp_session、BrowserType.connect_over_cdp、Page.bring_to_front 文档；浏览器与 context 不主动关闭，避免登录会话丢失。

## 2026-10-19 补齐页面全部六个来源

在上述三来源基础上，万方（wanfang）、Scopus（scopus）、PubMed（pubmed）均提供实际检索适配，注册表六项 executable。来源选择、sourceQueries、冻结配置、来源内编号、跨来源去重、部分成果和原任务续跑沿用既有接口，编号增加 WF-/SCOPUS-/PMID-（PubMed 的真实 PMID 另保存在结果元数据，候选 id 仍为批次内稳定编号）。每源每批最多10条不变。

万方和 Scopus 从固定官方检索页面经可见表单提交该来源的检索式，按实际 DOM 读取候选、作者、发表年、来源及 DOI/链接。需要登录、验证码、机构权限或不能识别布局时沿用 attention 与“打开登录/检索页面”“检查并继续”；未知页不得当作零命中。持久任务标签和凭据不出本机的要求不变。`tools/literature_extra_sources.py` 为新增来源网页适配的内部模块，不新增任意 URL/脚本执行接口。

PubMed 优先使用 NCBI 官方 E-utilities 的 ESearch(pubmed) 与 EFetch(pubmed,xml)，无需研究者登录即可获取公开书目/摘要元数据，不使用账号凭据。固定HTTPS端点、限制返回条数与大小、请求超时、默认无Key限速和明确网络/解析错误；零命中必须由合法空结果确认。保留 PMID、DOI、作者、发表年、期刊与公开全文链接，摘要仅用于候选筛选，不能当作全文提取证据。`tools/literature_pubmed.py` 仅查询固定PubMed接口；失败可在同一PubMed来源内改走官方网页（记录transport），不静默更换数据库。选择手动页面继续后读取同任务PubMed标签。

discover 增加 transport 及 PMID 的可选元数据并保留到候选 JSON/CSV；旧字段及旧成果保持兼容。年份过滤必须按实际查询或已知发表年后筛记录；未知年标记待核查。六源串行时缺省discover运行预算按来源数扩展（每源180秒，最大1080秒），显式较大预算保留，避免单源预算误杀后续来源；单请求仍有限超时，登录等待立即退出进程。

页面和模型提示不再显示“未接通”预留项，分别为六来源保存检索词。新增来源须有候选解析、人工关口/公开接口、来源聚合、断点续跑和既有三源回归测试；实际受限账户站点的验证情况如实说明，不以测试fixture冒充真实命中。

本次验证：PubMed 官方公开接口实际返回两条题录与真实 PMID；CUA 在万方和 Scopus 官方页面提交小批例词，确认实际题录、万方标题弹页和 Scopus 新版 Documents/Title Abstract Keywords 表单结构。适配器按这些可见 DOM 补齐并加入回归 fixture，尚未以研究者账号逐库验证完整的全文获取。六来源配置与独立检索式经页面勾选、刷新保留检查；契约检查、来源/登录/断点续跑测试及六阶段 HTTP 提取—校验—导出测试通过。检索结果仍待人工筛选，第一批只代表实际返回页。

## 2026-10-19 测试与正式检索、自动翻页和可见续跑入口

运行配置追加可选 `searchMode: "test" | "formal"` 与 `perSourceLimit`。显式 test 固定每来源10条；显式 formal 允许研究者输入每来源候选上限1–1000（默认100）。旧 `limit`、`batch.size` 继续表示小批/接口页大小，显式新模式固定为10，`batch.maxBatches`仍是历史人工批次上限，不能充当自动翻页页数。未提供新模式的旧配置、已冻结任务及检查点维持原limit/batch与指纹；新模式/目标数量进入冻结配置比较和新检查点指纹，不能把改变后的目标混入旧任务。前13个配置字段、原存储键、既有HTTP签名不变。

同一discover批次内按来源逐页检索。测试只取首批最多10个候选；正式持续到来源内去除相同记录、已知发表年份后筛后的候选达到上限，或明确没有下一页。实际返回数不足时如实报告，不为凑数编造。浏览器正式检索读取完整当前可见页（安全上限200条；原生页超过200时提示在官网调小后继续），避免网站每页20/50条而只读前10后跳页漏记录；最后一页按剩余目标截取。PubMed使用官方ESearch `retstart`/`retmax`。其它来源只通过官方网页可见分页控件翻页，不构造私有API。结果未知、页码/查询不匹配、页面重复或访问受限时暂停，不能当作末页。最多1000页的保护触发时同样暂停并保留成果。

内部页面适配接口 `literature_browser.run(..., *, job_dir=None, page_index=0, full_page=False)` 追加从0起算的目标页；不传新增参数的旧调用行为不变。返回可追加 `page_index`、`has_next`（true/false/null）、`total_count`（可验证时才有），以及原results/auth元数据。浏览器绑定追加已确认页码和结果指纹，不保存登录URL或凭据；恢复时必须核对冻结查询和目标页，无法确认就经首页可见分页重放或暂停。PubMed同样支持可选page_index并返回真实总命中与是否有后续页。

PubMed 在任务内部 `pubmed-transport.json` 只保存query_hash与transport，锁定同来源分页传输方式。首批API成功后，后续页API失败保留原offset待重试，不能把API每10条页码直接映射到网页20/50条原生页码。首批改走官网网页后，后续页继续官网网页。该内部标记不作为用户下载成果，不含URL/凭据。

`discovery-state.json`按每来源保存已完成页、下一目标页、原始取回数、过滤后的记录、停止原因和可验证总命中。每页原子保存检查点及累计候选；同来源第N页遇到登录也保留其前N−1页。重复页面指纹不能累加计数；同任务继续从等待页恢复，已完成来源不重跑。候选JSON中source_status追加pages_fetched、retrieved_count、count、total_count（可空）、stop_reason，保留旧字段。完成标志仅在所有来源真正停止于上限/末页时为true；Node与Python重启检测一致。阶段事件复用message报告当前来源、页数、已获取/目标数，不新增通用URL或命令执行入口。

正式缺省discover预算按每来源180秒×来源数×ceil(目标/10)，最多86400秒；测试和旧配置按来源数计时。显式limits优先，Node和Python兼容恢复一致。超时与中断保留已完成页供续跑。

界面在检索设置中提供“测试运行（每来源10条）”“正式检索（自选数量）”以及正式数量输入。新建/AI整理的配置默认测试，历史冻结任务按原配置恢复。等待人工的提示卡置于工具栏下、设置表前，显示当前来源、问题及“打开登录/检索页面”“检查并继续”；只有真实需要人工处理的原任务提供可用续跑按钮。平常显示登录流程提示说明；不需要登录时不伪造登录任务。使用既有literature样式和存储，不新增global或存储键。

验证记录：真实PubMed公开API正式运行跨3页取得25个不同PMID并达到上限停止；CUA确认万方与Scopus通过可见Next进入第2页且题录变化；测试/正式模式切换和正式数量25刷新保留在真实平台核对。模拟回归覆盖同来源第2页登录后续跑、已有来源不重跑、整页20条不跳过、重复页/未知Next暂停、API/网页传输不混页、部分成果恢复与冻结目标变化；完整Python及Node模式/预算/登录/HTTP/UI、六阶段提取校验导出回归通过。尚未以具体机构账号逐库完成全流程分页和受限全文验证，站点不可识别或无权限时如实暂停。

## 2026-10-19 正式模式直接检索到可访问末页（用户最新要求）

新界面只提供测试（每来源最多10条）与正式（检索到末页）。正式不显示数量输入或“按数量停止”选项，不以1000条作为停止依据。新正式配置明确 `searchMode:"formal", stopMode:"end", perSourceLimit:null`。stopMode可选值count/end仅为兼容旧任务；旧正式缺省count及原perSourceLimit、已冻结配置、检查点指纹和按数量续跑行为保留。测试继续10条，可省stopMode或为count；不接受test/end。新启动、AI整理的正式配置都显式end，新旧结束条件参与冻结配置一致性检查。前13字段、原存储键、HTTP签名不变。

正式end的逐页聚合不设候选数量停止条件，页码为非负整数，不因原1000页保护永远卡住或误称末页；仅在可验证无下一页时把来源标为exhausted并最终完成。报告scope为accessible_pages_until_end；进度显示已保存页数、已保留候选数，以及可验证的来源总命中，不显示目标数量或臆造百分比。记录中的perSourceLimit为null，不用极大数字冒充无限量。来源本身的检索/分页访问上限（例如PubMed公开接口、Google Scholar的可见结果范围）不等于科学主题的全部文献：已知触及来源上限时暂停说明并保留进度，不能把限制页称为检索完成。未知Next、重复页、登录/验证/权限问题沿用等待关口，按同一来源、同一页、同一传输恢复。

每页仍原子保存，已完成来源不重跑。end检索中网络/解析错误转为可恢复人工等待，保留原任务、来源与下一页；环境/进程失败或单次运行超时也暂停在discover并登记已有成果，允许检查并继续，而非标记末页。单次end discover缺省预算86400秒，显式limits优先；此为运行时保护，暂停后从检查点继续，不能成为假完成依据。未等待具体数据库页面的通用暂停不提供无效的打开登录按钮，但保留“检查并继续”和明确问题提示。

旧按数量任务从历史载入仍可原样继续；在其基础上发起新的正式任务时转换end配置，不混用已有成果。界面说明使用“检索到数据库当前可访问末页”，遇到站点限制或人工问题展示实际原因。测试/原有数量模式回归与真实零命中、末页、跨1000条、多页登录暂停/重启恢复必须一并验证。

## 2026-10-19 当前任务补充提取字段（不重新检索）

文献任务已有job时提供“设置提取字段”入口，打开带无障碍名称“提取字段与表头”的原生dialog；使用已有literature-help-dialog样式。弹窗支持从零新增、删除、编辑表头名称、含义、单位、类型和必填。新增字段内部生成当前草稿内唯一且稳定的key，不要求研究者手写代码标识。最多50项；确认时校验非空名称（最多200字）/含义（最多500字）、唯一key与名称，以及数值字段明确单位（最多100字，可填“无量纲”或“原文单位”）。字段JSON的UTF-8总大小不得超过60KiB，为现有64KiB请求体保留外层封装空间，超出时明确提示精简而不截断。已有conditionKeys/allowedRange/allowedValues保留，不因编辑基础属性而丢失。

草稿使用新localStorage键research_literature_field_drafts_v1，格式为按job.id索引的{fields:[…]}映射；兼容缺省/损坏数据，刷新和切任务时按原job恢复。草稿自动保存，也提供“保存草稿并关闭”；保存失败在弹窗明确提示。该键仅存未确认/最近编辑的字段，不作为服务器已确认的证据，不修改research_codex_tasks_v1、冻结run_config.json或检索配置。删除草稿行不删除已有候选、全文或提取成果。

仅真实needs_attention/awaiting_confirmation关口提供“确认并继续提取”，沿用POST /api/literature/advance的{id:原job.id,until:原选择边界,confirmations:{fields}}。提交前确认until不早于extract；成功后由既有confirmations.json记录生效，失败保留草稿。检索完成后可提前编辑草稿，保存不调用/search或/advance，不自行下载全文、确认规则或启动提取。原来空字段关口改为可直接新增，不引导修改冻结检索设置。HTTP签名、全局导出与既有DOM id保持不变。

## 2026-10-19 网页与后台版本核对、数据库登录续跑

新增只读GET /api/literature/runtime：{protocolVersion:1,instanceId,startedAt,pid,port,workspaceId,loadedFingerprint,restartRequired,supportedSources:[key…],busy,browserSession:"persistent-research-browser"}。workspaceId为规范化工作区路径的摘要，不返回绝对路径。supportedSources必须来自当前进程已加载的来源注册表；加载时指纹只覆盖后端服务/连接器/来源模块和注册表等代码，不含.env、凭据、任务、浏览器资料或前端静态资源。GET比较磁盘指纹，发现后台代码更新即restartRequired=true，不把磁盘新来源冒充当前进程能力。busy涵盖当前服务正在执行的文献/本机Codex工作。该接口快速本地返回，不启动登录、浏览器或外部请求。

前端在启动新检索、继续原阶段、确认字段并执行、打开任务检索窗口之前，通过同源runtime核对协议、已加载来源和restartRequired。无接口、协议不符、后台已过期时给出“当前端口后台需要更新”的清楚提示，不再向旧后台提交任务；已有任务的查看、轮询、下载、停止保持可用。按服务返回的能力判断来源，不单凭新版静态JS白名单宣称可执行。

已有数据库登录复用范围明确为平台专用的持久检索浏览器；不读取或复制普通Edge/Chrome的cookie、密码、账户或浏览历史。可访问的结果页直接继续，不根据导航栏“登录”字样误判。真实login/verification/access_required等待时，网页自动请求打开原任务绑定的官方窗口，每轮同来源等待只尝试一次，刷新不重复弹；失败保留人工“打开登录/检索页面”按钮。unknown页面也保留手动打开与说明，不谎称已登录。完成个人/机构登录后点“检查并继续”，重新核验冻结的官方检索入口和共享会话；机构SSO另开标签页成功时，不能永远卡在旧登录标签。验证码未完成时不自动刷新或解决。页码/检索式/指纹证明与已保存成果沿用，不重新累计既有记录。

npm start与两个Windows启动入口统一委托tools/start-workbench.js并使用绝对server.js路径；Windows入口保留原18125/8123端口。同工作区、同版本已运行时复用原网址；已识别的同工作区旧版本且后台与持久记录均无执行任务时，可核验进程命令行后受控重启。其他工作区、未知进程、旧接口缺失或无法排除正在执行工作时不得按端口盲目杀进程，提示关闭相应旧启动窗口后重试；不迁移浏览器端口、不清空localStorage或任务目录。启动器行为与运行信息接口均用隔离fixture验证。

同一工作区两个端口使用单个后台执行器：另一端口由tools/workbench-proxy.js提供仅监听127.0.0.1的别名转发，保留浏览器原origin及localStorage，不再启动第二个会把另一进程running任务误判中断的LiteratureConnector。代理在重写Host/Origin前验证入站本机Host与同源Origin；仅转发到已确认同workspace的本机后台端口，不增加任意URL代理。GET/runtime在正常快照上追加proxy:{protocolVersion:1,workspaceId,pid,port,targetPort}；后台断开时返回503及相同proxy元数据，供启动器核验代理进程身份并恢复原后台端口。代理不读取.env、登录信息或任务状态，不创建任务；未知服务仍不得自动接管。

## 2026-10-20 万方首页检索与结果页识别

万方首页机构名称及个人“登录/注册”导航不构成登录阻拦。测试模式人工继续时，首页输入框与冻结检索词相同也不能单独证明已经进入结果页；只有官方页面存在实际题录或明确零结果时，才允许直接读取当前首批。停在首页时重新提交原任务已确认检索式，保留已经完成来源及候选。首页检索框的等待、填入和快照读取使用一致的可见选择器，兼容“海量资源，等你发现”提示。登录、验证码、权限和未知页面仍按实际原因暂停；不修改冻结科学规则或将阻拦页计为零命中。

当前万方首页检索按钮内含图标与“检索”两个span，按钮本身无class；识别按钮必须支持子元素文本并核对完整可见名称为“检索”或“搜索”，不能因CSS text-is仅匹配直接文本而漏掉，也不能误点“AI增强检索”。

Windows启动器核验进程命令行时，PowerShell子进程必须显式以UTF-8输出JSON，与Node解码一致；包含中文的工作区路径不能因编码失配被误判为其他服务。身份核验及无运行任务的重启条件保持严格，不因编码修复放宽路径匹配。

## 2026-10-20 WOS 中国站跳转与可恢复检索会话

WOS仍由固定官方入口进入，允许其自动跳转到精确主机webofscience.clarivate.cn；不将其他clarivate.cn子域、机构代理或相似后缀当成检索结果站。国际站与该中国站均必须核对当前检索词、Topic字段、真实题录及分页证明，空白中转页不算登录成功、零命中或检索完成。已有可用官方表单时，在同一任务标签页提交冻结检索式，避免无必要地重开国际站会话。只可使用已观察的官方页面控件和导航链接，不构造、复制中转会话参数。

WOS官方导航超时后有限检查当前标签页：若真实表单已就绪则继续原检索；明确登录、验证码或机构权限问题按原reason暂停交由用户；空白中转或无法确认会话时使用results_unrecognized和明确的WOS页面核对说明，保留原job、30条既有候选、待处理来源及续跑边界，不让该问题变成丢失来源信息的整项失败。没有官方页面/浏览器确实不可用的环境错误仍如实报错。后台不自动登录、解决验证码或确认条款。safe_url不得导出含SID的会话链接或将会话值写入日志、产物、规则及文档；官方永久题录链接沿用原校验。

已观察到中国站显示Cloudflare“Error code 524 / A timeout occurred”且Host Error的官方故障页：此状态应明确提示WOS服务端响应超时、保留任务稍后继续，不引导反复登录，也不能当验证码或零结果。可见DOM仅提取固定错误类别，不持久化整页文本、网络地址或会话信息；公共attention.reason继续使用results_unrecognized，无新增来源或任务接口。

网页显示上述固定524超时提示时，只显示官网超时与稍后原任务继续的说明，不再追加“去官方页面处理登录”或普通浏览器登录不共享的提示。原真实登录/验证码卡片及按钮行为保持不变。

## 2026-10-20 WOS最后执行、暂缓来源并继续其他来源

按用户要求，网页新建检索配置在冻结前把已选WOS移至sources末尾，其他来源相对顺序不变，并明确显示执行顺序。历史任务run_config.json、来源集合、查询及指纹保持原值；不能靠改写历史配置绕过检查点。

POST /api/literature/advance新增可选deferSource（已选来源key）。仅允许needs_attention且resumeStage=discover、与当前attention.source及检查点pending_source一致的待处理来源；拒绝未知、未选、运行中、非discover或非当前来源的暂缓请求，保留原until。网页人工等待卡提供“暂缓此来源，继续其他来源”，通过原job.id提交deferSource，不调用/search，不创建新批次。检索CLI增加--defer-source，须与--resume及有效原检查点一起使用，由Python单独原子更新调度状态；Node不直接修改检查点。

discovery-state.json可增加deferred_sources:[key…]队列，缺省为空，唯一且仅含原配置已选来源。暂缓动作把当前来源移到队尾并保留其题录、reason和分页检查点，继续未暂缓、未完成的来源。已完成来源不重跑。普通检查并继续会仅从暂缓队列移除当前pending_source以实际重试它，其他暂缓项保留。其余来源处理结束后，按队列选下一待处理来源，返回needs_attention，公共快照提供deferredSources和executionOrder（原来源中未暂缓者+队列），已有候选始终可下载。Python进度/attention事件带deferred_sources供Node同步并持久化，重启从检查点恢复真实队列。

只要仍有暂缓、登录、验证或未完成来源，候选报告discovery_complete=false、批次status=partial，不发送检索全部完成事件，不自动推进去重/全文。网页列明待补检来源；暂缓不等于零命中、删除来源或科学方案变更。末页与正式模式原分页、测试每来源10条、字段确认及所有凭据保护沿用。WOS无响应时可以保持暂缓，登录/验证码留在各任务绑定的官方窗口由用户处理。

暂缓动作可接受网页草稿与原任务仅sources排列不同（集合相同、其他规则全部一致）的情况：按原job.config/原until执行调度，并恢复该任务配置显示，以executionOrder体现新的实际顺序。来源集合、检索式或其他规则变更仍拒绝混入原任务；普通检查并继续的冻结一致性规则保持不变。

### 2026-10-20 Windows 检查点原子替换的短暂锁重试

共享 Python `atomic_write_text` / `atomic_write_json` 保持同目录临时文件、flush/fsync、关闭句柄后 `os.replace` 的原子性。仅当替换遇到 `PermissionError` 或 Windows 共享/锁冲突（winerror 32/33）时，按50、100、200、400、800毫秒最多重试5次；其他错误立即抛出。持续失败仍抛出原错误并尽力清理临时文件，保留已有目标文件，不删除旧目标、不改为直接覆盖、不自动修改属性/ACL。该保护不把永久权限问题声称已修复，也不改变任务配置、来源队列或断点语义。测试使用隔离临时目录和模拟替换失败，核对一次失败后成功、持续失败旧文件完整、共享冲突可重试及其他错误不重试。

## 2026-10-20 历史文献任务删除与恢复

按用户要求，每条历史文献任务提供“删除”按钮；采用可恢复删除，仅在原job.json登记deletedAt，不移动或删除任务目录、候选、全文、进度和冻结配置。运行中的任务拒绝删除，提示先停止；重复删除幂等。POST /api/literature/delete与POST /api/literature/restore接收{id}，沿用现有本地同源及X-Workbench防护；仅可操作规范校验的任务id。删除记录不得被advance、browser或新阶段执行使用，须先恢复。

GET /api/literature/jobs缺省隐藏deletedAt记录；includeDeleted=1可返回供恢复的记录，公共快照提供deletedAt（缺省null）。网页历史区域提供“查看已删除”入口，已删除记录仅显示“恢复”，恢复后原job.id和成果仍可查看/继续。删除当前已选历史任务时停止该任务的网页轮询并解除当前job绑定，保留对话和科学规则草稿；不启动新检索。其他任务不受影响，刷新及后台重启后删除状态仍保持。用隔离fixture验证删除、重启、恢复、非法id和运行中拒绝，不删除真实测试成果。

旧后台遗留的磁盘running记录、在当前单一后台无活任务时，删除可先走既有loadPersisted中断恢复规则核验为interrupted，再登记删除；不把确实仍在运行的live任务或browserOpening视为中断。恢复后保持核验的中断状态及原成果，避免历史记录永远无法删除。

## 2026-10-20 WOS结果框出现但题录列表未加载

用户截图显示WOS官方页已有检索式、3,129条总数及2/63页码，而题录列表为空。不能据此认定零命中、未登录、已完成或平台造成翻页；测试每库10条原流程不会自动翻到第2页。

WOS等候条件必须核验可见题录标题，而非仅存在app-record等空组件。对原任务绑定的官方结果页空列表，先在同一页有限等待，仍未出现题录则以results_unrecognized和固定消息“WOS结果页面已打开，但文献列表尚未加载。请在原页面确认文献题名出现后再检查并继续；已有候选保留。”暂停，不能自动重提检索、重开全球站或改变页码。真实登录、验证码、权限、524仍用原分类；没有确证官方结果页的情况沿用原入口检查，不从总数伪造文献。仅写固定加载状态，不导出正文、账户或会话链接。

WOS当前页没有已加载题录时禁止触发下一页；正式整页采集若可见题录组件尚未全部出现标题，也应等待或暂停，不能把部分渲染的题录视为整页完成。原任务冻结配置、页码证明、来源队列和40条既有候选保持。网页对该固定加载提示不追加重新登录指引。验证使用隔离DOM/模拟页面：空壳不就绪、延迟加载成功、超时原页保留、真实auth/524优先、空列表不翻页；不解决验证码或自动登录。

## 2026-10-20 知网检索式空格编码与已显示结果的续跑

用户截图的知网官方结果页已有实际文献题名和机构访问标识，但检索框显示broiler+"heat+stress"，与冻结的broiler "heat stress"不同。CNKI官方已知检索入口的kw参数必须使用百分号编码空格（%20）而非表单编码加号；研究者真正输入的加号仍编码为%2B，不能在校验时将所有加号擅自替换为空格来冒充匹配。其他来源编码不变。

继续沿用原job和绑定的知网页面、已确认检索式与原阶段；出现真实登录或验证码时保留原人工处理流程。已显示检索框值仍优先于URL参数作一致性校验，不能因URL可解码成正确query而读取实际检索框错误的结果。编码修正后从官方入口提交原规则并有限等待实际题录；题录或检索式仍无法核对时明确停留为未完成，不把页面上可见结果自动视为下载成功，也不重新累计已完成来源。隔离验证覆盖空格、引号、真实加号与中文、原错误页面拒绝及修正后同任务读取，保留40条已有候选和冻结配置。

网页attention.reason为results_unrecognized仅代表检索页面/题录一致性尚未通过，展示后台原说明，不再一律追加登录或普通浏览器登录不共享提示；真正login、verification、access_required继续展示原人工访问说明。WOS页码/检索式不符的提示也使用这条显示规则，避免用户已看到题录却被引导反复登录。

## 2026-10-20 单页加载60秒硬时限与暂缓后的后续处理

按用户要求，各检索来源一次页面加载/候选获取从调用适配器起最多60秒；正式分页每次新页重新计时，成功翻页的长任务不按总运行一分钟强停。超时必须由可终止的隔离工作进程中止该次操作，返回当前source的attention/results_unrecognized和明确“加载超过1分钟，已暂停；已有结果保留”的说明，再由Python主驱动原子保存检查点及候选并发出attention。不能只靠浏览器goto超时、前端倒计时或仍会在后台继续操作的线程；不得杀掉研究者的持久浏览器、清除登录信息，迟到工作结果不得污染检查点。现有source/page/frozen query与已完成来源保持，网页轮询后显示“当前需要处理”。依赖安装等准备工作独立说明，不算已开始的页面加载。

出现新的60秒加载超时时，网页将相应“当前需要处理”卡片滚动到可见位置，并以aria-live提示；同一次超时只自动提示一次，不在重复轮询时不断抢滚动位置。已暂缓状态不按新超时再次弹出。

固定来源worker由固定守护进程监视真实父进程，主驱动被停止或退出时结束该worker；守护进程自身不操作网页或杀浏览器，worker退出后守护也退出。监控握手必须成功后才执行适配器，监控失败安全报错；守护的60秒兜底与runner超时使用同一attention说明，不误报成一般失败。Windows使用进程同步句柄，禁止以os.kill(pid,0)探测进程。

Windows虚拟环境启动器可能产生不同于实际脚本的PID；Node阶段及Python worker/守护均必须定位实际解释器进程，同时保留原虚拟环境和UTF-8。Node固定只读解释器探针最多5秒，结果仅内部缓存，探针结束后再次核对任务仍在运行；探针期间已停止的任务不得迟到启动阶段。取消验证须证明实际脚本退出且没有迟到写入，不能只证明启动器退出。

全部剩余未完成来源均已在deferred_sources时，公共快照提供deferredOnly=true，并清楚显示“已暂缓，当前没有其他待检索来源”；仍是未完成，不能把唯一暂缓来源又描绘成刚检索失败。网页提供“补检该来源”及查看原页面，不提供会原地循环的再次暂缓按钮；其他来源仍未尝试时原“暂缓此来源，继续其他来源”行为不变。derive状态从原CP验证，不只凭网页缓存推断。

为使暂缓不阻挡已有候选的处理，新增显式POST /api/literature/continue-available（本地同源/X-Workbench，与现有路由防护相同），仅接受{id,until}，until为dedupe至export。仅原任务未删除、非运行且deferredOnly、已有>0条已保存候选时允许。该动作建立一个独立的后续处理运行：以原candidates.json/CSV和冻结run_config.json的原样快照为输入，从dedupe开始，不调用检索或改写原任务；原来源队列、题录、页码和后续补检入口保持。新运行公共processingBasis记录parentJobId、candidateCount、deferredSources、候选快照SHA256及createdAt，明确是基于部分来源的现有结果；不得宣称WOS等暂缓来源已经检索完成。该运行的discover阶段仅表示输入快照就绪，后续字段确认、全文获取、提取和校验沿用原流程，不自动批准研究规则。

网页在已暂缓状态显示“用已有N条候选继续去重”（或用户所选后续阶段），点击才创建后续运行并绑定，原任务仍可在历史找回补检。后续运行始终展示“基于现有N条候选；待补检来源：…，当前快照不代表全部来源已检索完成”，后续补检不自动混入这个快照；暂缓来源可能已有部分页成功获取，其已有记录仍保留在输入，不能一律声称该来源完全未包含。不得因暂缓动作本身自动推进去重。所有新增状态、运行和快照重启后可恢复。隔离测试验证60秒默认硬时限及超时无迟到写入、暂缓只有一来源、无结果/未尝试来源拒绝继续、父任务字节不变、新运行只从dedupe启动、删除/运行中拒绝、HTTP防护与UI不循环。

## 2026-10-20 全文获取页面复用、访问异常暂停与正文证据

### 2026-10-20 知网来源应用错误与下载中转入口

知网明确显示“来源应用不正确(01)”或类似来源/链接失效提示时，须按页面错误立即暂停并保留原页，不得当摘要保存、继续后续文献或称为已下载；HTTP200的可见错误页同样识别。此消息不能直接判定用户未登录或触发反爬。错误DOM和旧缓存正文复核都覆盖该情况。

检索中保留的bar.cnki.net/bar/download/order等带上下文的中转链接不当作可长期复用的全文直链。程序不得改造会话参数、伪造Referer/Origin或重放以绕过来源校验。历史候选/冻结规则保持原样；无有效单篇详情入口的知网项在发请求前停为需要补充官方入口，由用户在知网的正常详情/检索页面操作后继续。单条临时错误不能静默拖累后续状态为成功，也不能通过反复访问中转链接尝试“修好”。

全文获取使用原任务专属的一个工作标签页，顺序处理同篇文献时复用该页；按用户补充要求，只有全文已保存并校验、状态已落盘后才关闭这个任务页面，下一篇按间隔新建，不能逐篇创建保留新标签，不接管或批量关闭研究者既有标签。验证码、登录、权限、限流、404、加载超时等异常保留原页并立即暂停本阶段，不继续批量请求或自动重试。知网截图404只能认定页面错误，不能声称已确证反爬。按站点设置固定访问间隔，等待中显示进度；该间隔仅减少请求压力，不用于绕过任何验证或访问限制。登录/验证仍由用户在该任务页完成后显式继续。原检索标签及登录状态保持；只有任务自己新增的下载页面或弹窗可关闭。网页加载与文件生成/传输分别显示，下载必须等待真实浏览器下载完成、文件实际落盘；不能将“已点击下载”当完成、提前关闭页面或以反复新开页面催促下载。文件传输受本任务整个全文阶段的时间预算和用户停止控制，不套用网页导航60秒时限，停止仍可结束实际驱动；不得声称浏览器下载接口已有独立的每篇硬截止。

不能以整页文本超过2000字符判定全文。PubMed题录、Scopus题录、知网/万方摘要页、导航、参考文献列表和错误页不算正文；只有确认的PDF或具有正文证据的文章内容才能标fetched_pdf/fetched_html。HTML保存正文区域而非整页导航，确认文章匹配及正文结构，无法确认则保守标摘要/待补充，记录固定原因。可从当前可见页面的合法全文链接继续访问，不猜造知网会话或下载URL，不绕过付费与权限。

既有fetched_html缓存需按新规则离线复核；保留原文件和复核前状态备份，摘要及错误缓存降级后不得进入数据提取。新增本地同源POST /api/literature/review-fulltext仅收{id}，仅非运行的全文相关任务可离线复核，禁止网络或检索。复核后原任务保持待人工确认、resumeStage=fulltext，原冻结配置、候选、去重及处理依据保持；已执行后续提取的任务拒绝自动复核，避免静默改写下游成果。网页提供“复核已保存全文”，显示正文、摘要、待补充和人工处理数量，并允许原任务显式续跑；不自动重新下载49篇，不自动进入提取。

即使本次目标选择提取、校验或完整流水线，正常全文获取结束后也停在fulltext_ready人工核查关口，resumeStage=extract；核对全文状态、摘要/待补充与提取字段后，用户显式继续才进入提取。复核后的“继续获取全文”按钮仅运行到fulltext，不自动扩大到提取；只续跑pending/needs_attention项，已有摘要与待补充项不自动重复请求。原全文任务页按钮仅显示已有绑定页，不新建或导航网页；未绑定时明确提示，不能冒报打开成功。离线复核和显示原页使用已有Python环境，不触发依赖联网安装。

## 2026-10-20 知网正常页面进入与单篇下载

用户已确认从提供的官方检索入口手动可打开目标文献。知网下载应对原候选做单篇定位：在任务专属页进入官方检索入口，按该候选完整题名定位，核对官方域名、可见检索词及唯一完全匹配结果行，再真实点击题名；后续仅点击详情页实际存在的全文/下载控件，不把抽出的临时href复制为goto地址，不伪造来源头或改写凭证。单篇定位不改变原检索规则、候选、去重、批次或原父任务页面，不新增文献。域名/检索词/题名/DOI无法核对、结果不唯一或入口不存在时明确暂停，不误点相似文献。

详情或下载若产生新页面，只能接管由本次任务页的真实点击打开、opener可核实的页面；确认后交接任务绑定并关闭自己旧的定位页，不接管普通浏览器标签。登录、验证、机构权限、来源错误、限流、页面错误时保留任务当前页，显式继续仅检查当前页和继续正常控件流程，不重播旧中转链接、不循环点击下载。文件生成与下载事件等待有进度，必须捕获真实完成的下载或PDF正文并校验后才返回成功；成功文件及状态落盘后沿现有关闭逻辑关本任务页。

已标为待补入口的知网项不得自动整批重试。新增同源POST /api/literature/retry-cnki接收{id,paperId}，仅已暂停全文阶段、原去重目标中的知网单篇、无下游成果且有既有状态时允许；固定CLI --resume --only <paperId> --retry-unavailable --limit 1，只重试这一篇并在全文核查关口停下，不重新检索、不自动进入提取、不改冻结配置。网页逐篇列出待补知网题名及“重试这篇知网文献”，按钮需用户明确点击，不把手动打开成功等同于已下载。回归覆盖不重放中转、标题不匹配/多结果不点击、合法详情流程、popup所有权、延迟下载只点一次、验证码暂停及单篇恢复范围。

单篇执行期间以cnkiRetryPaperId持久保存范围；登录/验证暂停、失败、停止及后台重启后保持同一篇，网页“继续这篇知网文献”仍使用该单篇接口，服务端拒绝通过普通继续动作扩大到整批。文件成功保存后清除此范围，任务仍为needs_attention/fulltext_ready、resumeStage=fulltext，全文阶段不标整批完成，不进入提取；其他文献须显式另行继续。停止恰逢文件保存时，离线复核若确认该篇已成功获取全文则清除范围，未成功则继续保留，不因此陷入无法继续的状态。

## 2026-10-20 修改计算统一方案

修改计算使用既有 `research_tasks_v1.rulesByModule[moduleId]` 中的草稿、已确认文本及版本作为唯一可执行方案。顶部名称改为“计算修改方案”，由“查看 / 编辑修改方案”打开既有规则弹窗，流程为讨论、编写候选方案、人工审核通过、按方案修改并计算；编辑草稿不改变已审核版本，执行前若草稿与已审核版本不同则拒绝执行，须重新审核。底部不再渲染第二份计算修改文档卡及其独立 compose/code 执行入口；直接计算及其他模块不变。

历史 `mod.doc` 原样保留，在弹窗的 `.task-previous-plan` 折叠区只读展示，可由用户明确点击复制到草稿后再审核；不自动覆盖既有方案、不自动审核。该类仅增加折叠区的间距、边框和字号，文本沿用已有 `.doc-content`；不新增存储键、Store API 或全局对象。原规则版本继续有效，生成执行指令携带审核版本。人工审核模块继续使用原有意见记录与通过/退回状态；说明需区分执行前方案审核与执行后成果审核，不声称已具备自动绑定计算版本或跨模块退回能力。

## 2026-10-20 绘图完整流程

绘图复用任务规则弹窗，唯一方案保存在既有 `research_tasks_v1.rulesByModule[moduleId]` 的草稿、已审核文本及版本；底部不再显示第二份绘图方案卡。可上传 CSV/TSV/Excel/JSON/TXT，在只读对话中查看数据、讨论图型与科学口径，审核后显式生成。草稿有未审核变更时禁止执行。旧 `mod.doc` 仍可只读核对并手动复制为草稿。

`POST /api/codex/run` 对 plotting 新增执行支持，execute=true 必须带 `plotPlan:{text,version,inputNames,previousRunId?}`；服务端校验非空已确认文本、版本、实际输入及同会话历史版本，保存方案、输入 SHA-256 与模型。每次运行使用独立输出目录，生成图像与绘图代码，不覆盖旧版本。普通绘图对话仍只读。沿用所选本机 Codex 模型、网络关闭与仅本次输出可写的执行沙箱。首次读取绘图数据或生成时由服务器在项目 `.venv` 准备 requirements-plotting.txt 中的公开绘图依赖，过程显示进度；失败有明确错误，不声称出图成功。

新增 `GET /api/codex/plots?session=...` 返回 `{runs:[{id,status,createdAt,finishedAt,planVersion,planHash,model,previousRunId,inputFiles,files,error}]}`，按新到旧排列，从磁盘记录恢复，停止和失败也保留。新增 `GET /api/codex/preview?session=...&name=...` 仅以核对过的 PNG/JPEG/WebP 类型内联提供本会话输出，沿用下载的路径边界校验；SVG/PDF 与代码仍通过附件下载，不能以内联 HTML 执行。

绘图区域显示当前版本、预览、图片/代码/绘图数据下载及修改意见。讨论修改时明确所选历史版本且不执行；核对修订方案后生成新版本，刷新后仍可找回。`research_codex_tasks_v1` 兼容扩展绘图视图选择与反馈草稿，不改变旧字段。TaskManager 新增 `openPlan()` 供绘图区域打开同一方案弹窗，不建立第二份文本或确认状态。新增 CSS 类 `.plotting-results`、`.plotting-preview`、`.plotting-feedback`、`.plotting-downloads`、`.plotting-meta`。不新增脚本或 Store API。

### 2026-10-20 下载弹窗记录与单篇重新定位

弹窗经本次任务页真实点击、opener及准确target ID核对后，立即持久化pending_popup见证（仅父子target ID、操作阶段及原paper/title hash，不保存会话URL）。暂停及重启后仅按此记录找原页，再核对所有权及官方来源，不挑选最近标签或相似网址。交接须先原子保存新绑定再切换内存页；关闭已证明的旧定位页失败单独登记cleanup_target_id，不误报所有权失败，全文与状态保存后再按准确ID清理自己的旧页。首次PDF响应可能早于popup事件，只可接收本次操作、当前任务页opener可核实的主框架官方PDF响应，不监听并处理其他研究者页面。

官方origin的blob下载页仅在本次操作已取得真实download/PDF响应并校验文件后允许完成，不能单凭blob地址、正常窗口或用户看到页面便声称已获取全文。来源、额外弹窗、所有权、交接失败使用各自固定诊断；不将它们一律称为未登录或反爬。真正登录、验证、限流及页面错误仍保留原页暂停。

旧版本未登记弹窗时，普通继续不得凭猜测接管或重播下载。新增显式POST /api/literature/restart-cnki，仅{id,paperId}、仅当前持久单篇范围且尚未获取全文、无运行/下游成果时可用；固定CLI在原单篇参数上增加--restart-cnki。网页“重新定位这篇知网文献”需明确点击，说明将从这一篇正常检索入口重新执行一次，其他文献及原成果保持；只本次忽略旧步骤，后续暂停仍沿新记录恢复，不自动反复重新定位。CLI也须验证resume、only恰好一项、limit=1、retry-unavailable和真实知网来源，拒绝整批/已下载项/与只读模式混用。

用户补充：正常弹窗仍是带PDF下载按钮的文献详情页，不等于PDF已经取得。对由本次已核对点击打开、见证完整且target ID不同的新官方页，只有再次核对同篇题名/DOI、唯一可见下载控件且无登录/验证/购买要求后，才可执行该新页一次下载点击；持久保存已点击target ID和次数，整次单篇最多两次下载控件点击，同页及恢复时不重复点击。循环回原页、身份不明或超过次数均暂停，不能无限跟随详情页。最终仍以真实文件校验及状态保存为完成依据。

已有见证的待交接弹窗或待清理旧页仍存在时，重新定位不得擦除该记录或另开流程，须先按准确target继续/处理原页；仅精确核验该target已关闭或不存在后，才可清理失效记录再重新定位，不找替代页。已绑定官方blob页的恢复同样须有见证且接收到新的真实合法文件事件，只存在blob地址时仍暂停。

打开原全文任务窗口时，有有效pending_popup见证且准确子窗口仍在、opener与原任务相符的，优先显示该待处理子窗口，不能悄悄展示父详情页造成核对对象混淆；仅bring_to_front，不接管、导航或改绑定。记录丢失或所有权不符时明确提示，不借其他窗口。

弹窗初始地址可能仍在正常跳转；仅对本次有见证的准确窗口最多观察60秒，等待它自然进入可核验官方页，不主动重提导航、点击下载、扩展允许域名或绕过浏览器提示。该时限独立于父页的文件生成状态。超时来源诊断只显示安全的协议、域名和固定类别，绝不保存或展示用户信息、路径、查询、v/token、fragment及具体端口；安全官方页上的真实404、来源错误或登录提示优先显示对应原因。普通继续只检查原记录中的窗口。

浏览器下载记录只证明曾触发传输，不能凭GUID文件名、大小或截图当作平台已取得全文，也不扫描浏览器下载目录猜文件。对本次已核对题名的真实点击，下载事件还须关联已点击target或其持久direct-opener窗口；仅官方来源的真实download/主框架PDF响应并通过文件校验才能交付。先处理已到文件事件，再等待旁支弹窗跳转；已校验的官方文件不因旁支窗口地址未获页面操作许可而丢弃。未知旁支仍不接管、导航或点击，只有opener已证明且准确ID可核验时登记为文件与状态保存后的cleanup_target_id；记录冲突或关系不明则暂停。下载小窗口已关闭时，已捕获的真实文件事件仍可完成保存，缺失事件不得从截图或任意目录补造。

## 2026-10-20 全文续跑、重复复用与材料类型

### 正文与补充材料清单（2026-10-20 补充）

材料获取按每篇文献执行：在已核对身份的官方详情页检查实际可见的补充材料入口，保留原入口的真实点击上下文，再获取正文。正文优先原版 PDF，已验证的网页正文作为并存材料或未取得 PDF 时的后备；补充 PDF 不得误认成正文 PDF。Excel、Word、PDF、CSV、ZIP 及其他补充材料保留下载原格式，既不统一转成 PDF，也不把下载链接或摘要当作已取得原件。只有网站明确声明无补充材料才标 `none_declared`；没找到入口或尚未核查分别为 `unknown` / `uninspected`，不得自动宣称齐全。

新增 `fulltext/materials.json`（`version:1`）：每篇记录 `paper_id/title/doi/main_pdf_status/main_pdf_reason/supplement_check/materials`。每件材料记录 `material_id/role/label/filename/path/format/mime_type/size/sha256/source_key/download_status/download_reason/read_status/read_reason/reused_from`。`role` 为 `main_pdf/main_html/supplement`；保存状态为 `pending/downloaded/missing/needs_attention`；读取状态为 `not_checked/readable/partial/unreadable/unsupported`。清单持久化不保留带会话参数的补充材料 URL。正文保存与每件附件落盘后立即分别更新状态，最后才确认并关闭本任务拥有的下载窗口；读不了的已保存原件仍为 `downloaded`，窗口清理失败也不能降为未下载。

本任务与历史任务的已有材料按同篇强身份、原候选/冻结输入及文件 SHA 核对后复用。不可只凭题名相似、文件名相同或材料编号复用；版本冲突、已登记原件丢失或 SHA 不符需人工核查，不静默覆盖或重下。继续任务先补齐材料检查，保留已存正文与附件；不会因 `unreadable/unsupported/partial` 而重复下载同一原件。材料下载收到后可暂存于本任务私有暂存区，恢复时仅核对本任务持久见证与 SHA，不扫描浏览器下载目录或重放临时下载链接。

新增只读 `GET /api/literature/materials?id=...`，返回安全投影 `{schema:1,papers,legacy}`；网页“每篇材料清单”使用大弹窗逐篇展示保存、可读性、缺失原因和原件下载。无清单的旧任务只读投影已有正文状态，补材标尚未核查，不创建清单或触发运行。有清单时，新增材料只有被登记为已下载、实际文件有效且位于任务安全目录内才能通过原下载接口取回；拒绝越界、符号链接、Windows 特殊路径。下载清单 JSON 也只返回安全字段，不泄露未知 URL 或凭证字段。

离线读取支持 PDF 文字、XLSX 单元格、DOCX 段落/表格、CSV/TSV、TXT/JSON/XML/HTML，并提供文件名及页码、工作表/单元格或段落/表格位置。ZIP 保留原包，有限度在内存检查安全成员，不在文件系统解包执行。旧 Office、CAJ、图片、扫描/加密或损坏文件等未能读取时明示原因；公式不重算，文本、页数、行列和压缩成员限制触发时标 `partial`，原件仍完整保留。提取输入新增 `materials/materials_check/materials_fingerprint`，材料内容变化后既有输入必须显式重建；模型只能引用已提供且能读取的材料内容，证据注明文件及原文位置，缺失不得猜填。全文阶段结束仍停在人工材料核查关口，不自动批准字段或进入提取。

本次功能安装只修改程序与离线样例；用户未要求继续之前，不恢复现有文献检索、下载或提取任务。

知网单篇定位需保留完整科学题名（包括 L-/D- 等前缀）。可见检索词被官网改写而唯一完整题名仍在时，只允许在该任务原官方页通过唯一普通检索表单真实提交一次加双引号的完整题名；提交前后持久记录步骤和查询摘要，恢复不得反复提交。官网仍改写、无唯一控件或提交不确定时按实际原因暂停，不能删除前缀或借其他窗口通过校验。任务原绑定 target/hash 相符且已进入同篇可核验详情时，可从该详情继续，不再要求返回结果页。题录未加载仍受一分钟时限；查询改写、题名不符、同名多项与加载等待分别显示具体原因。

下载前检查本任务及同级历史任务的已确认全文，只有严格同篇身份且本地文件证据有效才复用。DOI、知网永久文献标识或完整题名＋年份＋作者须一致，身份冲突、题名相似、概率合并、摘要、导航空壳及没有状态证明的孤立文件均不得作为复用依据。HTML须通过正文结构、身份及精确文件SHA核验；PDF须通过实际文件格式和完整性证据，旧记录缺少可靠下载证明时须另核对PDF正文身份。解析依赖不足不能误报文件截断或偷偷重复下载已有同篇，保留原文件并提示人工核查。复用采用原子本地复制并登记来源任务/原文献/文件SHA与匹配依据，不改源任务、原候选、去重或冻结配置；仅复用的条目无需启动浏览器，保存成功的网络请求页仍在文件与状态落盘后才关闭。

去重中 `needs_review` / `merge_confidence=probable` 的相似组并非已确认同篇。全文读取时按各原 candidate_id 分别建立目标，保留待审核标记及各自作者年份，不静默少取其中一篇；冻结去重文件和实际组数保持。提取前核查这些独立成员均出现在全文清单中，旧清单遗漏成员时明确要求回全文阶段补齐，不自动改写任务或开始下载。

页面材料类型区分PDF正文、网页正文文本、仅题录/摘要（非全文）、待补充、待人工处理与尚未处理。网页正文TXT是已验证正文区域的文本，不承诺同时包含原PDF版式、图片或补充附件。已保存文件数不能当作全文篇数；元数据URL、空文本及带有“摘要”导航标签的空壳不证明取得摘要。新获取须看到实际摘要段才可标摘要；显式离线复核也重查旧 `abstract_only` 条目，原文件和复核前status备份保留，空白/导航降为待补充，不自动再次请求网站。


## 2026-10-20 并列准备与模型汇合

侧栏按“准备资料 · 三条并列路径”和“汇入模型 · 计算与结果”分组，新增 `.workflow-group-title`、`.workflow-preparation-actions` 样式。缺少的准备环节可独立添加，也可直接建立计算入口。新建任务的 start=download/clean/literature/calculation 仅建立所选入口，不虚构已完成的准备工作。计算讨论可以读取三条准备路径中已确认的规则作为来源上下文，仍须确认本次计算方案；不自动复制文件，也不把来源规则当作计算执行授权。

兼容沿用 fa_state_v1 与各任务快照键；未增加持久化依赖字段。旧任务恢复时按旧 type 或旧固定顺序识别模块，再排序，保留所有有效环节，不因计算方式为空删除下游。切换 direct/modify/历史子方式不删除历史环节与文件。


## 2026-10-20 数据下载与文献执行分离

下载模块的主入口为“按方案开始下载”：下载方案卡片、顶部规则弹窗执行按钮与文件区按钮统一调用 CodexUI.openDownload，再调用现有 /api/codex/fetch-source；不再调用 LiteratureUI.start。该入口只获取已核对的公开 HTTP(S) 文件，当前每次1–5个、每个20MB，数据库查询页、按年筛选、分页 API 或超限文件不能显示为已支持或已下载。下载方案有未审核修改时，旧规则不能继续授权新下载。下载后显示真实成功/失败与文件清单，人工核对后可交给清洗。

文献检索、筛选、材料获取和数值提取归文献挖掘模块。LiteratureUI.start 对 download-data 拒绝新文献运行；下载模块中既有误入的文献批次保留为折叠只读记录（可刷新状态、停止旧批次、下载已有成果），不自动把旧批次的检索问题注入下载对话，不提供继续文献提取或新批次入口。清空或覆盖原记录均不属于迁移。

workflowPrompt 按模块分别描述实际工具：下载对话帮助确定数据源、年份、范围、指标与实际文件地址；仅文献挖掘提示词提供文献执行能力说明。原 download-dialog 的 DOM id、现有下载 API 和存储键保持不变。


## 2026-10-20 继续讨论与 AI 修订方案

已有文档的方案卡片（包括已审核状态）提供“AI 总结并修改方案”，调用 /api/ai/compose 的 mode=doc，新增可选 revision={baseDoc:{content,status,updatedAt,approvedAt}}。请求沿用本模块的模型配置，携带完整当前方案与最近讨论。服务端明确只整理已确认规则、保留未变更内容，建议和冲突仍待确认；仅输出完整修订草稿，不执行任务、不自动审核。旧请求无 revision 时保持原行为。

AI 返回前若当前方案已被编辑/审核/替换或模块不再存在，拒绝覆盖；错误、空或超限响应不改变原方案。修订成功调用 saveDoc 后状态回 draft，执行入口继续依审核状态控制。ModuleSpace.isBusy 增加方案生成中的状态，避免切换任务或同时开始下载/计算。输入框中未发送的文字保持原样并提示先发送。

新增独立存储键 fa_doc_history_v1（不改变 fa_state_v1 或 module.doc 结构）：{[moduleId]:[{content,status,updatedAt,approvedAt,archivedAt}]}。saveDoc 覆盖已有有效文档前归档原版本；已审核文档打回前同样归档。归档失败时不覆盖原文档。Store 新增 getDocHistory(moduleId)->历史版本深拷贝数组；同一版本不重复归档。方案卡片的折叠历史可查看并恢复为草稿，恢复仍通过 saveDoc，当前版本先归档，恢复不自动审核或执行。浏览器备份/恢复包含新键，旧备份无此键仍可读取。新增 CSS 类 .doc-plan-history、.doc-plan-version。

## 2026-10-20 实际文件地址与下载提示

下载窗口明确区分已审核方案和实际文件地址；文字方案不会自动变成数据库导出请求。新增静态节点 #download-site-help（按方案内容显示 FAOSTAT 贸易矩阵官方入口与手动导出/上传路径）、#download-sources-hint（地址格式及大小限制）。#download-sources 全宽显示，空清单、超过5项、非 HTTP(S)、带登录凭据、示例域名以及 FAOSTAT 查询页地址均在浏览器明确提示并禁用开始按钮；仍在提交时复核，服务端安全检查保持。

官方帮助链接 #download-faostat-link 仅为用户点击后在新标签打开的普通导航（固定 https://www.fao.org/faostat/en/#data/TM，target=_blank、rel=noopener noreferrer），不加载资源或发起前端第三方请求。check-contract 仅豁免这一个完整静态导航标签，其余外部 URL 检查不变。

方案中的普通网页链接不自动填入清单；只预填带已支持文件扩展名的候选地址，用户仍须核对。已有手填清单保留。FAOSTAT 全库包不冒充2024年单年文件；本次不增加数据库连接器、不提高20MB限制、不执行真实下载，也不改变用户方案、审核状态或历史文件。

## 2026-10-20 FAOSTAT 官方整包下载与按年交付

本节更新前述通用20MB下载器的能力边界。download-data 已审核方案包含 FAOSTAT TM/详细贸易矩阵时，“按方案开始下载”直接启动官方获取任务，无需填写文件地址。服务端从固定官方目录 datasets_E.json 定位 TM 的 FileLocation，仅允许 bulks-faostat.fao.org/production/ HTTPS ZIP；不使用模型生成的下载地址。方案解释只读已审核文字，提取年份及明确代码/指标限制，无法确定或不支持的限定应在执行前报错，不忽略限制。原方案与SHA256冻结到任务记录。

新增 API（沿用同源和 X-Workbench 保护）：POST /api/codex/source/start {sessionId,rules,confirm:true,backend?,model?,settings?,credential?} ->202；GET /api/codex/source/status?session=...&id=...；POST /api/codex/source/cancel {sessionId,id}；POST /api/codex/source/resume {sessionId,id,confirm:true,rules}。返回持久化作业 {id,sessionId,kind:'faostat-tm',status,stage,message,progress,config,archive,deliverables,error,createdAt,updatedAt}。状态 running/completed/failed/cancelled/interrupted。进程重启后的旧 running 记录标 interrupted；不自动重新下载，用户可按同一方案继续。刷新网页仅恢复查看原任务，不新建重复下载。每个会话及本进程同一时刻仅允许一个官方整包任务。

新增 tools/source-transfer.js 流式下载（官方 ZIP 上限2GiB），沿用公网DNS校验、IP固定、TLS证书与代理配置；重定向仍限官方主机。记录真实字节、Content-Length、最终地址、ETag/Last-Modified、SHA256。支持带验证器的Range续传，响应不支持续传时从头重下；不把中断文件当作成功。整包缓存仅在大小和SHA复核通过后复用；筛选失败仍保留完整原包。缓存与半成品位于未公开的 .workbench/source-cache、会话 .source-staging 中。

新增 tools/faostat-download.js 与标准库脚本 tools/faostat_filter.py：流式读取ZIP内主CSV，验证安全成员、CRC、字段、年份与行长度，仅筛选所选年份和已明确限制，原列顺序、文本代码、数值、单位、Flag保留；不补零、去重、换算或合并。全库包保留在本次 output/<id>，按年CSV在 input/<id>，来源/配置/行数/哈希报告及筛选脚本在 output/<id>。交接仅交付筛选CSV，不把整库原包自动当作单年输入。CodexBridge.importInput 本地复制上限提升到2GiB，原上传/手动通用小文件下载接口仍为20MB，界面分别说明。

浏览器现有 research_codex_tasks_v1 条目新增可选 sourceJobId、sourceBasis（冻结方案）；不改变旧 download 字段。可见 .source-download-progress 显示实际下载字节与筛选行数，支持停止、同方案继续、下载原包和结果；首次点击及继续均核对当前审核方案。结果仍待人工检查后交接，不自动通过研究验收。新增 source-job 的 run-state.json 供启动器识别运行状态，后台运行时不重启服务。后端版本指纹纳入新增执行文件。

同一API也支持kind='files'：方案已含公开文件链接时自动建任务，每批最多5个、每个2GiB；不含可执行数据源的方案保留兼容手动入口，不宣称已接入任意数据库。通用文件任务与FAO任务共用进度、停止、持久化、继续、文件下载和清洗交接语义。CodexUI.openDownload(mod,basis?,options?)新增可选options.manual=true供旧手动入口兼容；默认优先自动执行已接入的数据源。

## 2026-10-20 官方分类自动核对修复

FAOSTAT配置filters增加可选itemNames、reporterNames、partnerNames。解释方案时允许保留研究者给定名称，由ZIP内官方ItemCodes、Elements、ReporterCountries、PartnerCountries字典精确匹配后确定代码；不能要求研究者事先提供机器可查的代码、单位、下载URL和文件大小。代码筛选仍须有方案依据，官方名称匹配必须唯一，不采用相似度、子串扩展或模型猜代码。有限中英文别名只转换查询名称，实际代码和单位始终来自官方字典；不支持或多义的名称须显示候选并暂停。

筛选前输出lookup进度与官方映射（请求名称、实际名称、代码、单位、字典文件及行号），保存在report.officialMappings和report.resolvedConfig，作业config采用经官方解析后的代码。原始字段及文件保留；年份可用性由实际扫描核验。方案中旧的20MB/来源技术信息待核对/尚未执行等状态，不自动升级为额外人工审批；明确禁止某种获取方式或仍缺研究范围决定时继续遵守。

## 2026-10-20 下载文件交接的失效会话恢复

CodexBridge.session 对确实不存在的会话目录抛出 code=SESSION_NOT_FOUND、sessionId；目录仍在但 input 缺失时为 SESSION_INCOMPLETE，不视为可自动替换的会话。/api/codex/* 错误响应保留这两个机器字段，前端 request 将其连同 HTTP status 保留在异常上。无效标识、网络错误、权限错误、运行中状态均不得触发会话重建。

“确认文件并进入清洗”先验证清洗接收会话；仅在服务端明确报告该目标 SESSION_NOT_FOUND 时，先验证下载源仍可读取，再创建清洗接收区并更新该清洗模块的 sessionId。只追加恢复说明，原方案、规则、对话、下载记录及源会话不变，不重新下载、不执行清洗。已有接收区继续使用并保留其中的文件；目录不完整时提示保留现场核查。

已交接的按钮再次点击时须验证该接收区及 inputBatch.names 后再跳转，避免凭旧 confirmed 标记跳入失效会话；接收区确已丢失时可重新交接现存源文件。文件复制成功后才确认本次下载交接；运行中的连续点击被 busy 拦截，已交接且文件仍在时不重复复制。源会话缺失时明确提示找回原文件，禁止创建空下载源或假报成功。

## 2026-10-20 规则执行按钮的忙碌同步与版本核对

TaskManager 新增 refreshControls()：仅更新规则窗口的按钮、版本状态及 #task-rules-execution-status（role=status），不重填草稿、不保存或改写规则。ModuleSpace.render 与 CodexUI.render 在忙碌状态变化后调用此方法，确保 AI 回复完成、上传结束或任务失败后，打开的弹窗及时恢复可用；禁用按钮须有明显样式及具体原因。

清洗规则与修改计算/绘图方案同样采用“草稿修改→重新确认→执行”的版本核对。编辑或载入历史只更新草稿；不得沿用旧确认版本执行新草稿。准备文件期间使用仅内存的 startingExecution 锁拦截重复启动，准备完成后重新核对任务、模块、确认文本、版本及草稿；发生变化则取消准备并提示，不发执行请求。准备失败必须解除锁并恢复控件。

仅修复交互与执行请求连接，不自动改动研究者已确认的规则内容，不自动决定比例分母等科学口径，也不因修复而启动真实清洗。

规则窗口增加 #task-rules-discuss“继续讨论完善规则”。讨论在平台当前模块对话中进行：AI 先核对现有材料和已确认决定，再主动提出影响下一步的少量关键问题；未决问题不转为已确认规则。CodexUI.prepareRuleDiscussion(id) 清除本次/持续执行标记并使用只读讨论模式；讨论及候选规则提取均不调用 prepareConfirmedExecution，不运行清洗、不新增确认版本。研究者在平台讨论后点击 AI 提取候选规则、确认规则，再执行。

规则状态、操作按钮和反馈位于 .task-rules-footer，弹窗滚动时固定在可视区底部，避免长规则把执行入口和禁用原因挤出窗口。

## 2026-10-20 清洗成果分组与打包

clean-data 的文件区按所选运行显示“主要结果、检查报告、待处理问题”，默认折叠“辅助文件”（代码、字段说明、无记录的检查清单）和“原始文件”。未知结果数据继续显示在主要结果，不丢弃或删除原始/历史文件。已知文件名提供中文用途标签；空问题表只表示没有列出记录，不代表正式验收通过。只读元数据读取不能执行输出脚本。

GET /api/codex/clean-results?session=<UUID>&run=<可选UUID> 返回 {sessionId,runId,runs:[{id,updatedAt,fileCount}],groups:{main,reports,issues,auxiliary},inputs,otherFiles}。组内文件 {name,group,size,label,rowCount?,empty?}；默认选择最新有文件的输出目录，切换运行仍可找回历史。小CSV依据逻辑记录数显示行数；超出有界读取范围、解析不确定时不报精确行数，不把未知当空。分类是展示用途提示，不替代研究判断。

GET /api/codex/clean-results/archive?session=<UUID>&run=<UUID> 返回当前所选运行ZIP，含该运行的结果、代码及说明，不含其他运行或原始input。运行中拒绝打包；仅普通受控文件，拒绝路径越界、符号链接及敏感文件，跳过内部run-state.json，最多300文件、整体2GiB；以流式方式制作临时ZIP并在响应结束后清理，不改源文件。接口沿用Host/Origin/X-Workbench保护；普通同源附件导航沿用download接口许可。

展示使用 .clean-results、.clean-result-section、.clean-result-file、.clean-result-heading、.clean-result-meta、.clean-result-aux。只更改clean-data结果区，其他模块的文件展示不变。
