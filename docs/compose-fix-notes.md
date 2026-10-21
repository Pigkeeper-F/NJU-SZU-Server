# 「AI 生成标准文档」失败修复说明

日期：2026-10-21　　项目：研序·研究工作台（flow-agent-web）

## 摘要

按钮失败的根因是**服务端只调了上游一次、既不重试也不换模型**：
免费通道 `minimax/minimax-m3.1-flash:free` 拥塞时返回 429
`Upstream model provider is temporarily unavailable.`，这一条错误被原样抛给浏览器，
于是「点一下 = 一次抛硬币」。现在服务端会退避重试、并在拥塞时自动切到同一网关的其它
**免费**通道；额度不足 / Key 无效这类重试无用的错误则**快速失败**并给出一句人话提示。

改动落在 `server.js` 与 `js/chat.js` 两个文件，均未引入任何新依赖。

---

## 一、复现与根因

### 1.1 实测复现（用 HEAD 原始代码跑）

把 `git show HEAD:server.js` 放到临时副本、`PORT=8126` 起服务后：

```bash
curl -s -w "HTTP=%{http_code} TIME=%{time_total}s\n" -X POST http://127.0.0.1:8126/api/ai/compose \
  -H "Content-Type: application/json" -H "Host: 127.0.0.1:8126" -H "X-Workbench: 1" \
  --data-binary @compose-body.json
```

结果：

```
HTTP=502 TIME=125.993393s
{"error":"Upstream model provider is temporarily unavailable. Please try again in a moment."}
```

与主人看到的红字**逐字一致**。

同一份代码打 `/api/ai/test` 却正常：

```
HTTP=200 TIME=7.379693s
{"ok":true,"latencyMs":7377,"model":"minimax/minimax-m3.1-flash:free","reply":"pong"}
```

### 1.2 根因

| 环节 | 原始实现 | 问题 |
|---|---|---|
| `handleCompose` | `await callModel(cfg, [...], 300000)` | **只调一次**。上游一抖动就红字，没有任何重试、换模型的机会 |
| 错误映射 | `upstream.status >= 400 && < 500 ? 400 : 502` | 拥塞（429）与「额度不足」（400）混为一谈，都按上游原文抛给前端 |
| `handleChat` | `await callModel(cfg, messages)` | 同上，聊天也会被免费通道的抖动直接打断 |

关键点：`/api/ai/test` 之所以能过，是因为它只发一个 `pong` 的短请求，**短请求容易挤进去**；
而 compose 要生成整篇《环节标准文档》，长请求在拥塞时段的通过率显著更低——
**所以这不是 Key / 协议 / 配置问题，是长输出请求撞上了免费通道的拥塞窗口**。

### 1.3 上游错误分两类（决定了处理策略）

实测 commandcode 网关：

| 上游原文 | HTTP | 含义 | 该不该重试 |
|---|---|---|---|
| `Upstream model provider is temporarily unavailable...` | 429 | 通道拥塞 | **该**（退避重试 / 换通道） |
| `You have insufficient credits to make this request...` | 400 | Key 没余额 | **不该**（换模型也没用） |
| `Invalid 'Authorization' header or token.` | 401 | Key 无效 | **不该**（立即失败） |

### 1.4 网关模型目录实测

`GET {AI_API_BASE_URL}/models` 返回 96 个模型。逐个真发《环节标准文档》请求实测：

