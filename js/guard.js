/* =========================================================
 * 研序工作台 — 访问守卫（js/guard.js）
 * ---------------------------------------------------------
 * 依赖：auth-storage.js（提供 window.Session），必须先于本文件加载。
 * 职责：未登录访问工作台时重定向到登录页；已登录把用户名挂 window.AuthUser
 *      供页面显示。键 "wa_session"，见 docs/contract.md 账号系统章节。
 * 安全边界：与账号系统一致，为前端演示级校验，可被绕过，不用于生产。
 * ========================================================= */
(function () {
  "use strict";
  var user = null;
  try { user = (typeof window.Session === "object") ? window.Session.get() : null; } catch (e) { user = null; }
  if (!user) { location.replace("login.html"); return; }
  window.AuthUser = user;
})();
