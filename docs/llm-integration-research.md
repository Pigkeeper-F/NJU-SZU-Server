# 调研：接入 API Key，让模型编辑「模块选项卡」的内容

> 调研日期：**2026-09-22**（来源链接见 §8）
> 目标：在底部对话框输入文字 → 由模型**执行操作**去改模块选项卡的内容（改名 / 写入内容 / 追加消息 / 新建模块…），而不是只回一段文字。
> 本文只谈"怎么做、有什么坑、选哪条路"，并对本项目给出可直接实施的落地设计与契约变更提案。**代码尚未实施**。

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 |
|---|---|
| 浏览器能不能直接调 LLM？ | **看供应商**：OpenAI 官方 **不能**（服务器不加 CORS 头，必然报 `blocked by CORS policy`，官方立场就是"要你走服务端"）；Anthropic **能**（要加 `anthropic-dangerous-direct-browser-access: true` 头）；Gemini 的 OpenAI 兼容端点 **不能**；国内多数 OpenAI 兼容网关**要实测**（见 §3.4 探测脚本）。 |
| API Key 放前端安全吗？ | **不安全**。前端代码/网络面板里任何人都能提取 Key 并盗刷。OpenAI 的 SDK 专门加了 `dangerouslyAllowBrowser` 来劝退；Anthropic 的开关名字里直接写了 `dangerous`。**唯一正当例外是 BYOK**（用户填自己的 Key、只在自己浏览器用）。公开部署必须走代理。 |
| 让模型改 UI 内容，用什么机制？ | **原生 Tool Calling（function calling）为主**：模型输出 `tool_calls`，你的代码执行并回传结果；**文本围栏 DSL 作兜底**（不支持 tool calling 的模型）；**JSON 补丁**适合"整块内容替换/批量操作"。三者可组合：工具参数内部就是一个 JSON 补丁。 |
| 本项目能直接上吗？ | 不能直接上：现有契约**明令禁止 `fetch` 与外部 URL**、且要求 `file://` 可用。需要一次**有意识的契约修订**（§6.2）：只有 `js/llm.js` / `js/agent.js` 两个文件允许联网，且 AI 功能在 `file://` 下必须优雅降级。 |

---

## 1. 现状与约束（为什么这件事在本项目里要"设计"而不是"写几行"）

现有硬约束（见 [`contract.md`](contract.md) §2）：

1. 零依赖：不用框架、SDK、CDN；
2. 禁用 `fetch`、`crypto.subtle`、ES module、外部 URL；
3. `file://` 双击 `index.html` 必须完整可用；
4. 状态只能通过 `Store` API 写入，UI 由 `renderAll()` 全量重渲染；
5. 5 个静态节点**禁止重建**（只改属性），否则丢焦点与半截输入。

新需求与之冲突的点：**"联网调模型"必然违反第 2 条**，且 `file://` 下页面 origin 为 `null`，跨域请求基本不可用（第 3 条）。所以本方案的核心是：**把联网能力限制在明确的白名单文件里，并让主功能不依赖它**。

---

## 2. 调研结论 A：三条部署形态（决定安全模型）

### 2.1 形态对比

| | ① 浏览器 BYOK 直连 | ② 自建代理（**推荐**） | ③ 云函数 / Workers |
|---|---|---|---|
| Key 存哪 | 用户浏览器 localStorage（用户自己的 Key） | 服务端环境变量 / Secret | 平台 Secret |
| 能不能公开部署 | ❌ 不能（Key 在访问者手里） | ✅ 可以 | ✅ 可以 |
| CORS 问题 | **取决于供应商**（OpenAI 无解） | 无（同源/自己加头） | 无 |
| 额外组件 | 无 | Node/Python 小服务（仓库名 `NJU-SZU-Server` 正好承接） | 一个 JS 文件 + `wrangler deploy` |
| 适合 | 个人本地自用、内部工具、BYOK 产品 | **团队协作项目（现在这个）** | 无服务器团队的快速方案 |
| 实现成本 | 最低 | 低（~60 行） | 低 |

### 2.2 关键事实（有据可查）