| 模型 | 状态 | 耗时 | 四小节 | 结论 |
|---|---|---|---|---|
| `minimax/minimax-m3.1-flash:free` | 200 | 45.8s | 4/4 | 可用（主人当前主通道，内容最充实，偏慢） |
| `reflection/beam:free` | 200 | 4.8s | 4/4 | **可用，最快最稳** |
| `ornith/ornith-1.5-122b:free` | 200 | 36.9s | 4/4 | 可用 |
| `stealth/glyph-cluster:free` | 200 | 63.1s | 4/4 | 可用（最慢，最后兜底） |
| `poolside/laguna-s-2.1-free` | **429** | 0.9s | — | 免费但**限流**，实测直接拒，**不进链** |
| `minimax/minimax-m3.1-flash` | 400 | 1.0s | — | insufficient credits，**不进链** |
| `MiniMaxAI/MiniMax-M3` | 400 | 0.6s | — | insufficient credits，**不进链** |
| `MiniMaxAI/MiniMax-M2.7` | 400 | 0.7s | — | insufficient credits，**不进链** |
| `MiniMaxAI/MiniMax-M2.5` | 400 | 1.7s | — | insufficient credits，**不进链** |

---

## 二、改了哪几处

### `server.js`（7 处）

1. **新增错误分类 `UpstreamError.kind`**
   原来只有 `status`，现在多一个 `kind`：
   `transient`（拥塞/限流/超时/空回复）、`fatal-credits`（额度不足）、
   `fatal-auth`（Key 无效）、`fatal-network`（连不上）、`invalid-request`（请求不合法）。
   调用方据此决定「重试」还是「快速失败」。

2. **新增 `describeUpstreamError(rawMessage, upstreamStatus)`**
   把上游英文报错翻成人话，并判定类别：
   - 额度不足 → `API Key 额度不足：上游拒绝继续调用。请到左下角「设置」里换一个有余额的 Key（或充值后再试）。上游原文：…`
   - Key 无效 → `API Key 无效或没有该模型的权限：请到左下角「设置」里检查 Key 与模型名是否匹配。上游原文：…`
   - 连不上 → `无法连接 AI 服务（<地址>）：请检查「设置」里的接口地址与网络。`
   - 拥塞 → 保留上游原文，走重试链路

3. **`callModel` 区分超时与连不上**
   原来所有 fetch 异常都归为「无法连接」；现在 `TimeoutError/AbortError` 归 `transient`
   （上游太慢，重试/换模型有用），其余归 `fatal-network`（配置问题，重试无用）。

4. **`callModelWithRetry` 升级为「重试 + 降级链」**
   新增第 6 个参数 `options = { fallbacks, trace }`：
   - `fallbacks` —— 降级链（模型名数组）
   - `trace` —— 回填 `{ usedModel, fallback, attempts }`，供响应里如实报告用了哪个模型
   循环逻辑：
   - **快失败**（429，毫秒级）→ 退避 1.2s/2.4s 后**重试同一模型**，往往第二次就通
   - **慢失败**（耗时 > 30s，多半是网关掐断）→ 不在同一模型上耗，**直接换下一个通道**
   - `fatal-auth` / `fatal-network` → **立即抛出**（换模型也没用）
   - `fatal-credits` → 同模型重试无意义 → **换下一个通道**（免费通道可能仍可用）
   - 链全试完仍失败 → 文案升级为
     `AI 上游暂时不可用（拥塞或限流）：已重试并依次尝试 <模型列表> 仍未成功。请稍后再试，或在「设置」里换一个模型。`
     （只列模型名，**绝不回显 apiKey**）

5. **`handleCompose` 接入重试 + 独立超时预算**
   ```js
   const COMPOSE_TIMEOUT_MS = 180000;  // 单次 180s（长输出任务，旧实现 60s 会掐断）
   const COMPOSE_ATTEMPTS = 2;         // 每模型 2 次
   const COMPOSE_BUDGET_MS = 420000;   // 总预算 7 分钟，覆盖"主模型失败 + 换 2~3 个备用通道"
   ```
   响应里新增 `modelUsed` / `fallbackUsed`。

6. **`handleChat` 同样接入重试**（本次补上的缺口）
   ```js
   const CHAT_TIMEOUT_MS = 90000;      // 单次 90s（旧实现 60s 硬超时，一抖就红字）
   const CHAT_ATTEMPTS = 2;
   const CHAT_BUDGET_MS = 150000;      // 聊天一问一答，预算比 compose 短
   ```
   响应里同样新增 `modelUsed` / `fallbackUsed`。

