/* =========================================================
 * 研序工作台 — 账号配置（js/auth-config.js）
 * ---------------------------------------------------------
 * 纯 script 全局注入，无模块、无依赖，file:// 可用。
 * 引入顺序：本文件必须先于 storage.js 与页面脚本加载。
 * ========================================================= */
(function (global) {
  "use strict";

  global.APP_CONFIG = {
    appName: "研序 · 研究工作台",
    testCode: "nailong" // 注册测试码：仅前端演示用，修改请同步 docs/contract.md
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
