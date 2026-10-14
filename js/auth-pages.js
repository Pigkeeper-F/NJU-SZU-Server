/* =========================================================
 * 研序工作台 — 注册/登录页逻辑（js/auth-pages.js）
 * ---------------------------------------------------------
 * 依赖：config.js、storage.js（须先于本文件引入，顺序见 docs/contract.md §7）。
 * 职责：
 *   1) 注册页两段式：第一段校验测试码（对 APP_CONFIG.testCode trim 后严格比对），
 *      通过后才显示第二段「账号 + 密码 + 确认密码」表单；
 *   2) 登录页：账号 + 密码校验，成功后写入会话并进入主页。
 * 安全边界：测试码与密码校验均在前端完成，可被绕过；
 *          生产环境必须由后端校验测试码与凭据。
 * ========================================================= */
(function () {
  "use strict";

  var APP = window.APP_CONFIG;

  function setTitle(prefix) {
    document.title = prefix + " - " + APP.appName;
  }

  // 消息条：type 为 "ok" / "error"；传 null 表示隐藏。用法见 contract.md §6
  function showMsg(el, text, type) {
    if (!type) {
      el.classList.remove("msg-show");
      el.textContent = ""; // 一并清掉文本，避免隐藏状态下残留旧提示
      return;
    }
    el.textContent = text;
    el.classList.remove("msg-error", "msg-ok");
    var cls = (type === "ok") ? "msg-ok" : "msg-error"; // 类名经变量传入，避免把条件字面量 "ok" 混进类名
    el.classList.add(cls, "msg-show");
  }

  function onEnter(input, handler) {
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        handler();
      }
    });
  }

  /* ---------------- 注册页（两段式） ---------------- */

  function initRegisterPage() {
    var form1 = document.getElementById("reg-form1");
    var step1 = document.getElementById("reg-step1");
    if (!form1 || !step1) { return; } // 当前不在注册页
    setTitle("注册");

    var form2 = document.getElementById("reg-form2");
    var msg = document.getElementById("reg-msg");
    var codeInput = document.getElementById("reg-code");
    var userInput = document.getElementById("reg-user");
    var passInput = document.getElementById("reg-pass");
    var pass2Input = document.getElementById("reg-pass2");
    var step2 = document.getElementById("reg-step2");

    if (Session.get()) { location.href = "index.html"; return; } // 已登录直接进主页

    // 第一段：测试码关卡（仅前端校验；生产环境应改为后端校验）
    function verifyCode() {
      var code = (codeInput.value || "").trim();
      if (!code) { showMsg(msg, "请输入测试码", "error"); return; }
      if (code !== APP.testCode) {
        showMsg(msg, "测试码不正确，请重新输入", "error");
        codeInput.select();
        return;
      }
      showMsg(msg, null);
      form1.classList.add("stage-hidden");
      form2.classList.remove("stage-hidden");
      userInput.focus();
    }

    // 第二段：创建账号（标准写法见 contract.md §4.1）
    function register() {
      var username = (userInput.value || "").trim();
      var password = passInput.value || "";
      var password2 = pass2Input.value || "";

      if (!username) { showMsg(msg, "请输入账号", "error"); userInput.focus(); return; }
      if (password.length < 6) { showMsg(msg, "密码至少 6 位", "error"); passInput.focus(); return; }
      if (password !== password2) { showMsg(msg, "两次输入的密码不一致", "error"); pass2Input.focus(); return; }
      if (AuthStore.findAccount(username)) { showMsg(msg, "该账号已被注册", "error"); return; }

      var salt = AuthCrypto.randomSalt();
      var ok = AuthStore.saveAccount({
        username: username,
        salt: salt,
        passHash: AuthCrypto.hashPassword(password, salt),
        createdAt: new Date().toISOString()
      });
      if (!ok) { showMsg(msg, "注册失败，请稍后重试", "error"); return; }

      showMsg(msg, "注册成功！即将跳转到登录页…", "ok");
      step2.disabled = true;
      setTimeout(function () { location.href = "login.html"; }, 1200);
    }

    step1.addEventListener("click", verifyCode);
    step2.addEventListener("click", register);
    onEnter(codeInput, verifyCode);
    onEnter(userInput, function () { passInput.focus(); });
    onEnter(passInput, function () { pass2Input.focus(); });
    onEnter(pass2Input, register);
  }

  /* ---------------- 登录页 ---------------- */

  function initLoginPage() {
    var btn = document.getElementById("btn-login");
    if (!btn) { return; } // 当前不在登录页
    setTitle("登录");

    var msg = document.getElementById("login-msg");
    var userInput = document.getElementById("login-user");
    var passInput = document.getElementById("login-pass");

    if (Session.get()) { location.href = "index.html"; return; } // 已登录直接进主页

    // 标准写法见 contract.md §4.2
    function login() {
      var username = (userInput.value || "").trim();
      var password = passInput.value || "";
      if (!username) { showMsg(msg, "请输入账号", "error"); userInput.focus(); return; }
      if (!password) { showMsg(msg, "请输入密码", "error"); passInput.focus(); return; }

      var acc = AuthStore.findAccount(username);
      // 账号不存在与密码错误统一提示，避免枚举已注册账号
      if (!acc || acc.passHash !== AuthCrypto.hashPassword(password, acc.salt)) {
        showMsg(msg, "账号或密码错误", "error");
        passInput.select();
        return;
      }
      Session.set(username);
      showMsg(msg, "登录成功，正在进入…", "ok");
      location.href = "index.html";
    }

    btn.addEventListener("click", login);
    onEnter(userInput, function () { passInput.focus(); });
    onEnter(passInput, login);
  }

  initRegisterPage();
  initLoginPage();
})();