7. **每次上游调用写调试留痕**
   `debugRecord({kind:'ai-call', model, attempt, ms, ok, errorKind})`，
   在 `/api/debug/state` 里能直接看到「试了哪个模型、耗时多久、失败类型」。

### `js/chat.js`（3 处）

1. `postCompose` 返回值从裸字符串改为 `{ text, modelUsed, fallbackUsed }`。
2. 新增 `modelNote(result)`：**只在真的换了模型时**追加一句
   `（主通道拥塞，已自动改用 xxx 生成）`，正常通道下不打扰用户。
3. `generateDoc` / `generateCode` 相应改用 `result.text`。
   （全部走 `textContent`，未引入 `innerHTML`。）

---

## 三、降级链怎么排的

### 内置链（仅 commandcode 网关自动生效）

| 顺序 | 模型 | 角色 | 实测耗时 |
|---|---|---|---|
| 1 | `minimax/minimax-m3.1-flash:free` | 主通道（主人当前配置） | 45.8s |
| 2 | `reflection/beam:free` | 降级首选 | 4.8s |
| 3 | `ornith/ornith-1.5-122b:free` | 备用 | 36.9s |
| 4 | `stealth/glyph-cluster:free` | 最后兜底 | 63.1s |

排序原则：

- **先免费后付费，付费通道一律不进链**。4 个 MiniMax 付费通道实测全部
  `insufficient credits`，拿它们去试只是白白多等 1 秒，还会把「有余额」的错误
  误报给主人。付费通道只有在**主人自己在设置里显式指定**时才会被调用，
  此时若它额度不足，服务端会自动降级到免费链。
- **`poolside/laguna-s-2.1-free` 不进 chat-completions 链**：虽然同属免费目录，
  但在 `/chat/completions` 下实测直接 429 限流（866ms 就拒），派不上用场；
  留着只会多等几秒。
- **`responses` 协议另有一条链**：`reflection/beam:free` + `poolside/laguna-s-2.1-free`。
  网关对模型的支持是**按端点分**的，两条链必须分开配：
  - 模型目录里 `minimax:free` 与 `ornith:free` 标注的是 `["/chat/completions"]`，
    不支持 `/responses`，硬塞进去会直接 400（`not available on this endpoint`）；
  - `stealth/glyph-cluster:free` 打 `/responses` 实测 60s 无响应（不可用），
    **只留在 chat-completions 链当最后兜底**；
  - `poolside/laguna-s-2.1-free` 在 `/chat/completions` 下被限流，但在 `/responses` 下
    反而稳定（实测 200 / 1.7s），**只进 responses 链**。

  代码里这两条链分开写在 `server.js` 的 `GATEWAY_FREE_MODEL_CHAINS` 常量中。

### 覆盖方式

`.env` 里加一行即可自定义（逗号分隔，优先级最高）：

```
AI_FALLBACK_MODELS=reflection/beam:free,ornith/ornith-1.5-122b:free
```

不设就走内置链；baseUrl 不是 commandcode 的其它网关**没有降级链**
（只做同模型重试）——绝不擅自把模型名塞给不认识它的网关。

---

## 四、失败时现在是什么表现

| 场景 | HTTP | 耗时 | 文案 |
|---|---|---|---|
| 上游拥塞 | 502 | 按实际重试 | `AI 上游暂时不可用（拥塞或限流）：已重试并依次尝试 A、B、C 仍未成功。请稍后再试，或在「设置」里换一个模型。` |
| 地址不可达 | 502 | **0.003s** | `无法连接 AI 服务（http://127.0.0.1:9/v1）：请检查「设置」里的接口地址与网络。` |
| Key 无效 | 400 | **0.65s** | `API Key 无效或没有该模型的权限：请到左下角「设置」里检查 Key 与模型名是否匹配。上游原文：Invalid 'Authorization' header or token.` |
| Key 额度不足 | 400 | ~1s | `API Key 额度不足：上游拒绝继续调用。请到左下角「设置」里换一个有余额的 Key（或充值后再试）。上游原文：…` |
| 没配 Key | 503 | — | `还没有配置模型。点左下角齿轮填写接口地址与 API Key，或把 .env.example 复制为 .env 配置服务端。` |

