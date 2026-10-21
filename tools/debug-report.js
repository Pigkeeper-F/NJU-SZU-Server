'use strict';
/**
 * 命令行诊断报告（维护者用，2026-10-20）。
 *
 * 一条命令拿到人读的中文诊断摘要：服务状态、当前模型、最近错误、慢请求统计、
 * 失败请求清单。不用开网页、不用截图。
 *
 * 用法：
 *   node tools/debug-report.js                # 默认连本机 8123
 *   node tools/debug-report.js --port 8124     # 指定端口
 *   node tools/debug-report.js --limit 40     # 看更多记录
 *   node tools/debug-report.js --json         # 输出原始 JSON（便于我程序化处理）
 */

const http = require('http');
const https = require('https');

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at < 0 || at + 1 >= process.argv.length) return fallback;
  return process.argv[at + 1];
}

const PORT = String(arg('port', '8123'));
const LIMIT = Number(arg('limit', '30')) || 30;
const AS_JSON = process.argv.indexOf('--json') >= 0;
const HOST = '127.0.0.1';

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: HOST,
      port: PORT,
      path: path,
      headers: { 'X-Workbench': '1' }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (error) { reject(new Error('响应不是 JSON（HTTP ' + res.statusCode + '）：' + body.slice(0, 200))); }
      });
    });
    req.on('error', (error) => reject(new Error('连不上本地服务 ' + HOST + ':' + PORT + '（' + error.message + '）')));
    req.setTimeout(8000, () => { req.destroy(new Error('请求超时')); });
  });
}

function fmtUptime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  } catch (error) { return String(iso).slice(11, 19); }
}

function line(char) { return char.repeat(72); }

(async () => {
  const result = await fetchJson('/api/debug/state?limit=' + LIMIT);
  if (result.status !== 200 || !result.data || result.data.error) {
    console.error('调试接口返回异常：HTTP ' + result.status + ' ' + JSON.stringify(result.data).slice(0, 200));
    process.exit(1);
  }
  const data = result.data;

  if (AS_JSON) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const env = data.envModel || {};
  console.log(line('='));
  console.log('研序 · 诊断报告   ' + new Date().toLocaleString('zh-CN', { hour12: false }));
  console.log(line('='));
  console.log('服务      : 运行中 · Node ' + (data.node || '?') + ' · PID ' + (data.pid || '?') + ' · 已运行 ' + fmtUptime(data.uptimeSeconds));
  console.log('.env 模型 : ' + (env.model || '(未配置)') + '  @  ' + (env.baseUrl || '-'));
  console.log('Key       : ' + (data.hasEnvKey ? '已配置' : '未配置（回落到浏览器设置）'));
  console.log('文献作业  : ' + ((data.workbench && data.workbench.literatureJobs) || 0) + ' 个');
  console.log('累计      : 请求 ' + (data.total || 0) + ' 条 / 错误 ' + (data.errors || 0) + ' 条');

  const recent = data.recent || [];
  const errors = recent.filter((row) => row.level === 'error');
  const failed = recent.filter((row) => typeof row.status === 'number' && row.status >= 400);
  const slow = recent.filter((row) => typeof row.ms === 'number' && row.ms >= 3000).sort((a, b) => b.ms - a.ms);

  console.log('');
  console.log('--- 失败请求（HTTP ≥ 400）' + (failed.length ? '' : '：无') + ' ---');
  if (failed.length) {
    for (const row of failed.slice(0, 12)) {
      console.log('  ' + fmtTime(row.at) + '  ' + (row.method || '') + ' ' + (row.path || '') + '  → ' + row.status + '  ' + (row.ms || 0) + 'ms');
    }
  }

  console.log('');
  console.log('--- 慢请求（≥ 3s）' + (slow.length ? '' : '：无') + ' ---');
  if (slow.length) {
    for (const row of slow.slice(0, 12)) {
      console.log('  ' + fmtTime(row.at) + '  ' + (row.method || '') + ' ' + (row.path || '') + '  ' + (row.ms || 0) + 'ms');
    }
  }

  console.log('');
  console.log('--- 错误明细（最近 ' + Math.min(errors.length, 10) + ' 条）' + (errors.length ? '' : '：无') + ' ---');
  if (errors.length) {
    for (const row of errors.slice(0, 10)) {
      console.log('  [' + (row.kind || '') + '] ' + fmtTime(row.at));
      console.log('    ' + String(row.error || '').split('\n').slice(0, 3).join('\n    '));
    }
  } else {
    console.log('  （没有错误）');
  }

  console.log('');
  console.log('--- 最近请求（' + Math.min(recent.length, 15) + ' 条）---');
  for (const row of recent.slice(0, 15)) {
    console.log('  ' + fmtTime(row.at) + '  ' + String(row.status || '').padStart(3) + '  ' + (row.method || '').padEnd(5) + ' ' + (row.path || '') + '  ' + (row.ms === undefined ? '' : row.ms + 'ms'));
  }
  console.log(line('='));
})().catch((error) => {
  console.error('诊断失败：' + (error && error.message ? error.message : error));
  process.exit(1);
});
