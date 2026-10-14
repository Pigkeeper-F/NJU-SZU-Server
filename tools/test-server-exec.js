/**
 * 【T3 · 2026-10-14】执行内核端到端测试（node 直跑，零依赖）。
 * 【W2 · 2026-10-14】扩展：数据文件上传 / 文件名穿越 / 大小限制 / compose template / chat 环节上下文。
 * 【X1 · 2026-10-14】扩展：compose feedback 注入 / diagnose / isPrivateHost / urls 下载 / preview。
 *
 *   node tools/test-server-exec.js
 *
 * 起一个 server.js 子进程（PORT=8199，HOST=127.0.0.1），逐项断言 compose / exec 端点：
 *   1) exec node 正常           2) 产物 artifacts      3) 超时 kill
 *   4) 输出截断 20KB            5) confirm 缺失 400    6) lang 非法 400
 *   7) 第三方 Origin 403        8) compose 无 key 503   9) python（可用则测）
 *  10) files 上传读写           11) 文件名穿越防护      12) 文件大小限制 400
 *  13) compose template（非法 400 / align 无 key 503） 14) chat 带 module 无 key 503
 *  15) chat 带 module + 假 Key → 走上游（502），环节上下文注入不崩
 *  16) compose(code) feedback 注入（mock 上游 8198 抓取真实提示词） 17) 无 feedback 行为不变
 *  18) isPrivateHost 纯函数（require server.js，require.main 守卫不监听端口）
 *  19) diagnose：合法 JSON → {level,reason}；非 JSON / 非法 level → {text}
 *  20) urls 私网默认拒绝（SSRF）+ 非法协议该条失败 + urls 非数组 400
 *  21) YANXU_ALLOW_PRIVATE_HOST=1（第二实例 8201）：下载 server 自身 /package.json +
 *      404 条目失败其余继续 + 512KB 超限（mock /big.txt）
 *  22) artifacts preview：out.csv 多行 / 60 行截 50 行 / .bin 无 preview
 * 全通过输出 ALL_EXEC_TESTS_PASS。
 *
 * 注意：为避免读取项目 .env 里真实 AI_API_KEY，子进程显式传 AI_API_KEY=''（Windows 下
 * 空环境变量仍是「已定义」→ loadEnvFile 跳过 → 解析结果为无 Key），从而稳定复现 503。
 * 临时执行目录统一落在系统临时目录（YANXU_RUN_DIR=$TMP/yanxu-test-runs），不污染用户目录。
 * 测试临时产物（mock /big.txt 等）只存在于内存；下载文件写入 YANXU_RUN_DIR，不碰项目文件。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = 8199;
const MOCK_PORT = 8198;  // mock 上游（抓取提示词 / 提供大文件下载源）
const PORT_PRIVATE_OK = 8201; // YANXU_ALLOW_PRIVATE_HOST=1 的第二实例
const RUN_BASE = path.join(os.tmpdir(), 'yanxu-test-runs'); // 隔离：执行目录不进用户主目录

// 【X1 · 2026-10-14】require server.js 复用纯函数（require.main 守卫 → 不会重复监听端口）。
const serverModule = require(path.join(ROOT, 'server.js'));

let server = null;
let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('  PASS  ' + name);
  } else {
    failed += 1;
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function reqTo(port, method, pathUrl, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const opts = {
      host: HOST,
      port: port,
      method: method,
      path: pathUrl,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {})
    };
    if (data) opts.headers['Content-Length'] = data.length;
    const r = http.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (error) { json = null; }
        resolve({ status: res.statusCode, json: json, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const req = (method, pathUrl, body, headers) => reqTo(PORT, method, pathUrl, body, headers);

function startServerOn(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(port), HOST: HOST, AI_API_KEY: '', YANXU_RUN_DIR: RUN_BASE
      }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => console.log('[server:' + port + '] ' + chunk.toString().trim()));
    child.stderr.on('data', (chunk) => console.error('[server-err:' + port + '] ' + chunk.toString().trim()));
    child.on('error', reject);

    const deadline = Date.now() + 8000;
    (function poll() {
      const probe = http.request({ host: HOST, port: port, method: 'GET', path: '/' }, (res) => {
        res.resume();
        resolve(child);
      });
      probe.on('error', () => {
        if (Date.now() > deadline) reject(new Error('服务器启动超时（8s）：port=' + port));
        else setTimeout(poll, 150);
      });
      probe.end();
    })();
  });
}

function startServer() { return startServerOn(PORT); }

// 【X1 · 2026-10-14】mock 上游（chat-completions 协议）：记录最近一次请求体；
// GET /big.txt 返回 600KB 文本（供 512KB 超限断言）；其余路径返回 mockReply。
let mockReply = 'mock-reply';
let lastUpstreamBody = null;
function startMockUpstream() {
  return new Promise((resolve, reject) => {
    const mock = http.createServer((mreq, mres) => {
      if (mreq.method === 'GET' && mreq.url === '/big.txt') {
        mres.writeHead(200, { 'Content-Type': 'text/plain' });
        mres.end('b'.repeat(600 * 1024));
        return;
      }
      let buf = '';
      mreq.setEncoding('utf8');
      mreq.on('data', (c) => { buf += c; });
      mreq.on('end', () => {
        try { lastUpstreamBody = JSON.parse(buf); } catch (error) { lastUpstreamBody = null; }
        mres.writeHead(200, { 'Content-Type': 'application/json' });
        mres.end(JSON.stringify({ choices: [{ message: { content: mockReply } }] }));
      });
    });
    mock.on('error', reject);
    mock.listen(MOCK_PORT, HOST, () => resolve(mock));
  });
}

async function run() {
  const mockUpstream = await startMockUpstream();
  server = await startServer();
  console.log('\n开始执行端点测试：http://' + HOST + ':' + PORT);

  console.log('\n[1] exec node 正常');
  let r = await req('POST', '/api/code/exec', { lang: 'node', code: "console.log('ok')", confirm: true });
  check('状态 200', r.status === 200, 'got ' + r.status);
  check('ok === true', !!(r.json && r.json.ok === true), JSON.stringify(r.json));
  check('stdout 含 ok', !!(r.json && typeof r.json.stdout === 'string' && r.json.stdout.includes('ok')), r.json && JSON.stringify(r.json.stdout));

  console.log('\n[2] 产物 artifacts');
  r = await req('POST', '/api/code/exec', { lang: 'node', code: "require('node:fs').writeFileSync('out.txt','x')", confirm: true });
  check('状态 200', r.status === 200, 'got ' + r.status);
  const hasArtifact = !!(r.json && Array.isArray(r.json.artifacts)
    && r.json.artifacts.some((a) => a.name === 'out.txt' && a.size === 1));
  check('artifacts 含 out.txt（size=1）', hasArtifact, JSON.stringify(r.json && r.json.artifacts));

  console.log('\n[3] 超时 kill（while(true){}）');
  r = await req('POST', '/api/code/exec', { lang: 'node', code: 'while(true){}', confirm: true });
  check('状态 200', r.status === 200, 'got ' + r.status);
  check('ok === false', !!(r.json && r.json.ok === false), JSON.stringify(r.json && r.json.ok));
  check('error 提到「超时」', !!(r.json && typeof r.json.error === 'string' && r.json.error.includes('超时')), r.json && r.json.error);

  console.log('\n[4] 输出截断 20KB');
  r = await req('POST', '/api/code/exec', { lang: 'node', code: "process.stdout.write('a'.repeat(30000))", confirm: true });
  check('状态 200', r.status === 200, 'got ' + r.status);
  const bigOut = (r.json && r.json.stdout) || '';
  check('stdout 长度受限（< 30000）', bigOut.length < 30000, 'len=' + bigOut.length);
  check('含 [已截断] 标记', bigOut.includes('[已截断]'), 'len=' + bigOut.length);

  console.log('\n[5] confirm 缺失 → 400');
  r = await req('POST', '/api/code/exec', { lang: 'node', code: 'console.log(1)' });
  check('状态 400', r.status === 400, 'got ' + r.status);

  console.log('\n[6] lang 非法 → 400');
  r = await req('POST', '/api/code/exec', { lang: 'ruby', code: 'puts 1', confirm: true });
  check('状态 400', r.status === 400, 'got ' + r.status);

  console.log('\n[7] 第三方 Origin → 403');
  r = await req('POST', '/api/ai/compose', {
    mode: 'doc',
    module: { name: 'x', spec: {} },
    messages: [{ role: 'user', text: 'hi' }],
    settings: { apiKey: 'sk-test' }
  }, { Origin: 'http://evil.example.com' });
  check('状态 403', r.status === 403, 'got ' + r.status);

  console.log('\n[8] compose 无 key → 503');
  r = await req('POST', '/api/ai/compose', {
    mode: 'doc',
    module: { name: 'x', spec: {} },
    messages: [{ role: 'user', text: 'hi' }]
  });
  check('状态 503', r.status === 503, 'got ' + r.status + ' body=' + r.raw);

  console.log('\n[9] python 执行（若解释器可用）');
  r = await req('POST', '/api/code/exec', { lang: 'python', code: "print('py-ok')", confirm: true });
  if (r.status === 400 && r.json && /python/.test(r.json.error || '')) {
    console.log('  SKIP  本机 python 解释器不可用：' + r.json.error);
  } else {
    check('状态 200', r.status === 200, 'got ' + r.status + ' body=' + r.raw);
    check('stdout 含 py-ok', !!(r.json && typeof r.json.stdout === 'string' && r.json.stdout.includes('py-ok')), r.json && JSON.stringify(r.json.stdout));
  }

  console.log('\n[10] exec files 数据文件上传（脚本读 input.csv 并使用其内容）');
  r = await req('POST', '/api/code/exec', {
    lang: 'node',
    code: "const fs=require('node:fs');const t=fs.readFileSync('input.csv','utf8').trim().split('\\n').join(';');fs.writeFileSync('result.txt',t);",
    confirm: true,
    files: [{ name: 'input.csv', content: 'a,b,c\n1,2,3\n' }]
  });
  check('状态 200', r.status === 200, 'got ' + r.status + ' body=' + r.raw);
  check('ok === true', !!(r.json && r.json.ok === true), JSON.stringify(r.json && r.json.error));
  const dir10 = (r.json && r.json.dir) || '';
  check('dir 位于 YANXU_RUN_DIR 下', !!dir10 && dir10.startsWith(RUN_BASE), dir10);
  check('fallback === false', !!(r.json && r.json.fallback === false), String(r.json && r.json.fallback));
  let result10 = '';
  try { result10 = fs.readFileSync(path.join(dir10, 'result.txt'), 'utf8'); } catch (error) { result10 = ''; }
  check('产物内容 = 输入内容', result10 === 'a,b,c;1,2,3', JSON.stringify(result10));
  check('artifacts 含 result.txt', !!(r.json && Array.isArray(r.json.artifacts)
    && r.json.artifacts.some((a) => a.name === 'result.txt')), JSON.stringify(r.json && r.json.artifacts));

  console.log('\n[11] files 文件名穿越（..\\\\evil.txt / ../../evil2.txt）→ 拒绝或 sanitize，不写到目录外');
  r = await req('POST', '/api/code/exec', {
    lang: 'node',
    code: "require('node:fs').writeFileSync('out.txt','done')",
    confirm: true,
    files: [
      { name: '..\\evil.txt', content: 'EVIL1' },
      { name: '../../evil2.txt', content: 'EVIL2' }
    ]
  });
  check('状态 200 或 400（拒绝或 sanitize 均可）', r.status === 200 || r.status === 400, 'got ' + r.status + ' body=' + r.raw);
  if (r.status === 200) {
    const dir11 = (r.json && r.json.dir) || '';
    const base11 = path.dirname(dir11);
    check('未写到执行目录（上一层）之外', !fs.existsSync(path.join(base11, 'evil.txt')), path.join(base11, 'evil.txt'));
    check('未写到执行目录（上两层）之外', !fs.existsSync(path.join(path.dirname(base11), 'evil2.txt')), path.join(path.dirname(base11), 'evil2.txt'));
  }

  console.log('\n[12] 文件大小限制 → 400');
  r = await req('POST', '/api/code/exec', {
    lang: 'node', code: "console.log('n')", confirm: true,
    files: [{ name: 'big.txt', content: 'x'.repeat(600 * 1024) }] // 600KB > 单文件 512KB
  });
  check('单文件超 512KB → 400', r.status === 400, 'got ' + r.status + ' body=' + r.raw);
  r = await req('POST', '/api/code/exec', {
    lang: 'node', code: "console.log('n')", confirm: true,
    files: [
      { name: 'a.txt', content: 'y'.repeat(400 * 1024) },
      { name: 'b.txt', content: 'y'.repeat(400 * 1024) },
      { name: 'c.txt', content: 'y'.repeat(400 * 1024) }
    ]
  }); // 合计 1.2MB > 总量 1MB（单文件均 ≤512KB）
  check('总量超 1MB → 400', r.status === 400, 'got ' + r.status + ' body=' + r.raw);

  console.log('\n[13] compose template');
  r = await req('POST', '/api/ai/compose', {
    mode: 'doc', template: 'bogus', module: { name: 'x', spec: {} }, messages: [{ role: 'user', text: 'hi' }]
  });
  check('template 非法 → 400', r.status === 400, 'got ' + r.status + ' body=' + r.raw);
  r = await req('POST', '/api/ai/compose', {
    mode: 'doc', template: 'align', module: { name: '数据对齐', spec: { goal: '统一口径' } },
    messages: [{ role: 'user', text: '对齐中国与全球数据' }]
  });
  if (r.status === 503) {
    console.log('  SKIP  无 Key：template=align 返回 503（语义正确，不算失败）');
  } else {
    check('template=align → 200', r.status === 200, 'got ' + r.status + ' body=' + r.raw);
    check('返回 text', !!(r.json && typeof r.json.text === 'string' && r.json.text.trim()), r.raw);
  }

  console.log('\n[14] chat 带 module 且无 Key → 503 语义不变');
  r = await req('POST', '/api/ai/chat', {
    messages: [{ role: 'user', text: 'hi' }],
    module: { name: '数据清洗', spec: { goal: '标准化', todo: ['去重'], output: 'clean.csv', acceptance: '无重复' } }
  });
  check('状态 503', r.status === 503, 'got ' + r.status + ' body=' + r.raw);

  console.log('\n[15] chat 带 module + 假 Key → 走上游调用（502 连接失败），环节上下文注入不崩');
  r = await req('POST', '/api/ai/chat', {
    messages: [{ role: 'user', text: 'hi' }],
    module: {
      name: '数据清洗',
      spec: { goal: '把原始数据标准化', todo: ['去重', '单位统一'], output: 'clean.csv', acceptance: '无重复且单位一致' },
      upstream: [{ name: '数据采集', doc: '·'.repeat(500) }, { name: '口径对齐', doc: 'upstream doc 2' }]
    },
    settings: { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9', protocol: 'chat-completions' }
  });
  check('非 500 且为 502（连接失败，非上下文构建崩溃）', r.status === 502, 'got ' + r.status + ' body=' + r.raw);

  // ============================================================================
  // 【X1 · 2026-10-14】第三批扩展测试（[16]-[22]）
  // ============================================================================
  const mockSettings = { apiKey: 'sk-test', baseUrl: 'http://' + HOST + ':' + MOCK_PORT, protocol: 'chat-completions' };
  const upstreamPrompt = () => (lastUpstreamBody && Array.isArray(lastUpstreamBody.messages))
    ? lastUpstreamBody.messages.map((m) => m.content).join('\n') : '';

  console.log('\n[16] compose(code) feedback 注入（mock 上游抓取提示词 + 纯函数双验）');
  mockReply = 'mock-code-ok';
  r = await req('POST', '/api/ai/compose', {
    mode: 'code',
    module: { name: '数据清洗', spec: { goal: '标准化' } },
    messages: [
      { role: 'user', text: '生成清洗代码' },
      { role: 'system', text: '文档打回：第三章口径映射表与上游对不上，请修订。' },
      { role: 'user', text: '已修订' },
      { role: 'system', text: '结果复核打回：输出缺少表头。' }
    ],
    feedback: { stderr: 'STDERR_MARK_9f3a: TypeError: Cannot read properties of undefined', note: '请处理空值行' },
    settings: mockSettings
  });
  check('状态 200', r.status === 200, 'got ' + r.status + ' body=' + r.raw);
  let p = upstreamPrompt();
  check('提示词含 stderr 片段', p.includes('STDERR_MARK_9f3a'), p.slice(-600));
  check('提示词含「上一轮执行失败信息（stderr）」', p.includes('上一轮执行失败信息（stderr）'), '');
  check('提示词含人工反馈', p.includes('请处理空值行') && p.includes('上一轮人工反馈'), '');
  check('提示词含「文档打回：」线索', p.includes('文档打回：'), '');
  check('提示词含「结果复核打回：」线索', p.includes('结果复核打回：'), '');
  check('提示词含【上轮反馈线索】段', p.includes('【上轮反馈线索】'), '');
  check('提示词含「本次生成的代码必须避免上述问题」', p.includes('本次生成的代码必须避免上述问题'), '');
  check('system 消息不进【对话记录】', !p.includes('【对话记录】\n系统：'), '');
  // 纯函数直验：不经过 HTTP 也能测（serverModule.buildComposePrompt）
  const purePrompt = serverModule.buildComposePrompt({
    mode: 'code',
    module: { name: 'x', spec: {} },
    messages: [{ role: 'system', text: '文档打回：PURE_MARK_2b7d 口径错误' }],
    feedback: { stderr: 'PURE_STDERR_4c8e' }
  });
  check('纯函数：含 stderr 片段', purePrompt.includes('PURE_STDERR_4c8e'), '');
  check('纯函数：含打回线索', purePrompt.includes('PURE_MARK_2b7d'), '');

  console.log('\n[17] feedback 缺省 / 无打回线索 → 行为不变');
  mockReply = 'mock-plain';
  r = await req('POST', '/api/ai/compose', {
    mode: 'code',
    module: { name: 'x', spec: {} },
    messages: [{ role: 'user', text: '生成' }],
    settings: mockSettings
  });
  check('状态 200', r.status === 200, 'got ' + r.status);
  p = upstreamPrompt();
  check('不含 stderr 段', !p.includes('上一轮执行失败信息'), '');
  check('不含【上轮反馈线索】', !p.includes('【上轮反馈线索】'), '');
  check('不含「避免上述问题」', !p.includes('本次生成的代码必须避免上述问题'), '');
  check('doc 模式有打回线索时也注入', (() => {
    const docPrompt = serverModule.buildComposePrompt({
      mode: 'doc',
      module: { name: 'x', spec: {} },
      messages: [{ role: 'system', text: '文档打回：DOC_MARK_7e1a 验收标准缺失' }]
    });
    return docPrompt.includes('DOC_MARK_7e1a');
  })(), '');

  console.log('\n[18] isPrivateHost 纯函数');
  const privTrue = ['localhost', 'sub.localhost', 'myhost.local', '127.0.0.1', '10.0.0.1', '192.168.1.1',
    '172.16.5.4', '172.31.255.255', '::1', '[::1]', '0.0.0.0', '::ffff:127.0.0.1', '999.1.1.1', ''];
  const privFalse = ['github.com', '8.8.8.8', 'example.org', '172.32.0.1'];
  check('私网 / 本机地址 → true', privTrue.every((h) => serverModule.isPrivateHost(h) === true),
    privTrue.filter((h) => serverModule.isPrivateHost(h) !== true).join(','));
  check('公网地址 → false', privFalse.every((h) => serverModule.isPrivateHost(h) === false),
    privFalse.filter((h) => serverModule.isPrivateHost(h) !== false).join(','));

  console.log('\n[19] diagnose 模式');
  mockReply = '{"level":"code","reason":"脚本未处理空值行导致 TypeError"}';
  r = await req('POST', '/api/ai/compose', {
    mode: 'diagnose',
    module: { name: '数据清洗', spec: { goal: '标准化' } },
    doc: '## 环节目标\n清洗数据',
    code: 'const x=input.rows[0].a;',
    exec: { ok: false, stderr: 'TypeError: Cannot read properties of undefined', artifacts: [{ name: 'aligned.csv' }] },
    issue: '运行报错',
    settings: mockSettings
  });
  check('状态 200', r.status === 200, 'got ' + r.status + ' body=' + r.raw);
  check('返回 level=code', !!(r.json && r.json.level === 'code'), r.raw);
  check('返回 reason', !!(r.json && r.json.reason === '脚本未处理空值行导致 TypeError'), r.raw);
  p = upstreamPrompt();
  check('diagnose 提示词含上次执行结果/问题描述', p.includes('【上次执行结果】') && p.includes('【问题描述】'), '');
  check('diagnose 提示词要求只输出 JSON', p.includes('只输出一个 JSON'), '');
  mockReply = '这不是 JSON 输出';
  r = await req('POST', '/api/ai/compose', { mode: 'diagnose', issue: 'x', settings: mockSettings });
  check('非 JSON → {text} 原样', !!(r.json && r.json.text === '这不是 JSON 输出' && r.json.level === undefined), r.raw);
  mockReply = '{"level":"oops","reason":"x"}';
  r = await req('POST', '/api/ai/compose', { mode: 'diagnose', issue: 'x', settings: mockSettings });
  check('非法 level → {text}', !!(r.json && r.json.text && r.json.level === undefined), r.raw);
  // 纯函数直验：围栏容忍 + 模式非法
  const parsedOk = serverModule.parseDiagnoseJson('```json\n{"level":"align","reason":"口径冲突"}\n```');
  check('纯函数：容忍围栏', !!(parsedOk.level === 'align' && parsedOk.reason === '口径冲突'), JSON.stringify(parsedOk));
  const parsedBad = serverModule.parseDiagnoseJson('plain text');
  check('纯函数：非 JSON → text', !!(parsedBad.text === 'plain text' && parsedBad.level === undefined), JSON.stringify(parsedBad));

  console.log('\n[20] exec urls：私网默认拒绝（SSRF）+ 非法协议 + 结构校验');
  r = await req('POST', '/api/code/exec', {
    lang: 'node', code: "console.log('u')", confirm: true,
    urls: [
      { url: 'http://localhost:9/secret.txt' },
      { name: '内网', url: 'http://10.1.2.3/data.csv' },
      { url: 'ftp://example.com/a.txt' }
    ]
  });
  check('状态 200（单条失败不影响执行）', r.status === 200, 'got ' + r.status + ' body=' + r.raw);
  const dl20 = (r.json && r.json.downloaded) || [];
  check('downloaded 共 3 条', dl20.length === 3, JSON.stringify(dl20));
  check('localhost 条目失败且注 SSRF', !!(dl20[0] && dl20[0].ok === false && String(dl20[0].error).includes('SSRF') && dl20[0].name === 'secret.txt'), JSON.stringify(dl20[0]));
  check('10.x 条目失败且 name 用传入值', !!(dl20[1] && dl20[1].ok === false && dl20[1].name === '内网'), JSON.stringify(dl20[1]));
  check('ftp 条目失败且注协议', !!(dl20[2] && dl20[2].ok === false && String(dl20[2].error).includes('http/https')), JSON.stringify(dl20[2]));
  r = await req('POST', '/api/code/exec', { lang: 'node', code: 'console.log(1)', confirm: true, urls: 'nope' });
  check('urls 非数组 → 400', r.status === 400, 'got ' + r.status);

  console.log('\n[21] exec urls：YANXU_ALLOW_PRIVATE_HOST=1 放行 + 真实下载 + 超限');
  let server2 = null;
  try {
    server2 = await startServerOn(PORT_PRIVATE_OK, { YANXU_ALLOW_PRIVATE_HOST: '1' });
    // 下载源用 server 自身静态白名单内的 /package.json（.md 不在 STATIC_EXT，会被 403）。
    const srcContent = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    r = await reqTo(PORT_PRIVATE_OK, 'POST', '/api/code/exec', {
      lang: 'node',
      code: "const fs=require('node:fs');const t=fs.readFileSync('package.json','utf8');fs.writeFileSync('copy.txt',t.slice(0,10));console.log('got='+t.length)",
      confirm: true,
      files: [{ name: 'input.json', content: '{"a":1}' }],
      urls: [
        { url: 'http://127.0.0.1:' + PORT_PRIVATE_OK + '/package.json' },
        { url: 'http://127.0.0.1:' + PORT_PRIVATE_OK + '/no-such-file.txt' },
        { url: 'http://' + HOST + ':' + MOCK_PORT + '/big.txt' }
      ]
    });
    check('状态 200', r.status === 200, 'got ' + r.status + ' body=' + r.raw.slice(0, 300));
    const dl21 = (r.json && r.json.downloaded) || [];
    check('downloaded 共 3 条', dl21.length === 3, JSON.stringify(dl21));
    check('package.json 下载成功且 size 一致',
      !!(dl21[0] && dl21[0].ok === true && dl21[0].name === 'package.json' && dl21[0].size === Buffer.byteLength(srcContent)),
      JSON.stringify(dl21[0]));
    check('404 条目失败但其余继续', !!(dl21[1] && dl21[1].ok === false && dl21[1].name === 'no-such-file.txt' && String(dl21[1].error).includes('404')), JSON.stringify(dl21[1]));
    check('600KB 条目超 512KB 上限失败', !!(dl21[2] && dl21[2].ok === false && String(dl21[2].error).includes('512KB')), JSON.stringify(dl21[2]));
    let dlContent = '';
    try { dlContent = fs.readFileSync(path.join(r.json.dir, 'package.json'), 'utf8'); } catch (error) { dlContent = ''; }
    check('下载文件真实写入执行目录且内容一致', dlContent === srcContent, 'len=' + dlContent.length);
    const srcArt = (r.json.artifacts || []).find((a) => a.name === 'package.json');
    check('artifacts 含 package.json 且带 preview', !!(srcArt && typeof srcArt.preview === 'string' && srcArt.preview.length > 0), JSON.stringify(srcArt || {}));
    check('脚本读到下载文件（stdout 标记）', !!(r.json && typeof r.json.stdout === 'string' && /got=\d+/.test(r.json.stdout)), r.json && r.json.stdout);
  } finally {
    if (server2) { try { server2.kill('SIGKILL'); } catch (error) { /* 已退出 */ } }
  }

  console.log('\n[22] artifacts preview：out.csv / 50 行截断 / 二进制无 preview');
  r = await req('POST', '/api/code/exec', {
    lang: 'node',
    code: [
      "const fs=require('node:fs');",
      "fs.writeFileSync('out.csv','h1,h2\\na,1\\nb,2\\nc,3\\n');",
      "fs.writeFileSync('many.csv', Array.from({length:60},(_,i)=>'row'+i).join('\\n'));",
      "fs.writeFileSync('data.bin','bin');"
    ].join(''),
    confirm: true
  });
  check('状态 200', r.status === 200, 'got ' + r.status);
  const arts22 = (r.json && r.json.artifacts) || [];
  const csvArt = arts22.find((a) => a.name === 'out.csv');
  check('out.csv 带 preview 且内容正确', !!(csvArt && csvArt.preview === 'h1,h2\na,1\nb,2\nc,3\n'), JSON.stringify(csvArt));
  const manyArt = arts22.find((a) => a.name === 'many.csv');
  check('60 行文件 preview 截到 50 行', !!(manyArt && manyArt.preview && manyArt.preview.split('\n').length === 50 && !manyArt.preview.includes('row59')), '');
  const binArt = arts22.find((a) => a.name === 'data.bin');
  check('.bin 不带 preview', !!(binArt && binArt.preview === undefined), JSON.stringify(binArt));

  if (mockUpstream) { try { mockUpstream.close(); } catch (error) { /* 忽略 */ } }
}

run().then(() => {
  console.log('\n==== 结果：' + passed + ' 通过 / ' + failed + ' 失败 ====');
  if (server) { try { server.kill('SIGKILL'); } catch (error) { /* 已退出 */ } }
  if (failed > 0) {
    console.error('EXEC_TESTS_FAILED');
    process.exit(1);
  }
  console.log('ALL_EXEC_TESTS_PASS');
  process.exit(0);
}).catch((error) => {
  console.error('测试运行失败：', (error && error.stack) || error);
  if (server) { try { server.kill('SIGKILL'); } catch (ignored) { /* 已退出 */ } }
  process.exit(1);
});
