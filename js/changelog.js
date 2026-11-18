/* =========================================================
 * 研序工作台 — 更新日志页（js/changelog.js）
 * ---------------------------------------------------------
 * 数据来源：GET /api/changelog（服务端缓存 5 分钟后再向上游取）。
 * 依赖：无。纯 script，不引入框架。
 * 安全：所有文本用 textContent 写入；只有「在 GitHub 查看」链接走 href，
 *      且服务端已把非 github.com 的地址过滤成空串，这里再兜一次底。
 * ========================================================= */
(function () {
  "use strict";

  var STATE = {
    loading: false,
    payload: null,
    type: "",       // 当前筛选的类型；空串 = 全部
    keyword: ""
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === "string") node.textContent = text;
    return node;
  }

  function safeExternalUrl(url) {
    var value = String(url || "");
    return /^https:\/\/github\.com\//.test(value) ? value : "";
  }

  function formatTime(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    var pad = function (n) { return n < 10 ? "0" + n : String(n); };
    return pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  var WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function formatDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
    var date = new Date(day + "T00:00:00");
    if (isNaN(date.getTime())) return day;
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var diff = Math.round((today - date) / 86400000);
    var label = day.slice(5).replace("-", " 月 ") + " 日";
    if (diff === 0) return "今天 · " + label;
    if (diff === 1) return "昨天 · " + label;
    return date.getFullYear() + " 年 " + label;
  }

  function showStatus(message, tone) {
    var box = $("cl-status");
    if (!message) { box.hidden = true; box.textContent = ""; box.removeAttribute("data-tone"); return; }
    box.hidden = false;
    box.textContent = message;
    if (tone) box.setAttribute("data-tone", tone);
    else box.removeAttribute("data-tone");
  }

  /* --------------------------------------------------------- 概览信息 */
  function renderMeta(payload) {
    var meta = $("cl-meta");
    meta.textContent = "";
    if (!payload || !payload.ok) return;

    var items = [
      ["共 <strong>" + payload.count + "</strong> 条提交"],
      ["分支 <strong>" + payload.branch + "</strong>"],
      ["数据更新于 <strong>" + formatTime(payload.fetchedAt) + "</strong>"]
    ];
    items.forEach(function (pair) {
      var span = el("span");
      span.innerHTML = pair[0];
      meta.appendChild(span);
    });

    var repoLink = $("cl-repo-link");
    var repoUrl = safeExternalUrl(payload.pageUrl);
    if (repoUrl) { repoLink.href = repoUrl; repoLink.hidden = false; }
    else repoLink.hidden = true;
  }

  /* --------------------------------------------------------- 类型筛选 */
  function renderFilters(payload) {
    var bar = $("cl-filters");
    bar.textContent = "";
    if (!payload || !payload.ok) return;

    var all = el("button", "cl-chip", "全部");
    all.type = "button";
    all.setAttribute("aria-pressed", STATE.type === "" ? "true" : "false");
    all.addEventListener("click", function () { STATE.type = ""; render(); });
    all.appendChild(el("span", "cl-chip-count", String(payload.count)));
    bar.appendChild(all);

    (payload.types || []).forEach(function (item) {
      var chip = el("button", "cl-chip", item.label);
      chip.type = "button";
      chip.setAttribute("data-type", item.type);
      chip.setAttribute("aria-pressed", STATE.type === item.type ? "true" : "false");
      chip.addEventListener("click", function () {
        STATE.type = STATE.type === item.type ? "" : item.type;
        render();
      });
      chip.appendChild(el("span", "cl-chip-count", String(item.count)));
      bar.appendChild(chip);
    });
  }

  /* --------------------------------------------------------- 过滤逻辑 */
  function filtered() {
    if (!STATE.payload || !STATE.payload.ok) return [];
    var keyword = STATE.keyword.trim().toLowerCase();
    return (STATE.payload.commits || []).filter(function (item) {
      if (STATE.type && item.type !== STATE.type) return false;
      if (!keyword) return true;
      var haystack = [item.note, item.summary, item.subject, item.scope, item.scopeLabel, item.author, item.typeLabel]
        .join(" ").toLowerCase();
      return haystack.indexOf(keyword) >= 0;
    });
  }

  function groupByDay(commits) {
    var map = new Map();
    commits.forEach(function (item) {
      var day = item.date ? item.date.slice(0, 10) : "未知日期";
      if (!map.has(day)) map.set(day, []);
      map.get(day).push(item);
    });
    return Array.from(map.keys()).sort(function (a, b) { return a < b ? 1 : a > b ? -1 : 0; })
      .map(function (day) { return { date: day, commits: map.get(day) }; });
  }

  /* --------------------------------------------------------- 时间线 */
  function renderCommit(item) {
    var row = el("div", "cl-commit");

    var badge = el("span", "cl-badge", item.typeLabel || "其他");
    badge.setAttribute("data-type", item.type || "other");
    row.appendChild(badge);

    var body = el("div", "cl-commit-body");

    // 有手写中文说明时，中文为主、英文原文降为次行（老师读中文，开发者对得上原文）
    if (item.note) {
      body.appendChild(el("div", "cl-commit-summary", item.note));
      var origin = el("div", "cl-commit-origin", item.summary || item.subject || "");
      if (item.scopeLabel || item.scope) origin.appendChild(el("span", "cl-commit-scope", " · " + (item.scopeLabel || item.scope)));
      body.appendChild(origin);
    } else {
      var summary = el("div", "cl-commit-summary", item.summary || item.subject || "");
      var scopeText = item.scopeLabel || item.scope;
      if (scopeText) summary.appendChild(el("span", "cl-commit-scope", "（" + scopeText + "）"));
      body.appendChild(summary);
    }

    var foot = el("div", "cl-commit-foot");
    if (item.author) foot.appendChild(el("span", "", item.author));
    if (item.date) foot.appendChild(el("span", "", formatTime(item.date)));
    body.appendChild(foot);
    row.appendChild(body);

    var url = safeExternalUrl(item.url);
    if (url) {
      var link = el("a", "cl-commit-sha", item.shortSha || "");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "在 GitHub 上查看这次改动";
      row.appendChild(link);
    } else {
      row.appendChild(el("span", "cl-commit-sha", item.shortSha || ""));
    }

    return row;
  }

  function renderTimeline() {
    var box = $("cl-timeline");
    var empty = $("cl-empty");
    var commits = filtered();

    box.textContent = "";

    if (!STATE.payload || !STATE.payload.ok) {
      empty.hidden = true;
      return;
    }
    if (!commits.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    groupByDay(commits).forEach(function (group) {
      var day = el("section", "cl-day");

      var head = el("div", "cl-day-head");
      head.appendChild(el("span", "cl-day-date", formatDay(group.date)));
      var parsed = /^\d{4}-\d{2}-\d{2}$/.test(group.date) ? new Date(group.date + "T00:00:00") : null;
      if (parsed && !isNaN(parsed.getTime())) head.appendChild(el("span", "cl-day-week", WEEK[parsed.getDay()]));
      head.appendChild(el("span", "cl-day-count", group.commits.length + " 项"));
      day.appendChild(head);

      var list = el("div", "cl-commits");
      group.commits.forEach(function (item) { list.appendChild(renderCommit(item)); });
      day.appendChild(list);

      box.appendChild(day);
    });
  }

  function renderSkeleton() {
    var box = $("cl-timeline");
    box.textContent = "";
    var wrap = el("div", "cl-skeleton");
    for (var i = 0; i < 6; i += 1) wrap.appendChild(el("div", "cl-skeleton-row"));
    box.appendChild(wrap);
  }

  function render() {
    renderFilters(STATE.payload);
    renderTimeline();
  }

  /* --------------------------------------------------------- 拉取数据 */
  function load(force) {
    if (STATE.loading) return;
    STATE.loading = true;
    if (!STATE.payload) renderSkeleton();
    showStatus(force ? "正在向 GitHub 取最新记录…" : "正在读取更新记录…");

    var url = "/api/changelog" + (force ? "?refresh=1" : "");
    fetch(url, { headers: { "Accept": "application/json" }, cache: "no-store" })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        STATE.payload = payload;
        if (!payload || !payload.ok) {
          renderMeta(null);
          renderFilters(null);
          $("cl-timeline").textContent = "";
          $("cl-empty").hidden = true;
          showStatus("读取失败：" + ((payload && payload.error) || "服务端未返回原因"), "error");
          return;
        }
        renderMeta(payload);
        render();
        if (payload.stale) {
          showStatus("暂时连不上 GitHub，下面显示的是上一次成功取到的记录（" +
            formatTime(payload.fetchedAt) + " 更新）。" + (payload.lastError ? "原因：" + payload.lastError : ""), "warn");
        } else {
          showStatus("");
        }
      })
      .catch(function (error) {
        if (STATE.payload && STATE.payload.ok) render();
        showStatus("读取失败：" + (error && error.message ? error.message : "网络异常") +
          "。请确认服务仍在运行，然后点「立即刷新」。", "error");
      })
      .finally(function () { STATE.loading = false; });
  }

  /* --------------------------------------------------------- 事件绑定 */
  function bind() {
    $("cl-refresh").addEventListener("click", function () { load(true); });

    var search = $("cl-search");
    var timer = null;
    search.addEventListener("input", function () {
      // 输入停顿 180ms 再重绘，避免每个字符都重建一遍 DOM
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        STATE.keyword = search.value || "";
        render();
      }, 180);
    });
  }

  bind();
  load(false);
})();