- **OpenAI**：浏览器直连必然 CORS 失败；官方论坛/社区的标准答案就是"搭一个后端代理"。Cloudflare Workers 方案被广泛采用（十几行代码：收请求 → 从环境变量读 Key → 转发 → 回包时加 CORS 头）。
- **Anthropic**：2024-08 起官方支持 CORS，**但必须显式加头** `anthropic-dangerous-direct-browser-access: true`，否则报 `authentication_error: CORS requests must set ... header`。官方同时强调：之所以叫 dangerous，是因为"把 Key 放进客户端代码"是反模式；**BYOK 场景例外**。
- **通用风险**：Keys 在客户端代码里即使用压缩混淆也能被提取；"未认证的代理"同样危险（别人可以拿你的代理刷你的 Key）——**代理必须做认证/限流**。

### 2.3 对本项目的建议

- **本地/演示**：形态①，但只作为"BYOK 本地自用"——Key 只存浏览器 `localStorage`，**永不入库**，页面上明确写"仅本机自用"。
- **团队/上线**：形态②，在仓库里新增 `server/`（Node 或 Python 都行，零依赖 http 模块即可），`server/.env` 存 Key 并加入 `.gitignore`，前端把 `baseURL` 指到 `http://localhost:8787/v1/...`。
- 因此落地设计里要有 **两个开关**：`baseURL`（指向官方/网关/自建代理）+ `apiKey`（本地 BYOK 时填）。

---

## 3. 调研结论 B：让模型"编辑模块内容"的三条技术路线

### 3.1 路线 1：原生 Tool Calling（推荐）

机制（以 OpenAI 兼容协议为例）：请求里带 `tools`（每个工具有 `name` / `description` / `parameters` JSON Schema）→ 模型返回 `finish_reason: "tool_calls"` 且 `message.tool_calls[]` 内是 `{id, function:{name, arguments(JSON 字符串)}}` → 你执行工具 → 把结果作为 `role:"tool"` 的消息回传 → 模型再产出最终文本（或继续调用工具，形成循环）。

要点：

- `strict: true` 可让结构化输出更可靠（会预处理 schema）；`tool_choice` 支持 `auto` / `required` / `none`；`parallel_tool_calls: false` 可强制一次只调一个工具（便于顺序执行 UI 操作）。
- Anthropic 的形态不同：返回 `tool_use` block，你要回 `tool_result`（含 `tool_use_id`）；语义一致、字段不同，**适配层要分别处理**。
- 工具设计最佳实践（来自调研）：动词开头命名、描述具体（写清边界与返回条数）、参数逐个写 description、粒度"一个工具完成一个完整操作"、**敏感参数不要暴露给模型**（由宿主注入）。

**本项目建议的工具集**（参数内部就是"模块级操作"）：

```jsonc
[
  { "name": "create_module",
    "description": "在依赖链末尾追加一个新模块，返回新模块 id。用于把用户的需求拆成后续步骤。",
    "parameters": { "type":"object", "properties": {
      "name": { "type":"string", "description":"模块名，建议 2~12 个中文字符" } },
      "required": ["name"], "additionalProperties": false } },

  { "name": "rename_module",
    "description": "重命名指定模块（不改内容与依赖关系）。",
    "parameters": { "type":"object", "properties": {
      "module_id": { "type":"string", "description":"目标模块 id，取自上下文中的模块列表" },
      "name": { "type":"string" } }, "required": ["module_id","name"], "additionalProperties": false } },

  { "name": "set_module_content",
    "description": "整体替换某个模块的正文内容（纯文本/Markdown 源文）。会覆盖原内容。",
    "parameters": { "type":"object", "properties": {
      "module_id": { "type":"string" },
      "content": { "type":"string", "description":"新的正文，纯文本，不要包含 HTML 标签" } },
      "required": ["module_id","content"], "additionalProperties": false } },

  { "name": "append_message",
    "description": "向某个模块追加一条消息（用于把计划、结论、待办写入该模块）。",
    "parameters": { "type":"object", "properties": {
      "module_id": { "type":"string" },
      "role": { "type":"string", "enum": ["assistant","system"] },
      "text": { "type":"string" } }, "required": ["module_id","text"], "additionalProperties": false } },

  { "name": "delete_module",
    "description": "删除链尾模块；若非链尾会被数据层拒绝（会被回传错误，请改用提示用户）。",
    "parameters": { "type":"object", "properties": { "module_id": { "type":"string" } },
      "required": ["module_id"], "additionalProperties": false } }
]
```