---

## 五、主人以后该怎么用

### 结论：**不需要**在设置里配多个模型组

服务端已经内置了 3 个备用免费通道，默认「点一次就能出结果」。
主人只要保证下面任意一条成立即可：

1. **保持现状**（推荐）：`.env` 里 `AI_API_KEY` 有值、模型用
   `minimax/minimax-m3.1-flash:free`，其余交给服务端降级链。
2. 想让主通道更稳：把 `.env` 的 `AI_MODEL` 改成 `reflection/beam:free`
   （实测最快 4.8s），其余三条仍作备用。

### 什么时候才需要动设置

| 现象 | 该做什么 |
|---|---|
| 提示「API Key 额度不足」 | 去左下角「设置」换一个有余额的 Key，或充值。**重试无用**，等服务端改模型也没用 |
| 提示「API Key 无效」 | 检查 Key 是否复制完整、是否与 baseUrl 匹配 |
| 提示「无法连接 AI 服务」 | 检查接口地址与网络 |
| 频繁提示「已重试并依次尝试 … 仍未成功」 | 说明连 3 个免费通道都拥塞了，等几分钟再点；或换一个网关/付费 Key |
| 想指定自己的备用模型 | 在 `.env` 加 `AI_FALLBACK_MODELS=a,b,c` |

### ⚠️ 改了 `server.js` 一定要重启服务

Node 不会热重载。改完 `server.js` 不重启，浏览器点多少次都是旧行为——
本次主人连点两次失败，就是旧进程一直没换（详见 §六末尾的说明）。
重启方式：关掉跑着 `node server.js` 的窗口再开一次，或双击 `start-server.bat`。

### 界面上的提示

降级成功时，卡片上会多一句 `（主通道拥塞，已自动改用 reflection/beam:free 生成）`——
如实告诉主人这次是谁出的结果，不用猜。

---

## 六、验证记录（全部为实测，非推断）

| # | 验证项 | 结果 |
|---|---|---|
| ① | HEAD 原始代码复现 | HTTP **502** / 125.99s / 原文 `Upstream model provider is temporarily unavailable...` |
| ② | 模型目录与可用性实测 | 9 个模型逐个真发请求，结果见 §1.4 |
| ③ | 修复后 `POST /api/ai/compose`（默认主通道） | HTTP **200** / 51.34s / `modelUsed=minimax/minimax-m3.1-flash:free` / `fallbackUsed=false` / 3779 字 / **四小节 4/4** |
| ④ | 主通道设为付费无额度模型 `MiniMaxAI/MiniMax-M3` | HTTP **200** / 60.53s / `modelUsed=reflection/beam:free` / **`fallbackUsed=true`** / 1785 字 / **4/4** —— 降级链真的接住了 |
| ⑤ | `settings.baseUrl` 指向不可达地址 | HTTP **502** / **0.0026s** / `无法连接 AI 服务（http://127.0.0.1:9/v1）：请检查「设置」里的接口地址与网络。` |
| ⑥ | `settings.apiKey` 无效 | HTTP **400** / **0.65s** / `API Key 无效或没有该模型的权限：…上游原文：Invalid 'Authorization' header or token.` |
| ⑦ | `POST /api/ai/chat`（`module.type=clean-data`） | HTTP **200** / 5.34s / `modelUsed=minimax/minimax-m3.1-flash:free` |
| ⑧ | **假上游**（本地起一个恒回 503 的 HTTP 服务）全链路失败 | HTTP **502** / 4.98s / 文案列出 4 个模型；假上游侧记录到 **8 次请求**（4 模型 × 2 次尝试），证明降级链被完整走完 |
| ⑨ | `node tools/check-contract.js` | **ALL_CHECKS_PASS** |
| ⑩ | `node tools/test-server-exec.js` | **76 通过 / 0 失败**，`ALL_EXEC_TESTS_PASS` |
| ⑪ | 用户实际端口 8123 最终冒烟 | HTTP **200** / 134.83s / `modelUsed=reflection/beam:free` / `fallbackUsed=true` / **4/4** |

