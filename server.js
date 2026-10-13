/**
 * 流程智能体的本地服务：提供静态页面和受保护的 AI 代理接口。
 * API Key 只从服务端环境变量读取，绝不发送给浏览器。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 4000;

// 保持零依赖：仅加载项目根目录的简单 KEY=VALUE 配置；系统环境变量优先。
function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) return;
    const value = match[2].replace(/^(?:"(.*)"|'(.*)')$/, '$1$2');
    process.env[match[1]] = value;
  });
}
loadEnvFile();
const PORT = Number(process.env.PORT || 8123);
// 【本地修复 · 2026-09-24】原来 listen(PORT) 会绑 0.0.0.0，同网段任何人都能访问
// （配合 GET /.env 就等于把 API Key 公开）。默认只绑本机，需要局域网访问时设 HOST=0.0.0.0。
const HOST = process.env.HOST || '127.0.0.1';

// 【安全修复 · 2026-10-13】同源校验 + 限流，堵住「恶意网页借本机服务外发 .env 密钥」的攻击链：
// 浏览器跨站 fetch/XHR 一定带 Origin 头，而 Content-Type: text/plain 的「简单请求」可以
// 绕过 CORS 预检直接打到本服务——服务端不校验来源的话，恶意网页只需在请求体里带上
// settings.baseUrl=攻击者服务器，本服务就会拿着 .env 里的真实 Key 去转发（密钥外发），
// 还能无限刷上游配额。因此：
//   Host   必须是本机地址（防 DNS rebinding；HTTP/1.0 缺 Host 头的老客户端放行）
//   Origin 允许「无 Origin」(curl/桌面工具) 与 "null" (file:// 双击直开的推荐用法)，
//          其余第三方来源一律 403。file:// 用户建议优先用「左下角齿轮」配置 Key——
//          该 Key 只存在浏览器本地、随请求体发送，恶意网页拿不到，攻击链自然断裂。
const ALLOWED_HOSTS = new Set([
  'localhost:' + PORT,
  '127.0.0.1:' + PORT,
  '[::1]:' + PORT
]);
const ALLOWED_ORIGINS = new Set([
  'http://localhost:' + PORT,
  'http://127.0.0.1:' + PORT
]);
const RATE_LIMIT = { max: 30, windowMs: 60000 }; // 每分钟 30 次对话请求，防脚本刷上游配额
let rateCount = 0;
let rateWindowStart = 0;

function checkRequestGuards(req, res) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host && !ALLOWED_HOSTS.has(host)) {
    sendJson(res, 403, { error: '拒绝访问：Host 不是本机地址。' });
    return false;
  }
  const origin = String(req.headers.origin || '');
  if (origin && origin !== 'null' && !ALLOWED_ORIGINS.has(origin)) {
    sendJson(res, 403, { error: '拒绝跨站请求。' });
    return false;
  }
  const now = Date.now();
  if (now - rateWindowStart > RATE_LIMIT.windowMs) {
    rateWindowStart = now;
    rateCount = 0;
  }
  rateCount += 1;
  if (rateCount > RATE_LIMIT.max) {
    sendJson(res, 429, { error: '请求过于频繁，请稍后再试。' });
    return false;
  }
  return true;
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求内容过大'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-MAX_MESSAGES).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    // 系统提示仅用于页面展示错误状态，不把浏览器可控内容提升为模型 system 指令。
    if (!['user', 'assistant'].includes(item.role)) return [];
    if (typeof item.text !== 'string') return [];
    const text = item.text.trim().slice(0, MAX_MESSAGE_CHARS);
    return text ? [{ role: item.role, content: text }] : [];
  });
}

function errorText(payload) {
  return payload && payload.error && typeof payload.error.message === 'string'
    ? payload.error.message
    : 'AI 服务暂时不可用';
}

async function handleChat(req, res) {
  // 密钥可能来自前端的「模型设置」（左下角齿轮），所以这里不能提前拦；等 body 解析完再判断。

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: '请求必须是有效 JSON，且大小不超过 64KB。' });
    return;
  }
  // 【本地修复 · 2026-09-24】body 恰为字面量 null 时 JSON.parse 正常返回 null，
  // 下一行 payload.messages 会抛 TypeError；handleChat 是 async，异常无人 catch，
  // 未处理的 promise rejection 会直接把整个 node 进程带走（实测 returncode=1）。
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendJson(res, 400, { error: '请求体必须是 JSON 对象。' });
    return;
  }
  const messages = normalizeMessages(payload.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    sendJson(res, 400, { error: '请至少提供一条用户消息。' });
    return;
  }

  // 【本地修复 · 2026-09-24】允许前端（左下角齿轮）覆盖模型配置：
  // 用户可以在本机填自己的接口地址 / 模型 / API Key（只存在浏览器 localStorage，随请求发来）。
  // 前端没填的字段一律回落到服务端 .env，保持原有部署方式不变。
  const s = (payload.settings && typeof payload.settings === 'object') ? payload.settings : {};
  const cliKey = (typeof s.apiKey === 'string') ? s.apiKey.trim() : '';
  const cliBase = (typeof s.baseUrl === 'string') ? s.baseUrl.trim() : '';
  const cliModel = (typeof s.model === 'string') ? s.model.trim() : '';
  const cliProto = (s.protocol === 'responses' || s.protocol === 'chat-completions') ? s.protocol : '';
  const apiKey = cliKey || process.env.AI_API_KEY || '';
  if (!apiKey) {
    sendJson(res, 503, {
      error: '还没有配置模型。点左下角齿轮填写接口地址与 API Key，或把 .env.example 复制为 .env 配置服务端。'
    });
    return;
  }
  const baseUrl = (cliBase || process.env.AI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = cliModel || process.env.AI_MODEL || 'gpt-5-mini';
  const protocol = cliProto || process.env.AI_API_PROTOCOL || 'responses';
  let url;
  let requestBody;
  if (protocol === 'chat-completions') {
    url = baseUrl + '/chat/completions';
    requestBody = { model, messages };
  } else {
    url = baseUrl + '/responses';
    requestBody = {
      model,
      input: messages.map((message) => ({ role: message.role, content: message.content }))
    };
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(60000)
    });
  } catch (error) {
    sendJson(res, 502, { error: '无法连接 AI 服务，请检查 AI_API_BASE_URL 与网络。' });
    return;
  }

  let result;
  try { result = await upstream.json(); } catch (error) { result = null; }
  if (!upstream.ok) {
    sendJson(res, upstream.status >= 400 && upstream.status < 500 ? 400 : 502, { error: errorText(result) });
    return;
  }
  const text = protocol === 'chat-completions'
    ? result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content
    : result && result.output_text;
  if (typeof text !== 'string' || !text.trim()) {
    sendJson(res, 502, { error: 'AI 服务没有返回可显示的文本。' });
    return;
  }
  sendJson(res, 200, { text: text.trim() });
}

// 请求路径解析：不用 new URL(req.url, base) —— 请求 "//" 会抛 ERR_INVALID_URL 直接把整个服务打崩；
// 非法的百分号编码（如 "/%"）也会抛 URIError。这里统一降级为安全字符串，并把重复斜杠折叠掉。
function safePathname(rawUrl) {
  const pathOnly = String(rawUrl || '/').split('?')[0].split('#')[0];
  let decoded;
  try { decoded = decodeURIComponent(pathOnly); } catch (error) { decoded = pathOnly; }
  return decoded.replace(/\/{2,}/g, '/');
}

// 【本地修复 · 2026-09-24】静态资源扩展名白名单。
// 原实现是「只要落在 ROOT 之内就发」，于是 GET /.env 会把 AI_API_KEY 明文返回给任何访问者
// （而服务默认绑 0.0.0.0，同网段任何人都能取到）。现在叠加两道：拒绝点开头路径段 + 扩展名白名单。
const STATIC_EXT = new Set([
  '.html', '.htm', '.js', '.css', '.map', '.json', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.ico', '.txt', '.woff', '.woff2', '.ttf'
]);

function serveStatic(req, res) {
  const pathname = safePathname(req.url);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

  const dotSegment = relative.split(/[\\/]+/).some((seg) => seg.startsWith('.'));
  const ext = path.extname(relative).toLowerCase();
  if (dotSegment || !STATIC_EXT.has(ext)) { res.writeHead(403); res.end(); return; }

  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (error, data) => {
    if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(); return; }
    const type = path.extname(filePath) === '.html' ? 'text/html; charset=utf-8'
      : path.extname(filePath) === '.js' ? 'text/javascript; charset=utf-8'
      : path.extname(filePath) === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    // 开发期务必 no-store：否则改了 js/css 后浏览器仍用旧缓存（静态资源无版本号，排查起来很费时）
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data);
  });
}

http.createServer((req, res) => {
  // 【本地修复 · 2026-09-24】请求处理函数里抛异常会直接杀死进程（作者修过 new URL 那一例，
  // 同类路径还有别的）。这里统一兜住，任何异常都只回 500，不影响服务存活。
  if (req.method === 'POST' && req.url === '/api/ai/chat') {
    if (!checkRequestGuards(req, res)) return;
    handleChat(req, res).catch((error) => {
      console.error('[server] uncaught error in /api/ai/chat:', error);
      try {
        if (!res.headersSent) sendJson(res, 500, { error: '服务端内部错误' });
        else res.end();
      } catch (ignored) { /* 连接已断开，忽略 */ }
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405, { Allow: 'GET, HEAD, POST' }); res.end();
}).listen(PORT, HOST, () => console.log('Flow Agent server started: http://localhost:' + PORT));
