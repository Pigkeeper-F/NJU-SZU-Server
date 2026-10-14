/**
 * 流程智能体的本地服务：提供静态页面和受保护的 AI 代理接口。
 * API Key 只从服务端环境变量读取，绝不发送给浏览器。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CodexBridge } = require('./tools/codex-bridge');

const ROOT = __dirname;
const codex = new CodexBridge(ROOT);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 4000;
const WORKFLOW_FILES = Object.freeze({
  'download-data': 'download-data-workflow-draft.md',
  'clean-data': 'clean-data-workflow-draft.md',
  'calculation': 'calculation-workflow-draft.md',
  'result-audit': 'result-audit-workflow.md',
  'parameter-update': 'parameter-update-workflow-draft.md',
  'activity-data-update': 'activity-data-update-workflow-draft.md',
  'literature-mining': 'literature-mining-workflow.md',
  'manual-review': 'manual-review-workflow-draft.md',
  'plotting': 'plotting-workflow-draft.md'
});

function workflowPrompt(module, executor = 'api') {
  if (!module || !Object.hasOwn(WORKFLOW_FILES, module.type)) return null;
  const workflow = fs.readFileSync(path.join(ROOT, 'docs', WORKFLOW_FILES[module.type]), 'utf8');
  const shared = fs.readFileSync(path.join(ROOT, 'docs', 'workflow-drafts.md'), 'utf8');
  return [
    '你是研究工作台中当前模块的工作流助手。请用中文协助用户逐步完成下面的工作流。',
    '先结合当前对话识别已知输入、已确认规则、当前进度和下一步；只确认工作流明确提及且当前确实需要决定的点，或会实质影响结果正确性、科学判断、数据安全和执行授权的关键点。已有答案和已确认规则直接采用，不反复询问。',
    '文档中的需对齐内容是尚未确定的业务选项，不是已批准规则。提供具体建议或默认方案并注明假设，涉及关键科学判断、删除/插补/替换策略时先让用户确认。不要一次性要求回答全部待对齐项。',
    '按定义、输入、执行、交付、检查、异常推进，直接帮助整理方案、规则、数据结构、代码、报告与交接内容；只在有证据时报告完成或通过检查。输出应具体、简洁，优先给出当前可用成果与下一步。',
    executor === 'api' ? '当前系统只提供文字对话，没有文件读取、下载、代码执行、浏览、数据库或模块操作工具。不能声称已经下载数据、读取未提供的文件、运行计算或生成实际附件。需要外部操作时提供可执行步骤或代码，并让用户提供结果后继续检查。API 接入不等于拥有这些工具。' : ['clean-data', 'calculation', 'result-audit'].includes(module.type) ? '本次是 Codex 本地文件任务。按任务模式读取已上传数据、代码与计算结果；只在允许执行的模块与模式下写入输出目录。只有实际执行成功时才报告完成。' : '本次是本机 Codex 模块对话。当前模块仅提供方案、规则和结果检查的文字指导；没有上传文件、联网浏览、下载或写入执行功能。不要声称已访问网站、读取未上传的文件、运行计算或生成实际附件。',
    '人工审核模块中，AI 只能提供审核建议和证据整理，最终人工决定由用户给出。SOC 是可替换示例，仅在主题适用时采用。',
    '区分用户提供的信息、假设、建议、待确认事项与已验证结果；不编造来源、数值、文献、运行结果或审核结论。保持当前模块职责，交接时说明下游需要的成果及版本。',
    module.type === 'calculation' ? '当前计算方式：' + ({ direct: '直接运行已有代码，不修改计算方法', modify: '按研究者确认的规则修改代码后计算', 'parameter-update': '参数更新后计算', 'activity-data-update': '活动数据更新后计算' }[module.mode] || '尚未选择，请结合用户需求对齐') : '',
    '当前模块工作流：\n' + workflow,
    '跨模块交接与待对齐背景：\n' + shared,
    '回复风格（适用于所有模块）：只回复当前最关键、精炼的内容，先给结论或成果，再给必要的下一步。一般控制在 200 字以内或 3–5 个短要点；用户明确要求详细说明、代码或表格时再按需展开。不要每轮复述工作流、已知输入或完整对话。',
    '不展示思考过程、内部推理、探索过程、工具调用逐步播报或自我叙述（例如“我先分析”“接下来运行”“刚才尝试失败”）。在内部完成必要分析和核对后，只回复最终结果；仍需用户决定时只提出关键确认问题。实际失败、重要风险、必要假设和检查结果不能省略，但只简短说明影响与处理建议。交付文件只列关键文件名与下载位置，不粘贴冗长本地路径或原始日志。',
    '精简对齐：不要扩展工作流之外的问卷，不要求逐项确认所有可选设置。将当前必需的确认点合并为一轮短问，通常 1–3 个；若没有关键缺口，立即进入下一步。低风险、可逆且不影响核心结论的细节采用合理默认，仅在影响使用时简短注明。用户已同意方案后直接执行，不再为同一方案重复索要确认；仅在发现新的关键冲突或风险时追加必要确认。不得以缩短对齐为由跳过工作流要求的执行授权、关键科学判断或破坏性数据处理确认。'
  ].filter(Boolean).join('\n\n');
}
const PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    protocol: 'chat-completions'
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    protocol: 'responses'
  }
};

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

function readBody(req, limit = MAX_BODY_BYTES, binary = false) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > limit) {
        reject(new Error('请求内容过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { const body = Buffer.concat(chunks); resolve(binary ? body : body.toString('utf8')); });
    req.on('error', reject);
  });
}

function openDependencies(res) {
  const file = path.join(ROOT, 'requirements.txt');
  if (!fs.existsSync(file)) return sendJson(res, 500, { error: '依赖清单不存在' });
  const editor = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'notepad.exe' : null;
  if (!editor) return sendJson(res, 501, { error: '当前系统暂不支持自动打开文本编辑器，请手动打开项目根目录的 requirements.txt' });
  const args = process.platform === 'darwin' ? ['-a', 'TextEdit', file] : [file];
  const child = spawn(editor, args, { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.once('error', (error) => sendJson(res, 500, { error: '无法打开文本编辑器：' + error.message }));
  child.once('spawn', () => { child.unref(); sendJson(res, 200, { ok: true }); });
}

async function handleCodex(req, res, url) {
  try {
    const route = url.pathname;
    if (req.method === 'GET' && route === '/api/codex/status') return sendJson(res, 200, await codex.status());
    if (req.method === 'POST' && route === '/api/codex/session') return sendJson(res, 201, codex.createSession());
    if (req.method === 'GET' && route === '/api/codex/files') return sendJson(res, 200, { files: codex.files(url.searchParams.get('session')) });
    if (req.method === 'POST' && route === '/api/codex/upload') {
      const data = await readBody(req, 20 * 1024 * 1024, true);
      if (!data.length) throw new Error('文件为空');
      return sendJson(res, 201, codex.upload(url.searchParams.get('session'), url.searchParams.get('name'), data, url.searchParams.get('group') || 'input'));
    }
    if (req.method === 'POST' && route === '/api/codex/run') {
      const data = JSON.parse(await readBody(req));
      if (!Object.hasOwn(WORKFLOW_FILES, data.module?.type)) throw new Error('未知工作流模块');
      if (!['clean-data', 'calculation'].includes(data.module.type) && data.execute === true) throw new Error('当前模块仅支持拟方案');
      if (data.module.type === 'calculation' && !['direct', 'modify'].includes(data.module.mode)) throw new Error('请先选择直接计算或修改计算');
      const messages = normalizeMessages(data.messages);
      if (!messages.length || messages.at(-1).role !== 'user') throw new Error('请提供用户指令');
      return sendJson(res, 202, await codex.run(data.sessionId, messages, workflowPrompt(data.module, 'codex'), ['clean-data', 'calculation'].includes(data.module.type) && data.execute === true, typeof data.model === 'string' ? data.model : null, data.module.type, data.module.mode));
    }
    if (req.method === 'GET' && route === '/api/codex/job') return sendJson(res, 200, codex.snapshot(url.searchParams.get('id')));
    if (req.method === 'POST' && route === '/api/codex/cancel') return sendJson(res, 200, await codex.cancel(url.searchParams.get('id')));
    if (req.method === 'GET' && route === '/api/codex/download') {
      const file = codex.download(url.searchParams.get('session'), url.searchParams.get('group'), url.searchParams.get('name') || '');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(file)), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      return;
    }
    sendJson(res, 404, { error: '接口不存在' });
  } catch (error) { sendJson(res, 400, { error: error.message }); }
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

function normalizeCredential(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = PROVIDERS[raw.provider] ? raw.provider : 'openai';
  const preset = PROVIDERS[provider];
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : preset.baseUrl).replace(/\/$/, ''),
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : preset.model,
    protocol: raw.protocol === 'chat-completions' || raw.protocol === 'responses' ? raw.protocol : preset.protocol
  };
}

function envCredential() {
  if (!process.env.AI_API_KEY) return null;
  return {
    apiKey: process.env.AI_API_KEY,
    baseUrl: (process.env.AI_API_BASE_URL || PROVIDERS.openai.baseUrl).replace(/\/$/, ''),
    model: process.env.AI_MODEL || PROVIDERS.openai.model,
    protocol: process.env.AI_API_PROTOCOL || PROVIDERS.openai.protocol
  };
}

async function handleChat(req, res) {
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
  let instructions;
  try { instructions = workflowPrompt(payload.module); }
  catch (error) {
    sendJson(res, 500, { error: '当前模块工作流文档无法读取，请检查本地服务文件。' });
    return;
  }
  if (!instructions) {
    sendJson(res, 400, { error: '请选择有效的工作流模块后发送消息。' });
    return;
  }
  const credential = normalizeCredential(payload.credential) || envCredential();
  if (!credential) {
    sendJson(res, 503, { error: '尚未配置 API Key。请点击页面右上角「添加 API」选择 DeepSeek 或 OpenAI 并粘贴密钥。' });
    return;
  }

  let url;
  let requestBody;
  if (credential.protocol === 'chat-completions') {
    url = credential.baseUrl + '/chat/completions';
    requestBody = { model: credential.model, messages: [{ role: 'system', content: instructions }, ...messages] };
  } else {
    url = credential.baseUrl + '/responses';
    requestBody = {
      model: credential.model,
      instructions,
      input: messages.map((message) => ({ role: message.role, content: message.content }))
    };
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential.apiKey },
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
  const text = credential.protocol === 'chat-completions'
    ? result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content
    : result && result.output_text;
  if (typeof text !== 'string' || !text.trim()) {
    sendJson(res, 502, { error: 'AI 服务没有返回可显示的文本。' });
    return;
  }
  sendJson(res, 200, { text: text.trim() });
}

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) { res.writeHead(403); res.end(); return; }
  // Only public assets are served. Uploaded files and local credentials use no static route.
  if (!(relative === 'index.html' || /^(?:css|js|docs)\/[\w\-/]+\.(?:css|js|md|svg)$/.test(relative))) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (error, data) => {
    if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(); return; }
    const type = path.extname(filePath) === '.html' ? 'text/html; charset=utf-8'
      : path.extname(filePath) === '.js' ? 'text/javascript; charset=utf-8'
      : path.extname(filePath) === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const expectedHost = ['localhost:' + PORT, '127.0.0.1:' + PORT, '[::1]:' + PORT];
  if (!expectedHost.includes(req.headers.host) || (req.headers.origin && !expectedHost.map(host => 'http://' + host).includes(req.headers.origin))) return sendJson(res, 403, { error: '只允许本机工作台访问' });
  if ((req.url.startsWith('/api/codex/') || req.url === '/api/dependencies/open') && req.method === 'POST' && req.headers['x-workbench'] !== '1') return sendJson(res, 403, { error: '请从工作台发起请求' });
  if (req.url.startsWith('/api/codex/')) return handleCodex(req, res, new URL(req.url, 'http://localhost'));
  if (req.method === 'POST' && req.url === '/api/dependencies/open') return openDependencies(res);
  if (req.method === 'POST' && req.url === '/api/ai/chat') return handleChat(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405, { Allow: 'GET, HEAD, POST' }); res.end();
}).listen(PORT, '127.0.0.1', () => console.log('流程智能体已启动：http://localhost:' + PORT));
function shutdown() { codex.close(); server.close(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