> 注意 `append_message` 的 `role` 只允许 `assistant`/`system`——**不允许模型伪造 `user` 消息**（否则会污染"谁说的"这一事实）。

### 3.2 路线 2：结构化 JSON 补丁（JSON Patch / 自定义 ops）

让模型输出一个补丁对象（`{ops:[{op:"replace", path:"modules/2/name", value:"订单校验"}]}` 或自定义 `{type:"rename", id, name}` 数组），前端校验后批量应用。

- 优点：一次调用可以表达**多个**修改；与"撤销"天然契合（保存 ops 列表 → 反向应用即回滚）。
- 缺点：不依赖原生能力时约束更弱，必须自己写 **严格校验**（字段白名单、id 必须存在、长度上限）与**容错**（解析失败就要求模型重发或降级为纯文本回复）。
- 适用：`response_format: {type:"json_schema", ...}` 或 prompt 强约束。**建议与路线 1 组合**：`set_module_content` 的参数里放"整块内容"，批量场景再引入 `apply_ops` 工具。

### 3.3 路线 3：文本围栏 DSL（兜底）

要求模型把操作写在围栏块里，例如：

````
```ops
rename_module 模块2 订单校验
append_message 模块2 | 已加入字段校验说明
```
````

- 优点：任何模型（哪怕不支持 tool calling）都能用；解析器 30 行写完；人类可读可审查。
- 缺点：容易与正文混排（要严格匹配围栏 + 只解析白名单动词）；无 schema 校验。
- 适用：作为**降级通道**——检测到模型未返回 `tool_calls` 时，扫一遍围栏块。

### 3.4 三条路线对比与选型

| | 路线 1 Tool Calling | 路线 2 JSON 补丁 | 路线 3 围栏 DSL |
|---|---|---|---|
| 可靠性 | 高（模型原生训练） | 中 | 中低 |
| 兼容性 | 需模型支持（主流都有） | 中 | 高 |
| 实现成本 | 中（工具定义 + 循环） | 中（校验 + 容错） | 低 |
| 可撤销/审计 | 中（记录调用日志） | **最好**（ops 即补丁） | 中 |
| 建议 | **主通道** | 批量/撤销场景增强 | **兜底** |

---

## 4. 交互与安全设计要点（决定"好不好用"和"会不会出事"）

1. **上下文打包**：发给模型的不该是"全站历史"，而是 `系统提示 + 当前模块(名/依赖/内容) + 模块列表(id/名/依赖) + 最近 N 条消息`。给 token 设预算（如最近 20 条或 4000 字符），超出从最旧开始丢。
2. **流式反馈**：`stream: true` 边收边渲染（见 §5.3 解析），并显示"思考中/调用工具中"状态（`reasoning_content` 字段是国内推理模型常见的思考内容，可选择性展示）。
3. **危险操作要可回滚**：改内容前对受影响模块做**快照**；UI 上给「撤销上一次 AI 修改」。删模块这类破坏性操作建议**要求用户确认**（或一律拒绝，交给用户手点）。
4. **内容不可信**：模型产出的文本一律用 `textContent` 写入（**禁止 innerHTML**），长度上限（如 20k 字符），工具参数逐项校验（id 必须存在于当前状态、字符串长度、枚举值）。
5. **失败处理**：CORS/401/429/超时要给出**能看懂的错误**（"Key 无效/额度不足/该网关不允许浏览器直连"），并保证 UI 不被卡住；网络失败不得破坏已有数据。
6. **不要自动重试破坏性操作**；同一会话最多一轮工具循环（如 4 步）防死循环。
7. **Key 的处理**：只存 `localStorage`（键如 `fa_llm_config`），输入框用 `type=password`，页面明确提示"仅存本机浏览器"；**任何情况下不写进源码、不提交、不放进 URL**。公开部署时改为代理模式，前端不再持有 Key。

