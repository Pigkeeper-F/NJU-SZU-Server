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
  if (!process.env.AI_API_KEY) {
    sendJson(res, 503, { error: '服务端尚未配置 AI_API_KEY。请复制 .env.example 为 .env 并设置密钥。' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: '请求必须是有效 JSON，且大小不超过 64KB。' });
    return;
  }
  const messages = normalizeMessages(payload.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    sendJson(res, 400, { error: '请至少提供一条用户消息。' });
    return;
  }

  const baseUrl = (process.env.AI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'gpt-5-mini';
  const protocol = process.env.AI_API_PROTOCOL || 'responses';
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
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.AI_API_KEY },
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

function serveStatic(req, res) {
  const pathname = safePathname(req.url);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
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
  if (req.method === 'POST' && req.url === '/api/ai/chat') return handleChat(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405, { Allow: 'GET, HEAD, POST' }); res.end();
}).listen(PORT, () => console.log('流程智能体已启动：http://localhost:' + PORT));
