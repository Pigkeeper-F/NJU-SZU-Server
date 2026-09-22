# 流程智能体 Web 前端 · 接口契约（v1，由 T1 交付）

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
│   └── app.js          # T5 交付：window.App（装配 + 订阅）
└── docs/
    └── contract.md     # 本文件
```

---

## 2. 硬性技术约定

1. **零依赖**：不用任何框架/库；禁用 ES module（`import`/`export`/`type="module"`）、
   `crypto.subtle`、外部 CDN、外部字体与图片。全部用传统 `<script src>` 普通脚本。
2. **两种运行模式**：双击 `index.html` 可使用本地 UI 与 localStorage；要启用 AI 回复则运行
   `npm start` 并从 `http://localhost:8123/` 打开。前端只允许以 `fetch` 调用同源
   `POST /api/ai/chat`，不得直接访问第三方模型服务或携带 API Key。
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

**依赖链语义**：`addModule()` 永远追加到数组末尾，并把 `dependsOn` 设为当前最后一个模块的 id，
因此天然形成强依赖链 `模块1 → 模块2 → 模块3`（首模块 `dependsOn === null`）。
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

- 顺序固定为 `store.js → sidebar.js → tabs.js → chat.js → app.js`（`index.html` 已写好，勿改）。
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
4. 可选：发送后追加一条本地占位助手回复（`setTimeout` + `Store.appendMessage(id, '（本地演示回复）', 'assistant')`），
   **不得**发起任何网络请求。

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