### 复核记录（2026-10-21 独立复跑，不复用上表结论）

在 `PORT=8125` 起临时服务、用 `curl` 直打实链路的复跑结果：

| # | 验证项 | 结果 |
|---|---|---|
| A | HEAD 原始代码复现（`git show HEAD:server.js` 起 8126 端口） | HTTP **502** / **126.18s** / 原文 `Upstream model provider is temporarily unavailable. Please try again in a moment.` —— 与主人看到的红字逐字一致 |
| B | HEAD 代码里 `callModelWithRetry` 的接线范围 | 只有 4 处引用，**全在研究类端点**（`research-question` / `literature-research`）；`handleCompose`（HEAD 第 1162 行）与 `handleChat`（第 765 行）都是**直调 `callModel`** —— 证实「compose 没走重试」这一根因 |
| C | 修复后 `POST /api/ai/compose`（中文环节信息） | HTTP **200** / **132.85s** / `modelUsed=reflection/beam:free` / **`fallbackUsed=true`** / 984 字 / **四小节 4/4**，且文档内容准确复述了中文 spec 的 todo 与验收标准（证明中文请求体未乱码） |
| D | 修复后 `POST /api/ai/test` 对比 | HTTP **200** / 3.38s / `{"ok":true,...,"reply":"pong"}` —— 短请求本就容易挤进，与 compose 的长请求拥塞形成对照 |
| E | `POST /api/ai/chat`（`module.type=clean-data`） | HTTP **200** / 5.48s / `modelUsed=minimax/minimax-m3.1-flash:free` / `fallbackUsed=false` |
| F | `settings.baseUrl` 指向不可达地址 `http://127.0.0.1:9/v1` | HTTP **502** / **0.002s** / `无法连接 AI 服务（http://127.0.0.1:9/v1）：请检查「设置」里的接口地址与网络。` |
| G | **假上游**回 400 `insufficient credits` | HTTP **400** / **0.0078s** / `API Key 额度不足：上游拒绝继续调用。请到左下角「设置」里换一个有余额的 Key（或充值后再试）。上游原文：…` —— 额度类错误**没有**傻等重试 |
| H | **假上游**回 401 `Invalid 'Authorization' header or token.` | HTTP **400** / **0.0075s** / `API Key 无效或没有该模型的权限：请到左下角「设置」里检查 Key 与模型名是否匹配。上游原文：…` |
| I | `node tools/check-contract.js` | **ALL_CHECKS_PASS** |
| J | `node tools/test-server-exec.js` | **76 通过 / 0 失败**，`ALL_EXEC_TESTS_PASS` |
| K | 降级链是否真的被触发（`/api/debug/state` 留痕） | 主通道 `minimax/minimax-m3.1-flash:free` attempt=1 **125700ms 失败**（errorKind=transient）→ `reflection/beam:free` attempt=1 **7153ms 成功**（fallback=true） |
| L | **主人实际端口 8123**（重启后跑修复后的代码） | HTTP **200** / **136.20s** / `modelUsed=reflection/beam:free` / **`fallbackUsed=true`** / 1584 字 / **四小节 4/4** / 响应体里**无任何 apiKey 字段** |

### ⚠️ 一个容易漏掉的坑：改完代码必须重启服务

