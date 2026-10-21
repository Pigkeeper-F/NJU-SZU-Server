'use strict';
/**
 * 调试台页面逻辑（2026-10-20）。
 *
 * 只读：拉取 /api/debug/state（服务端请求记录 + 未捕获异常 + 当前生效模型），
 * 并把本页面自己的 JS 错误也上报到 /api/debug/client-error。
 * 唯一权限是读调试端点——见 docs/contract.md §25。
 */
(function () {
  var timer = null;

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    } catch (error) { return String(iso).slice(11, 23); }
  }

  function fmtUptime(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
  }

  function card(key, value) {
    var box = el('div', 'dbg-card');
    box.appendChild(el('div', 'k', key));
    box.appendChild(el('div', 'v', value));
    return box;
  }

  function renderCards(data) {
    var box = $('dbg-cards');
    box.textContent = '';
    var env = data.envModel || {};
    box.appendChild(card('服务', '运行中 · Node ' + (data.node || '?') + ' · PID ' + (data.pid || '?')));
    box.appendChild(card('已运行', fmtUptime(data.uptimeSeconds)));
    box.appendChild(card('服务端 .env 模型', (env.model || '(未配置)') + ' · ' + (env.baseUrl || '')));
    box.appendChild(card('.env 有 Key', data.hasEnvKey ? '是' : '否（将回落到浏览器设置）'));
    box.appendChild(card('文献作业数', String((data.workbench && data.workbench.literatureJobs) || 0)));
    box.appendChild(card('累计请求 / 错误', String(data.total || 0) + ' / ' + String(data.errors || 0)));
  }

  function renderRows(container, rows, withError) {
    container.textContent = '';
    if (!rows || !rows.length) {
      container.appendChild(el('div', 'dbg-empty', '暂无记录'));
      return;
    }
    var table = el('table');
    var head = el('tr');
    ['时间', '级别', '类型', '方法', '路径', '状态', '耗时'].forEach(function (title) {
      head.appendChild(el('th', null, title));
    });
    table.appendChild(head);
    rows.forEach(function (row) {
      var tr = el('tr', row.level === 'error' ? 'dbg-err' : '');
      tr.appendChild(el('td', 'dbg-num', fmtTime(row.at)));
      tr.appendChild(el('td', 'dbg-lvl ' + (row.level === 'error' ? 'dbg-lvl-error' : 'dbg-lvl-info'), row.level || 'info'));
      tr.appendChild(el('td', null, row.kind || ''));
      tr.appendChild(el('td', null, row.method || ''));
      tr.appendChild(el('td', null, row.path || ''));
      tr.appendChild(el('td', 'dbg-num', row.status === undefined ? '' : String(row.status)));
      tr.appendChild(el('td', 'dbg-num', row.ms === undefined ? '' : String(row.ms) + ' ms'));
      if (withError && row.error) {
        var detail = el('tr', 'dbg-err');
        var cell = el('td', 'dbg-err-text', (row.error || '') + (row.stack ? String(row.stack) : ''));
        cell.setAttribute('colspan', '7');
        detail.appendChild(cell);
        table.appendChild(detail);
      }
      table.appendChild(tr);
    });
    container.appendChild(table);
  }

  function load() {
    fetch('/api/debug/state?limit=120', { headers: { 'X-Workbench': '1' } })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data || data.error) {
          $('dbg-cards').textContent = '';
          var box = el('div', 'dbg-panel');
          box.appendChild(el('div', 'dbg-empty', '无法连接本地服务：' + ((data && data.error) || '未知错误')));
          $('dbg-cards').parentNode.insertBefore(box, $('dbg-cards').nextSibling);
          return;
        }
        renderCards(data);
        renderRows($('dbg-errors'), data.recentErrors || [], true);
        renderRows($('dbg-requests'), data.recent || [], false);
        $('dbg-err-count').textContent = (data.errors || 0) + ' 条';
        $('dbg-req-count').textContent = (data.total || 0) + ' 条';
        $('dbg-updated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
      })
      .catch(function (error) {
        $('dbg-updated').textContent = '拉取失败：' + ((error && error.message) || '未知错误');
      });
  }

  function startAuto() {
    stopAuto();
    if ($('dbg-auto').checked) timer = setInterval(load, 3000);
  }

  function stopAuto() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('dbg-refresh').addEventListener('click', load);
    $('dbg-auto').addEventListener('change', startAuto);
    $('dbg-clear-errors').addEventListener('click', load);
    load();
    startAuto();
    // 本页面的错误也上报
    window.addEventListener('error', function (event) {
      try {
        fetch('/api/debug/client-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Workbench': '1' },
          body: JSON.stringify({ where: 'debug-page', message: event.message, stack: event.error && event.error.stack })
        });
      } catch (error) { /* 上报失败不影响页面 */ }
    });
  });
})();
