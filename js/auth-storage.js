/* =========================================================
 * 研序工作台 — 账号存储与认证加密层（js/auth-storage.js）
 * ---------------------------------------------------------
 * 运行环境：纯浏览器 script 标签加载（file:// 直接打开可用）。
 * 硬性约束：禁用 ES module / fetch / crypto.subtle / 任何外部依赖；
 *           SHA-256 为内嵌纯 JS 实现（FIPS 180-4），全部同步返回。
 *
 * 数据结构（localStorage）：
 *   1) 账号表  键 "wa_accounts"：JSON 数组，元素结构：
 *        { username:  string,  // 用户名（唯一键，区分大小写，不 trim）
 *          salt:      string,  // 32 位小写 hex（16 字节随机盐）
 *          passHash:  string,  // sha256Hex(salt + ":" + password)，64 位小写 hex
 *          createdAt: string } // ISO 时间字符串（new Date().toISOString()）
 *   2) 会话    键 "wa_session"：字符串用户名；未登录时不存在（get 返回 null）。
 *
 * 安全边界（务必知悉）：
 *   本实现仅供前端演示/实验场景。密码为「盐化 SHA-256」而非 bcrypt/argon2
 *   等慢哈希；localStorage 可被本机任意脚本与用户直接读取、篡改，不具备
 *   对抗本机攻击者的能力，绝不可用于生产环境。
 * ========================================================= */
(function (global) {
  "use strict";

  var ACCOUNTS_KEY = "wa_accounts";
  var SESSION_KEY = "wa_session";
  var HEX_CHARS = "0123456789abcdef";

  /* ---------- 小工具 ---------- */

  function byteToHex(b) {
    return HEX_CHARS.charAt((b >>> 4) & 0x0f) + HEX_CHARS.charAt(b & 0x0f);
  }

  // 32 位循环右移（调用处的 n 均 > 0，无需处理 n = 0 的特例）
  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  // UTF-8 编码：按 Unicode 码点把 JS 字符串转成 UTF-8 字节数组。
  // 手写实现（含代理对处理），避免依赖 TextEncoder，保证旧环境一致性。
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff) {
        var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          var cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          out.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f)
          );
          i++; // 消费低位代理
        } else {
          out.push(0xef, 0xbf, 0xbd); // 孤立代理 → U+FFFD
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        out.push(0xef, 0xbf, 0xbd); // 孤立低位代理 → U+FFFD
      } else {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return out;
  }

  /* ---------- SHA-256（纯 JS，同步） ---------- */

  // 常量表 K：前 64 个素数立方根小数部分前 32 位（FIPS 180-4）
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  // 初始哈希值：前 8 个素数平方根小数部分前 32 位
  var INITIAL_H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];

  function sha256Hex(text) {
    var bytes = utf8Bytes(String(text));
    var h = INITIAL_H.slice();
    var bitLen = bytes.length * 8;

    // 填充：追加 0x80，补 0x00 至 length % 64 == 56，再追加 64 位大端比特长度
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) { bytes.push(0); }
    var hi = Math.floor(bitLen / 0x100000000);
    var lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
    bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

    var w = new Array(64);
    for (var block = 0; block < bytes.length; block += 64) {
      var t, o;
      for (t = 0; t < 16; t++) {
        o = block + t * 4;
        w[t] = ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) | 0;
      }
      for (t = 16; t < 64; t++) {
        var x = w[t - 15];
        var y = w[t - 2];
        var s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
        var s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }

      var a = h[0], b = h[1], c = h[2], d = h[3];
      var e = h[4], f = h[5], g = h[6], hh = h[7];

      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (hh + S1 + ch + K[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;

        hh = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }

      h[0] = (h[0] + a) | 0;
      h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c) | 0;
      h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0;
      h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0;
      h[7] = (h[7] + hh) | 0;
    }

    var out = "";
    for (var i = 0; i < 8; i++) {
      out += byteToHex((h[i] >>> 24) & 0xff) +
             byteToHex((h[i] >>> 16) & 0xff) +
             byteToHex((h[i] >>> 8) & 0xff) +
             byteToHex(h[i] & 0xff);
    }
    return out;
  }

  /* ---------- AuthCrypto ---------- */

  // 16 字节随机盐 → 32 位小写 hex；crypto.getRandomValues 不可用时降级 Math.random
  function randomSalt() {
    try {
      if (global.crypto && typeof global.crypto.getRandomValues === "function") {
        var buf = new Uint8Array(16);
        global.crypto.getRandomValues(buf);
        var hex = "";
        for (var i = 0; i < buf.length; i++) { hex += byteToHex(buf[i]); }
        return hex;
      }
    } catch (e) { /* 走降级 */ }
    var fallback = "";
    for (var j = 0; j < 32; j++) { fallback += byteToHex(Math.floor(Math.random() * 256)); }
    return fallback;
  }

  // 盐化密码哈希：sha256Hex(salt + ":" + password)，同步返回 64 位小写 hex
  function hashPassword(password, salt) {
    return sha256Hex(salt + ":" + password);
  }

  /* ---------- Store（账号表，键 "wa_accounts"） ---------- */

  function getAccounts() {
    try {
      var raw = global.localStorage.getItem(ACCOUNTS_KEY);
      if (!raw) { return []; }
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return []; // 解析失败/存储不可用时不抛异常
    }
  }

  function findAccount(username) {
    var list = getAccounts();
    var name = String(username == null ? "" : username);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].username === name) { return list[i]; }
    }
    return null;
  }

  function saveAccount(account) {
    if (!account || typeof account !== "object") { return false; }
    if (typeof account.username !== "string" || account.username.length === 0) { return false; }
    var list = getAccounts();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].username === account.username) { return false; } // 查重
    }
    list.push(account);
    try {
      global.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      return false; // 存储满/隐私模式等
    }
  }

  /* ---------- Session（会话，键 "wa_session"） ---------- */

  function sessionGet() {
    try {
      var v = global.localStorage.getItem(SESSION_KEY);
      return typeof v === "string" && v !== "" ? v : null;
    } catch (e) {
      return null;
    }
  }

  function sessionSet(username) {
    try {
      global.localStorage.setItem(SESSION_KEY, String(username));
      return true;
    } catch (e) {
      return false;
    }
  }

  function sessionClear() {
    try {
      global.localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 暴露全局对象（挂 window，IIFE 防中间变量污染） ---------- */

  global.AuthStore = {  // 【集成改名】原 window.Store 与工作台数据层撞名，改为 AuthStore
    getAccounts: getAccounts,
    findAccount: findAccount,
    saveAccount: saveAccount
  };

  global.Session = {
    get: sessionGet,
    set: sessionSet,
    clear: sessionClear
  };

  global.AuthCrypto = {
    randomSalt: randomSalt,
    sha256Hex: sha256Hex,
    hashPassword: hashPassword
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