---

## 5. 针对本项目的落地方案

### 5.1 文件与职责（新增，不动现有五个脚本的边界）

| 文件 | 职责 | 允许联网 |
|---|---|---|
| `js/llm.js` | 配置（baseURL/model/key，读写 `localStorage.fa_llm_config`）+ 请求（非流式/流式）+ SSE 解析 + 错误归一化 | ✅ 唯一网络出口 |
| `js/agent.js` | **工具定义** + `tool_calls` 执行循环 + 工具→`Store` API 的映射 + 上下文打包 | ❌（纯逻辑） |
| `js/settings.js`（可选） | 设置面板：填 baseURL / model / key，测试连通性 | ❌ |
| `docs/llm-integration-research.md` | 本文 | — |

### 5.2 `Store` 需要新增的 API（写入契约 §4，供 agent 调用）

```js
Store.getModule(id)                  // -> module 深拷贝 | null（当前只有通过 getState 间接读）
Store.updateModule(id, patch)        // patch: { name?, content? } -> boolean（字段白名单校验）
Store.setModuleContent(id, text)     // -> boolean（正文；长度上限 20000 字符）
Store.appendMessage(moduleId, text, role)   // 已存在 ✅
Store.snapshot()                     // -> 快照 id（用于撤销）
Store.undo(snapshotId)               // -> boolean（回滚到快照）
```

> 现有 `module` 结构需要增加一个 **`content` 字段**（模块正文，与 `messages` 列表并列）——这是"模块选项卡的内容"的落点；**属于数据结构变更**，按协作规则 §4 必须：先改契约 → 通知协作者 → 处理老数据兼容（新字段缺失时按空串处理，`fa_state_v1` 可不升版本）。

### 5.3 关键代码骨架（可直接演进为实施）

**① 非流式请求（P0 最小可用）**

```js
// js/llm.js 片段——全项目唯一允许 fetch 的文件
function chatOnce(cfg, messages, tools) {
  return fetch(cfg.baseURL.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model, messages: messages, tools: tools, stream: false })
  }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 200)); });
    return r.json();
  }).then(function (data) {
    var m = data.choices && data.choices[0] && data.choices[0].message;
    if (!m) throw new Error("响应格式异常");
    return m;                       // { content, tool_calls? }
  });
}
```

**② 工具调用循环（agent 视角）**

```js
// js/agent.js 片段
function runTurn(userText) {
  var msgs = buildContext(userText);            // 系统提示 + 模块列表 + 当前模块 + 最近消息
  for (var step = 0; step < 4; step++) {        // 最多 4 步，防死循环
    var msg = LLM.chatOnce(cfg, msgs, TOOLS);   // 同步风格由调用方 await
    if (!msg.tool_calls || !msg.tool_calls.length) return msg.content;
    msgs.push(msg);
    msg.tool_calls.forEach(function (call) {
      var out = applyTool(call.function.name, safeParse(call.function.arguments)); // 校验+执行
      msgs.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
    });
  }
  return "（已达单轮工具调用上限，请拆分指令）";
}

function applyTool(name, args) {                // 工具 → Store 的映射（唯一写入口）
  switch (name) {
    case "create_module":     return { ok: true, module: Store.addModule(args.name) };
    case "rename_module":     return { ok: Store.renameModule(args.module_id, args.name) };
    case "set_module_content":return { ok: Store.setModuleContent(args.module_id, String(args.content).slice(0, 20000)) };
    case "append_message":    return { ok: !!Store.appendMessage(args.module_id, String(args.text).slice(0, 20000),
                                       args.role === "system" ? "system" : "assistant") };
    case "delete_module":     return Store.removeModule(args.module_id);   // 非链尾会被拒，原样回传 reason
    default:                  return { ok: false, reason: "未知工具" };
  }
}
```

**③ 流式 SSE 解析（P2）**：`fetch(..., {stream:true})` 后用 `response.body.getReader()`，按 `\n\n` 切事件、取 `data:` 行、遇 `data: [DONE]` 结束；`chunk.choices[0].delta.content` 增量追加到气泡（`tool_calls` 的增量同样按 `index` 拼接 `arguments` 字符串）。注意：**`EventSource` 不能发 POST**，所以流式只能走 fetch/XHR，不能用 EventSource。

