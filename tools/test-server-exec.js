/**
 * 【T3 · 2026-10-14】执行内核端到端测试（node 直跑，零依赖）。
 * 【W2 · 2026-10-14】扩展：数据文件上传 / 文件名穿越 / 大小限制 / compose template / chat 环节上下文。
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
 * 全通过输出 ALL_EXEC_TESTS_PASS。
 *
 * 注意：为避免读取项目 .env 里真实 AI_API_KEY，子进程显式传 AI_API_KEY=''（Windows 下
 * 空环境变量仍是「已定义」→ loadEnvFile 跳过 → 解析结果为无 Key），从而稳定复现 503。
 * 临时执行目录统一落在系统临时目录（YANXU_RUN_DIR=$TMP/yanxu-test-runs），不污染用户目录。
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
const RUN_BASE = path.join(os.tmpdir(), 'yanxu-test-runs'); // 隔离：执行目录不进用户主目录

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

function req(method, pathUrl, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const opts = {
      host: HOST,
      port: PORT,
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

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(PORT), HOST: HOST, AI_API_KEY: '', YANXU_RUN_DIR: RUN_BASE }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', (chunk) => console.log('[server] ' + chunk.toString().trim()));
    server.stderr.on('data', (chunk) => console.error('[server-err] ' + chunk.toString().trim()));
    server.on('error', reject);

    const deadline = Date.now() + 8000;
    (function poll() {
      const probe = http.request({ host: HOST, port: PORT, method: 'GET', path: '/' }, (res) => {
        res.resume();
        resolve();
      });
      probe.on('error', () => {
        if (Date.now() > deadline) reject(new Error('服务器启动超时（8s）'));
        else setTimeout(poll, 150);
      });
      probe.end();
    })();
  });
}

async function run() {
  await startServer();
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
