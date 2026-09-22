#!/usr/bin/env node
/* ============================================================================
 * 契约自检脚本 —— node tools/check-contract.js
 * ----------------------------------------------------------------------------
 * 用途：协作提交前的机器可检项。检查"改了不该改的地方"和"接口对不上"两类问题：
 *   1. index.html 的脚本引入顺序是否与契约一致
 *   2. 各脚本调用的 Store.* API 是否都在 js/store.js 里有定义（含 EVENT / LIMITS 常量）
 *   3. 脚本里 getElementById / querySelector('#id') 引用的 DOM id 是否都在 index.html 中
 *   4. 脚本里 classList 用到的 CSS 类是否都在 css/style.css 中定义
 *   5. 四个 UI 模块是否都导出了全局对象（window.X = … 或 IIFE 的 root.X = …）
 *   6. 联网与禁用能力：ES module / crypto.subtle / XMLHttpRequest / WebSocket 一律禁；
 *      fetch 只允许 js/chat.js，且只允许同源 /api/… 路径（契约 §2）；data: 内联图标不算外部依赖
 *   7. 静态节点保护：#composer-input / #btn-send / #btn-add-module /
 *      #btn-sidebar-toggle / #sidebar-resizer 是否被脚本重建（禁止重建，只许改属性）
 *
 * 通过标准：输出 ALL_CHECKS_PASS 且退出码 0；有问题时逐条列出并退出码 1。
 * 刻意不检查的东西：运行期行为（要靠浏览器手工验证）、代码风格。
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const problems = [];
const passed = [];
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const JS_FILES = ["js/store.js", "js/sidebar.js", "js/tabs.js", "js/chat.js", "js/app.js"];
const UI_MODULES = [
  ["Sidebar", "js/sidebar.js"],
  ["ModuleTabs", "js/tabs.js"],
  ["ModuleSpace", "js/chat.js"],
  ["App", "js/app.js"]
];
const STATIC_NODES = ["composer-input", "btn-send", "btn-add-module", "btn-sidebar-toggle", "sidebar-resizer"];
const EXPECTED_SCRIPTS = ["js/store.js", "js/sidebar.js", "js/tabs.js", "js/chat.js", "js/app.js", "js/workspace.js"];
// 契约 §2「两种运行模式」：前端只允许 js/chat.js 里对同源 /api/… 的 fetch；其余脚本零联网。
const FETCH_ALLOWED = ["js/chat.js"];

// ---------- 读取 ----------
for (const f of JS_FILES.concat(["index.html", "css/style.css", "docs/contract.md"])) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    problems.push("缺少契约要求的文件: " + f);
  }
}
if (problems.length) {
  console.log(problems.join("\n"));
  process.exit(1);
}

const html = read("index.html");
const css = read("css/style.css");
const storeSrc = read("js/store.js");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const cssClasses = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));

// ---------- 1. 脚本顺序 ----------
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
if (JSON.stringify(scripts) !== JSON.stringify(EXPECTED_SCRIPTS)) {
  problems.push("index.html 脚本顺序不符（契约要求 " + EXPECTED_SCRIPTS.join(" → ") + "），实际: " + scripts.join(", "));
} else {
  passed.push("脚本引入顺序正确: " + scripts.join(" → "));
}

// ---------- 2. Store API 引用 ----------
const usedApis = new Set();
for (const f of JS_FILES.filter((x) => x !== "js/store.js")) {
  for (const m of read(f).matchAll(/\bStore\.(\w+)/g)) usedApis.add(m[1]);
}
for (const api of usedApis) {
  if (api === "EVENT" || api === "LIMITS") continue;
  if (!new RegExp("\\b" + api + "\\b\\s*[:(=]", "m").test(storeSrc)) {
    problems.push("Store." + api + " 在 js/store.js 中找不到定义（契约漂移，或拼错）");
  }
}
passed.push("Store API 引用全部有定义: " + [...usedApis].sort().join(", "));

// ---------- 3. DOM id 引用 ----------
for (const f of JS_FILES) {
  const src = read(f);
  for (const m of src.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) {
    if (!htmlIds.has(m[1])) problems.push("[" + f + "] getElementById(\"" + m[1] + "\") 在 index.html 中不存在");
  }
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*"#([\w-]+)"/g)) {
    if (!htmlIds.has(m[1])) problems.push("[" + f + "] querySelector(\"#" + m[1] + "\") 在 index.html 中不存在");
  }
}
passed.push("DOM id 引用与 index.html 一致（挂载点 " + htmlIds.size + " 个）");

// ---------- 4. CSS 类引用（只认带引号的字面量，变量传参不算） ----------
for (const f of JS_FILES) {
  const src = read(f);
  const used = new Set();
  for (const call of src.matchAll(/classList\.(?:add|remove|toggle|contains)\(([^)]*)\)/g)) {
    for (const lit of call[1].matchAll(/["']([^"']+)["']/g)) used.add(lit[1]);
  }
  for (const m of src.matchAll(/className\s*=\s*["']([^"']+)["']/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  }
  for (const c of used) {
    if (!cssClasses.has(c)) problems.push("[" + f + "] CSS 类 ." + c + " 未在 css/style.css 中定义");
  }
}
passed.push("classList 字面量类名全部在 style.css 中有定义（共 " + cssClasses.size + " 个类）");

// ---------- 5. 全局对象导出 ----------
for (const pair of UI_MODULES) {
  const src = read(pair[1]);
  if (!new RegExp("(?:window|root)\\.\\s*" + pair[0] + "\\s*=").test(src)) {
    problems.push("[" + pair[1] + "] 未按契约导出全局对象 window." + pair[0]);
  }
}
passed.push("全局对象导出齐备: " + UI_MODULES.map((p) => "window." + p[0]).join(", "));

// ---------- 6. 联网与禁用能力（按 contract.md §2「两种运行模式」扫描） ----------
for (const f of JS_FILES.concat(["index.html"])) {
  const raw = read(f);
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "");
  const noData = src.replace(/data:[^"'\s)]+/g, "data-uri");   // 内联 data: 图标（含 SVG 命名空间）不算外部依赖
  if (/\btype\s*=\s*["']module["']|crypto\.subtle/.test(noData)) {
    problems.push("[" + f + "] 出现禁用能力（ES module / crypto.subtle）");
  }
  if (noData.indexOf("fetch(") !== -1 && FETCH_ALLOWED.indexOf(f) === -1) {
    problems.push("[" + f + "] 出现 fetch()：按契约只有 " + FETCH_ALLOWED.join("、") + " 允许调用同源 AI 接口");
  }
  const xw = noData.match(/\b(XMLHttpRequest|WebSocket)\b/);
  if (xw) problems.push("[" + f + "] 出现 " + xw[1] + "：前端只允许同源 fetch /api/ai/chat");
  if (FETCH_ALLOWED.indexOf(f) !== -1) {
    for (const m of noData.matchAll(/fetch\(\s*["']([^"']+)["']/g)) {
      if (m[1].indexOf("/api/") !== 0) {
        problems.push("[" + f + "] fetch 目标必须是同源 /api/… 路径，实际：" + m[1]);
      }
    }
  }
  // 外部 URL：HTML 只认资源引用上下文（src= / href= / url( / fetch 目标），避免 data: 内联图标里的
  // XML 命名空间（http://www.w3.org/2000/svg）被误判；JS 只认非 data: 的字符串字面量。
  let ext = null;
  if (f.slice(-5) === ".html") {
    ext = noData.match(/(?:src|href)\s*=\s*["']https?:\/\//) ||
          noData.match(/url\(\s*["']?https?:\/\//) ||
          noData.match(/fetch\(\s*["']https?:\/\//);
  } else {
    for (const m of noData.matchAll(/["'`]([^"'`\n]{0,200})["'`]/g)) {
      if (m[1].indexOf("data:") === -1 && /https?:\/\//.test(m[1])) { ext = m[1]; break; }
    }
  }
  if (ext) {
    problems.push("[" + f + "] 出现外部 URL（前端不得直连第三方服务）：" + String(ext).slice(0, 70));
  }
}
passed.push("联网规则通过：仅 " + FETCH_ALLOWED.join("、") + " 允许同源 /api/ 调用，其余脚本无 fetch / 外部 URL");

// ---------- 7. 静态节点保护 ----------
for (const id of STATIC_NODES) {
  for (const f of JS_FILES) {
    const src = read(f);
    if (new RegExp("getElementById\\(\\s*\"" + id + "\"\\s*\\)\\.innerHTML").test(src)) {
      problems.push("[" + f + "] 重建了静态节点 #" + id + "（禁止，只允许改属性，否则丢焦点/半截输入）");
    }
  }
}
passed.push("静态节点未被 innerHTML 重建（" + STATIC_NODES.length + " 个受保护节点）");

// ---------- 输出 ----------
console.log(passed.map((s) => "  ✓ " + s).join("\n"));
if (problems.length) {
  console.log("\n发现问题 " + problems.length + " 项：");
  console.log(problems.map((s) => "  ✗ " + s).join("\n"));
  console.log("\n提示：接口类问题请先改 docs/contract.md 再改代码，并与协作者同步。");
  process.exit(1);
}
console.log("\nALL_CHECKS_PASS");