**④ CORS/连通性探测脚本**（先跑这个再写代码，避免白干）：

```js
// 粘到浏览器控制台（在目标页面的 origin 下执行）
fetch("https://你的网关/v1/models", {
  headers: { "Authorization": "Bearer 你的Key" }
}).then(r => r.text().then(t => console.log("HTTP", r.status, t.slice(0, 300))))
  .catch(e => console.error("失败（多半是 CORS 或网络）:", e.message));
```

### 5.4 契约修订点（实施时必须一起改 `docs/contract.md`）

1. §2 硬性约定新增例外：**`js/llm.js` 是唯一允许使用 `fetch` 与外部 URL 的文件**；其余文件保持禁令。
2. `tools/check-contract.js`：把 `js/llm.js` 加入"禁用能力白名单"（其余 js 仍然扫码），并新增检查"`agent.js` 不得直接 fetch"。
3. §2 补一条：AI 功能需要 `http(s)` 环境；`file://` 下 `LLM` 不可用，UI 必须优雅降级（禁用输入并提示"AI 功能需通过本地服务器打开页面"）。
4. §3 数据结构增加 `module.content` 字段（老数据缺失按 `""` 处理）。
5. §4 增加 §5.2 列出的 6 个新 API；§5 事件表增加 `module:update`。
6. 新增配置键 `fa_llm_config`（登记到 §6 持久化小节；含 `baseURL/model/apiKey`，**其中 apiKey 属于本机敏感信息**）。

### 5.5 UI 变更点

- 侧栏（`sidebar.js` 负责区）底部加一个「⚙ 设置」入口 → 弹层填 `baseURL / model / apiKey`，带"测试连通性"按钮（复用 §5.3④ 探测）。
- 输入区（`chat.js` 负责区）：发送时若 AI 已配置，则走 `Agent.runTurn()`；顶部状态条显示「模型：xxx / 调用工具中…」；新增「撤销 AI 修改」按钮。
- 未配置 Key 时：行为**完全不变**（只本地记录消息），并在 `.composer-hint` 里提示"未配置模型，仅本地保存"。

### 5.6 分阶段实施建议

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | `llm.js` + 设置面板 + 非流式单轮问答（只回文本，不改状态） | 控制台能收到模型回复；CORS/错误提示正确 |
| **P1** | `agent.js` 工具调用：`rename_module` / `set_module_content` / `append_message` | 说"把模块2改名为订单校验"→ 卡片名字变了；改内容 → 模块正文更新 |
| **P2** | 流式显示 + 工具调用过程可视化 + `snapshot/undo` 撤销 | 断网/中断不脏数据；能一键回滚 |
| **P3** | 代理模式（`server/`）+ 限流认证；`create_module/delete_module` 的确认框 | 前端不再持有 Key；未认证请求被拒 |

---

## 6. 实测清单（实施后用它验收）

1. **连通性**：§5.3④ 探测脚本返回 200；`/models` 能列出模型名。
2. **工具调用冒烟**：问"把 模块1 改名为 需求澄清"→ 期望模型返回 `rename_module`；UI 卡片名更新；浏览器控制台可见 `[event] module:rename`。
3. **内容写入**：问"在 模块2 写入三段验收标准"→ 期望 `set_module_content`；正文渲染为纯文本（无 HTML 注入）。
4. **越权与异常**：让模型删中间模块 → 期望 `delete_module` 返回 `{ok:false, reason:"有下游模块依赖，不能删除"}` 并由模型转述给用户，**数据不变**。
5. **降级**：清空 `fa_llm_config` 后刷新 → 一切回到"纯本地"行为，功能不报错。
6. **`file://` 场景**：双击 `index.html` → AI 入口显示为不可用并提示原因。

---

## 7. 风险与开放问题

