/* =========================================================
 * 研序工作台 — 注册/登录页逻辑（js/auth-pages.js）
 * ---------------------------------------------------------
 * 依赖：config.js、storage.js（须先于本文件引入，顺序见 docs/contract.md §7）。
 * 职责：
 *   1) 注册页两段式：第一段校验测试码（对 APP_CONFIG.testCode trim 后严格比对），
 *      通过后才显示第二段「账号 + 密码 + 确认密码」表单；
 *   2) 登录页：测试码必填；账号密码都留空则以访客进入，都填写则校验账号密码
 *      （2026-11-18 起；原来的「测试直达（免登录）」入口已移除）。
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

    // 第二段：创建账号
    // 【2026-11-25】优先注册到服务器（换设备也能登录），成功后同时写一份浏览器副本；
    // 服务器不可达时退回纯本地注册，并明确提示只在当前浏览器有效。
    function register() {
      var username = (userInput.value || "").trim();
      var password = passInput.value || "";
      var password2 = pass2Input.value || "";

      if (!username) { showMsg(msg, "请输入账号", "error"); userInput.focus(); return; }
      if (password.length < 6) { showMsg(msg, "密码至少 6 位", "error"); passInput.focus(); return; }
      if (password !== password2) { showMsg(msg, "两次输入的密码不一致", "error"); pass2Input.focus(); return; }
      if (AuthStore.findAccount(username)) { showMsg(msg, "该账号已被注册", "error"); return; }

      var role = "student";
      var picked = document.querySelector('input[name="register-role"]:checked');
      if (picked && picked.value === "teacher") role = "teacher";

      step2.disabled = true;
      showMsg(msg, "正在创建账号…", "ok");

      function localFinish(note) {
        var salt = AuthCrypto.randomSalt();
        var ok = AuthStore.saveAccount({
          username: username, salt: salt, role: role,
          passHash: AuthCrypto.hashPassword(password, salt),
          createdAt: new Date().toISOString()
        });
        if (!ok) { step2.disabled = false; showMsg(msg, "注册失败，请稍后重试", "error"); return; }
        showMsg(msg, note || "注册成功！正在进入工作台…", "ok");
        Session.set(username);
        try {
          window.localStorage.setItem("yanxu_role", role);
          window.localStorage.setItem("yanxu_guest", "0");
        } catch (e) { /* 忽略 */ }
        setTimeout(function () { location.href = "index.html"; }, 1200);
      }

      // 服务器注册需要测试码：沿用第一段用户输入的码
      var code = (codeInput.value || "").trim();
      // 【修复 · 2026-11-25】注册接口只建账号、不发会话；必须紧接着登录一次拿到 token，
      // 否则进工作台后 collab-boot 的 restore() 找不到 token，会一直显示「本机存储」，
      // 学生提交的内容永远到不了服务器（实测发现）。
      fetch("/api/collab/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code, username: username, password: password, role: role })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) {
            var error = new Error(data.error || ("HTTP " + response.status));
            error.status = response.status;
            throw error;
          }
          return data;
        });
      }).then(function () {
        // 建会话：拿到 token 后 collab-boot 才能接管同步
        if (window.Collab) {
          return window.Collab.login(code, role, username, password).then(function () {
            localFinish(role === "teacher" ? "导师账号已创建（服务器已保存），正在进入…" : "注册成功（服务器已保存），正在进入…");
          });
        }
        localFinish();
      }).catch(function (error) {
        if (error.status === 409) {
          step2.disabled = false;
          showMsg(msg, "该账号已被注册", "error");
          return;
        }
        if (error.status === 401) {
          step2.disabled = false;
          showMsg(msg, "测试码已失效，请回到第一步重新验证", "error");
          return;
        }
        // 网络问题：本地注册保底，但要说清局限
        localFinish("服务器连不上，已在本机创建账号（只在当前浏览器有效）。");
      });
    }

    step1.addEventListener("click", verifyCode);
    step2.addEventListener("click", register);
    onEnter(codeInput, verifyCode);
    onEnter(userInput, function () { passInput.focus(); });
    onEnter(passInput, function () { pass2Input.focus(); });
    onEnter(pass2Input, register);
  }

  /* ---------------- 登录页 ---------------- */

  // 【2026-11-18】访客身份：账号密码都留空时显示的固定名。
  // 它不是账号（不会被写入 wa_accounts），只是一个显示用的标签。
  var GUEST_NAME = "访客";

  function initLoginPage() {
    var btn = document.getElementById("btn-login");
    if (!btn) { return; } // 当前不在登录页
    setTitle("登录");

    var msg = document.getElementById("login-msg");
    var codeInput = document.getElementById("login-code");
    var userInput = document.getElementById("login-user");
    var passInput = document.getElementById("login-pass");

    /** 读当前选中的身份；没有角色控件时按学生处理（兼容旧页面）。 */
    function selectedRole() {
      var picked = document.querySelector('input[name="login-role"]:checked');
      return picked && picked.value === "teacher" ? "teacher" : "student";
    }

    if (Session.get()) { location.href = "index.html"; return; } // 已登录直接进主页

    /**
     * 登录规则（2026-11-25 师生协作版）：
     *   测试码必填 + 自选身份；账号密码都留空 → 访客，都填 → 校验。
     *   认证优先走服务器（/api/collab/login）：账号落库后换电脑也能用，
     *   角色由服务端记录并用于权限校验。
     *   服务器不可达时回落到旧的纯浏览器校验（离线仍能干活），
     *   但会明确提示"本地模式"，不让人误以为身份已在服务器生效。
     */
    function login() {
      var code = (codeInput.value || "").trim();
      var username = (userInput.value || "").trim();
      var password = passInput.value || "";
      var role = selectedRole();

      if (!code) { showMsg(msg, "请输入测试码", "error"); codeInput.focus(); return; }
      if (code !== APP.testCode) {
        showMsg(msg, "测试码不正确，请重新输入", "error");
        codeInput.select();
        return;
      }

      // 只填一半 → 明确提示该补哪一个
      if (username && !password) { showMsg(msg, "已填账号但没填密码：请补上密码，或把账号也清空以访客身份进入", "error"); passInput.focus(); return; }
      if (!username && password) { showMsg(msg, "已填密码但没填账号：请补上账号，或把密码也清空以访客身份进入", "error"); userInput.focus(); return; }

      btn.disabled = true;
      showMsg(msg, "正在连接服务器…", "ok");

      var collab = window.Collab;
      if (!collab) {
        // 没有协作层（file:// 直开等情况）→ 退回纯浏览器校验
        legacyLogin(code, username, password);
        return;
      }

      collab.login(code, role, username, password).then(function (user) {
        // 服务端已认账：同步写一份到浏览器会话，让 guard.js 放行
        Session.set(user.username);
        // 记下角色与访客标记，工作台据此渲染不同界面
        try {
          window.localStorage.setItem("yanxu_role", user.role);
          window.localStorage.setItem("yanxu_guest", user.guest ? "1" : "0");
        } catch (e) { /* 忽略 */ }
        showMsg(msg, user.role === "teacher" ? "导师身份登录成功，正在进入…" : "登录成功，正在进入…", "ok");
        location.href = "index.html";
      }).catch(function (error) {
        btn.disabled = false;
        if (error && error.status === 401) {
          showMsg(msg, error.message || "账号或密码错误", "error");
          passInput.select();
          return;
        }
        // 服务器连不上：提示后按本地模式进入，避免课堂现场完全打不开
        showMsg(msg, "服务器暂时连不上（" + (error && error.message ? error.message : "网络异常") +
          "）。将以本地模式进入，数据只存在本机。", "error");
        setTimeout(function () {
          Session.set(username || GUEST_NAME);
          try { window.localStorage.setItem("yanxu_role", role); } catch (e) { /* 忽略 */ }
          location.href = "index.html";
        }, 1800);
      });
    }

    /** 纯浏览器兜底：老版本行为，账号只在本机。 */
    function legacyLogin(code, username, password) {
      if (!username && !password) {
        Session.set(GUEST_NAME);
        showMsg(msg, "已以访客身份进入…", "ok");
        location.href = "index.html";
        return;
      }
      var acc = AuthStore.findAccount(username);
      if (!acc || acc.passHash !== AuthCrypto.hashPassword(password, acc.salt)) {
        btn.disabled = false;
        showMsg(msg, "账号或密码错误", "error");
        passInput.select();
        return;
      }
      Session.set(username);
      showMsg(msg, "登录成功，正在进入…", "ok");
      location.href = "index.html";
    }

    btn.addEventListener("click", login);
    onEnter(codeInput, function () { userInput.focus(); });
    onEnter(userInput, function () { passInput.focus(); });
    onEnter(passInput, login);
  }

  initRegisterPage();
  initLoginPage();
})();
