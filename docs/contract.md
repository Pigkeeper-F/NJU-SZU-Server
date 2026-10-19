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
  dependsOn: null,            // 上游模块 id；由 addModule 追加时 = 前一个模块 id；首模块为 null
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

**依赖链语义**：模块只能按「下载数据 → 数据清洗 → 计算 → 文献挖掘 → 人工审核 → 绘图」固定顺序追加，
计算方式可选「直接计算」「参数更新」「活动数据更新」；后两者在计算后插入对应子模块。模块名不可任意设置。
校验层保证 `dependsOn` 只能指向数组中**更靠前**的模块 id ⇒ 不可能出现环。

**删除规则**：若存在任何模块的 `dependsOn === 目标 id`，删除被拒。配合链式结构，即"只有链尾可删"。

---

## 4. Store API 精确签名（照抄调用）

```js
// —— 读 ——
Store.getState()                            // -> state 深拷贝（只读快照）
Store.subscribe(fn)                         // -> unsubscribe()；fn(evt)，evt = { type, payload }
                                            //    注册时不立即回调，只在变更后回调

// —— 模块链 ——
Store.addModule(name?)                      // -> module 深拷贝（追加到链尾；name 省略时自动「模块N」；
                                            //    同时把 activeModuleId 指向新模块）
Store.selectModule(id)                      // -> true | false（id 不存在 -> false；
                                            //    已选中同一个 -> true 且不触发事件）
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
| `module:remove` | `{ id, module, activeModuleId }` | 删除链尾模块成功后 |
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