| 风险 | 说明 | 缓解 |
|---|---|---|
| Key 泄漏 | 前端 BYOK 模式下 Key 对**能接触该浏览器的人**可见 | 只本机自用；公开部署走代理（P3） |
| 浏览器直连被 CORS 拦 | OpenAI 官方无解；部分国内网关允许 | 先探测（§5.3④）；不行就走本地代理 |
| 模型乱改数据 | 工具调用把内容改坏 | 快照 + 撤销；危险操作二次确认；参数白名单校验 |
| 流式实现复杂 | SSE 增量拼接（尤其 `tool_calls` 的 arguments 是分片到达） | P0 先非流式；P2 再上流式 |
| token 成本 | 每次带模块列表 + 最近消息 | 上下文预算裁剪；只发必要字段（id/名/依赖） |
| 项目硬约束被破坏 | 契约禁止 fetch，容易"顺手"在别处也联网 | `check-contract.js` 白名单机制 + review 检查项 |

---

## 8. 参考来源（检索日期 2026-09-22）

**CORS 与浏览器直连**
- OpenAI 前端直连必然 CORS、需后端代理（中文排查文）：https://www.volcengine.com/article/1763817
- 前端直调 OpenAI/Gemini 兼容端点的 CORS 报错与 `x-stainless-*` 头绕过讨论（Google 官方论坛）：https://discuss.ai.google.dev/t/gemini-api-cors-error-with-openai-compatability/58619
- 前端存 Key 的三大错误 + 未认证代理同样危险（Backmesh）：https://backmesh.com/blog/openai-api-mistakes
- OpenAI / Anthropic 的 REST API 本就不面向浏览器直调（CORS 背景）：https://api.xabcnews.com/elonmusk/status/2yRPLASGASYTHdd4C
- Cloudflare Workers 代理实践：Key 存 Secret、前端永不接触、天然解决跨域（Easton）：https://eastondev.com/blog/zh/posts/dev/20251201-workers-api-proxy
- Anthropic 开放 CORS：需 `anthropic-dangerous-direct-browser-access: true`（Simon Willison）：https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/
- 同上（中文摘要）：https://getcoai.com/news/claudes-api-now-supports-cors-requests
- 浏览器直调 Anthropic 的 150 行实现与 BYOK 场景说明（dev.to）：https://dev.to/sendotltd/calling-the-anthropic-api-directly-from-the-browser-a-150-line-byok-comparison-tool-for-opus--nh
- 未加该头时的实际报错（NextChat issue）：https://github.com/ChatGPTNextWeb/NextChat/issues/5429

**工具调用 / 结构化输出**
- OpenAI Function calling 官方最佳实践（`strict` / `tool_choice` / `parallel_tool_calls`）：https://www.cnblogs.com/mingupupu/p/18385274
- Tool Use / Function Calling 原理与工具设计最佳实践（命名/描述/粒度/错误处理）：https://learnagent.org/library/foundations/tool-use-fundamentals
- Function Calling 与 ReAct 的差异、Chrome/GLM 实现原理：https://qiankunli.github.io/2024/06/22/llm_function_calling.html
- Tool Call 设计与编排（工具即协议）：https://zsc.github.io/mm_agent_tutorial/chapter3.html

**OpenAI 兼容端点与流式**
- DeepSeek 的 OpenAI 兼容面、SSE 与 tool calling、`reasoning_content`：https://docs.getbifrost.ai/providers/supported-providers/deepseek
- DeepSeek 流式接口规范（`text/event-stream`、`data: [DONE]`）：https://asyncapi.apis.io/asyncapis/deepseek/deepseek-asyncapi
- DeepSeek SSE 偶发中断的已知问题：https://github.com/deepseek-ai/DeepSeek-V3/issues/1608
- Kimi（Moonshot）OpenAI 兼容说明与 SDK 切换 `base_url`：https://platform.kimi.com/docs/api/overview
- Kimi 从 OpenAI 迁移示例（`tool_choice: "required"`、`tool_calls` 循环）：https://platform.kimi.com/docs/guide/migrating-from-openai-to-kimi
- 阿里云百炼（含 Kimi/GLM 等）工具调用与流式示例：https://help.aliyun.com/zh/model-studio/kimi-api

> 说明：本文引用的价格/字段/接口细节以各供应商文档为准，产品迭代快；实施前请用 §5.3④ 的探测脚本在本机复测。