主人点两次都失败，除了上游拥塞，**还叠加了一个「跑着的是旧代码」的问题**：

- 主人本机 8123 端口的服务进程启动时间是 **16:59:45**；
- 而 `server.js` 的修复落盘时间是 **17:03**。

也就是说：**旧进程一直没重载，磁盘上的修复根本没生效**，
主人点的还是旧代码里那个「只调一次上游」的 `handleCompose`。
Node 不会自动热重载 `server.js`——改完必须重启进程。

本次已经把 8123 上的服务重启为修复后的版本（现进程命令行为 `node server.js`）。
以后再改 `server.js`，请一并重启，否则看到的还是旧行为。

### 复跑用的假上游（已删干净）

复跑时为验证「额度不足 / Key 无效」两条快速失败分支，在 `/tmp` 下临时起了两个本地 HTTP 服务
（8299 回 400 insufficient credits、8300 回 401 invalid token），请求里用
`settings.baseUrl` 指过去。验证完脚本已删除，**仓库工作区无残留**
（`git status` 仅 `server.js`、`js/chat.js`、`docs/compose-fix-notes.md`；
`tools/literature-sources.json` 的改动与本修复无关，是另一处正在进行的文献来源工作）。

### 假上游怎么用的（临时代码已删）

为了验证「降级链全试完」的分支，用一个本地 HTTP 服务模拟恒定 503：

- 假上游监听 `127.0.0.1:8199`，任何请求都回
  `503 {"error":{"message":"Upstream model provider is temporarily unavailable..."}}`，
  并把收到的 `model` 打印出来；
- 用 `AI_FALLBACK_MODELS=mock/model-a,mock/model-b,mock/model-c` 起一个应用实例（8132 端口），
  请求里 `settings.baseUrl` 指向假上游；
- 结果如验证项 ⑧：4 个模型各被试 2 次，共 8 次请求，5 秒内快速失败并给出人话文案。

**该假上游脚本及全部探针脚本已在验证后删除，工作区无残留**
（`git status` 仅剩 `server.js`、`js/chat.js` 两个改动文件，以及本说明文档本身）。

> 注：这一轮用的是 `AI_FALLBACK_MODELS` 显式指定 mock 模型名，
> 所以链里的 4 个「模型」才会全部打到假上游上；生产逻辑里链是按网关识别的，
> 换网关不会把上一个网关的模型名塞过去。

### ⑪ 的调试留痕

服务端的 `/api/debug/state` 能看到这次调用的完整轨迹：

```
minimax/minimax-m3.1-flash:free  attempt=1  ms=125977  ok=false  transient  Upstream model provider is temporarily unavailable...
reflection/beam:free              attempt=1  ms=8847    ok=true   fallback=true
```

主通道拥塞 126 秒后放弃 → 自动切到 `reflection/beam:free` 8.8 秒出结果。
**这正是修复前 100% 红字、修复后一次成功的那个场景。**

---

## 七、残留风险与边界

1. **免费通道本身可能整体拥塞**。链全试完仍失败时会明确告诉主人试过哪些通道，
   但没法凭空变出结果；此时只能等窗口过去或换 Key/网关。
2. **最长等待时间**：compose 最坏 420 秒（7 分钟）。这是为了「点一次就能出结果」
   刻意换来的——宁可多等，不要红字。
3. **降级会影响文风**：备用模型（尤其 `reflection/beam:free`）出的文档比主通道短
   （实测 438~1795 字 vs 主通道 3246 字）。内容结构（四小节）一样齐，
   但主人若在意篇幅，可在设置里把主通道改回 `minimax/minimax-m3.1-flash:free`。
4. **只改了两个文件**：`server.js`、`js/chat.js`。`docs/` 下只新增本说明。
   `tools/literature-sources.json` 的改动与本修复无关（文献来源注册表，另一处工作在进行中）。
5. **未提交、未推送**：按要求改动全部留在工作区。
