'use strict';

// Regression coverage for download -> cleaning handoff. Everything below uses
// synthetic in-memory files and HTTP replies; no local research data is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { CodexBridge } = require('./codex-bridge');

const clientSource = fs.readFileSync(path.join(__dirname, '../js/codex.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(__dirname, '../js/store.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const SOURCE = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const CSV_NAME = '12345678-FAOSTAT_TM_2024.csv';
const CSV = Buffer.from('Year,Item,Value\n2024,Wheat,80\n');
const SHA256 = createHash('sha256').update(CSV).digest('hex');

function functionSource(name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(clientSource);
  assert.ok(match, 'Missing client function: ' + name);
  const end = clientSource.indexOf('\n  }', match.index);
  assert.ok(end > match.index, 'Missing closing brace: ' + name);
  return clientSource.slice(match.index, end + 4);
}

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => plain(data) };
}

function fixture(options = {}) {
  const storage = new Map();
  const browser = {
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    }
  };
  vm.runInNewContext(storeSource, { window: browser });
  const Store = browser.Store;
  const download = Store.addModule('下载数据');
  const clean = Store.addModule('数据清洗');
  const plan = '测试方案：2024 年小麦贸易矩阵，保留进口量和出口量。';
  Store.saveDoc(download.id, plan);
  Store.approveDoc(download.id);
  Store.appendMessage(download.id, '下载前已经确认的范围，必须保留。', 'user');
  Store.appendMessage(clean.id, '旧清洗讨论：比例分母尚待确认，不允许执行。', 'user');
  Store.appendMessage(clean.id, '旧清洗助手消息，恢复会话不能删掉。', 'assistant');
  Store.saveDoc(clean.id, '旧清洗规则：保留原始文件，尚未确认比例口径。');
  Store.approveDoc(clean.id);
  Store.markRun(download.id, { dir: '.workbench/' + SOURCE + '/input', artifacts: [{ name: CSV_NAME, size: CSV.length }] });
  Store.selectModule(download.id);

  const original = plain(Store.getState());
  const run = {
    sourceType: 'doc', label: '已审核下载方案', text: plan,
    sources: [{ url: 'https://fixture.invalid/data.csv' }],
    files: [{ name: 'FAOSTAT_TM_2024.csv', storedName: CSV_NAME, size: CSV.length,
      sha256: SHA256, finalUrl: 'https://fixture.invalid/data.csv' }],
    failures: [], confirmed: false
  };
  const saved = {
    [download.id]: { sessionId: SOURCE, download: run },
    [clean.id]: options.noTarget ? {} : {
      sessionId: TARGET,
      inputBatch: { names: ['old-clean.csv'], label: '历史输入批次', text: '历史输入规则' }
    }
  };
  const sessions = new Map([
    [SOURCE, [{ group: 'input', name: CSV_NAME, size: CSV.length, bytes: Buffer.from(CSV) }]],
    [TARGET, [
      { group: 'input', name: 'old-clean.csv', size: 8, bytes: Buffer.from('old-data') },
      { group: 'output', name: 'old-report.txt', size: 10, bytes: Buffer.from('old-report') }
    ]]
  ]);
  if (options.missingTarget) sessions.delete(TARGET);
  if (options.missingSource) sessions.delete(SOURCE);
  if (options.missingSourceFile) sessions.set(SOURCE, []);
  const calls = [];
  const tasks = new Map();
  let created = 0;
  let imports = 0;
  let persisted = 0;
  const missing = id => response(400, { error: '任务不存在，请重新创建', code: 'SESSION_NOT_FOUND', sessionId: id });
  const fileList = id => sessions.get(id).map(({ bytes, ...file }) => file);
  const fetch = async (raw, settings = {}) => {
    const url = new URL(raw, 'http://fixture.invalid');
    const body = settings.body ? JSON.parse(settings.body) : null;
    calls.push({ path: url.pathname, session: url.searchParams.get('session'), method: settings.method || 'GET', body });
    if (options.fetchHook) await options.fetchHook({ url, settings, body });
    if (url.pathname === '/api/codex/files') {
      const id = url.searchParams.get('session');
      if (id === TARGET && options.targetNetworkError) throw new TypeError('Failed to fetch');
      if (id === TARGET && options.incompleteTarget) return response(400, { error: '任务目录不完整', code: 'SESSION_INCOMPLETE', sessionId: id });
      if (id === TARGET && options.targetWrongSessionError) return missing(SOURCE);
      if (id === TARGET && options.targetServerError) return response(500, { error: '临时服务异常' });
      if (!sessions.has(id)) return missing(id);
      return response(200, { files: fileList(id) });
    }
    if (url.pathname === '/api/codex/session' && settings.method === 'POST') {
      const id = '33333333-3333-4333-8333-' + String(++created).padStart(12, '0');
      sessions.set(id, []);
      return response(201, { id, files: [] });
    }
    if (url.pathname === '/api/codex/import-input' && settings.method === 'POST') {
      if (!sessions.has(body.sessionId)) return missing(body.sessionId);
      if (!sessions.has(body.sourceSessionId)) return missing(body.sourceSessionId);
      if (options.importFailuresRemaining > 0) {
        options.importFailuresRemaining--;
        return response(500, { error: '模拟首次交接失败，请重试' });
      }
      assert.equal(body.confirm, true, 'A handoff requires an explicit confirmed request');
      assert.equal(body.sourceSessionId, SOURCE, 'Never replace the successful download session');
      assert.deepEqual(body.names, [CSV_NAME], 'Only selected CSV is handed off, not the full archive');
      imports++;
      const names = [];
      for (const name of body.names) {
        const file = sessions.get(SOURCE).find(item => item.group === (body.sourceGroup || 'input') && item.name === name);
        assert.ok(file, 'Source file must still exist');
        const storedName = 'import-' + imports + '-' + name;
        sessions.get(body.sessionId).push({ ...file, name: storedName, bytes: Buffer.from(file.bytes) });
        names.push(storedName);
      }
      return response(201, { names, files: fileList(body.sessionId) });
    }
    throw new Error('Unexpected request: ' + (settings.method || 'GET') + ' ' + raw);
  };
  const ModuleSpace = { render() {}, isBusy: () => false };
  browser.ModuleSpace = ModuleSpace;
  const context = vm.createContext({
    URL, Error, TypeError, console, root: browser, Store, saved, ModuleSpace, fetch,
    render() {},
    persist() { persisted++; },
    task(id) {
      if (!tasks.has(id)) tasks.set(id, { busy: false, files: [], error: '', sourceJob: null });
      return tasks.get(id);
    },
    basisForDownload(mod) { return mod.doc?.status === 'approved' ? { text: mod.doc.content, label: run.label, sourceType: 'doc' } : null; }
  });
  vm.runInContext(['request', 'session', 'handoffDownload'].map(functionSource).join('\n') + '\nthis.subject = { request, session, handoffDownload };', context);
  return {
    Store, original, download, clean, saved, run, sessions, calls, context,
    handoff: () => context.subject.handoffDownload(Store.getState().modules.find(item => item.id === download.id)),
    task: id => { if (!tasks.has(id)) tasks.set(id, { busy: false, files: [], error: '' }); return tasks.get(id); },
    count: () => ({ created, imports, persisted })
  };
}

function assertOriginalRecords(f) {
  for (const module of f.original.modules) {
    const current = f.Store.getState().modules.find(item => item.id === module.id);
    assert.deepEqual(plain(current.doc), module.doc, 'Recovery must retain the existing approved plan');
    assert.deepEqual(plain(current.messages.slice(0, module.messages.length)), module.messages, 'Recovery must retain previous conversation records');
  }
  assert.equal(f.saved[f.download.id].sessionId, SOURCE, 'The completed download source must stay bound');
  const source = f.sessions.get(SOURCE);
  if (source?.length) assert.equal(createHash('sha256').update(source[0].bytes).digest('hex'), SHA256, 'Source bytes must remain unchanged');
  assert.equal(f.calls.some(call => /\/run$|\/source\/start$|\/fetch-source$/.test(call.path)), false, 'Handoff must not start cleaning or repeat the download');
}

function assertDelivered(f) {
  const target = f.saved[f.clean.id].sessionId;
  const batch = f.saved[f.clean.id].inputBatch;
  assert.ok(batch && batch.names.length === 1);
  const received = f.sessions.get(target).find(file => file.group === 'input' && file.name === batch.names[0]);
  assert.ok(received, 'The active cleaning input batch must point to a real copied file');
  assert.deepEqual(received.bytes, CSV);
  assert.equal(f.run.confirmed, true);
  assert.equal(f.Store.getState().activeModuleId, f.clean.id);
  assertOriginalRecords(f);
}

async function main() {
  // request() must retain structured missing-session data, not just its message.
  {
    const f = fixture({ missingTarget: true });
    await assert.rejects(f.context.subject.request('/api/codex/files?session=' + TARGET), error =>
      error.status === 400 && error.code === 'SESSION_NOT_FOUND' && error.sessionId === TARGET);
  }
  {
    const f = fixture();
    await f.handoff();
    assertDelivered(f);
    assert.equal(f.count().created, 0);
    assert.equal(f.count().imports, 1);
    assert.ok(f.sessions.get(TARGET).some(file => file.name === 'old-clean.csv'));
    assert.ok(f.sessions.get(TARGET).some(file => file.name === 'old-report.txt'));
    const targetCheck = f.calls.findIndex(call => call.path === '/api/codex/files' && call.session === TARGET);
    const importIndex = f.calls.findIndex(call => call.path === '/api/codex/import-input');
    assert.ok(targetCheck >= 0 && targetCheck < importIndex, 'Validate the target before the file import');
    // Confirmed delivery still validates its destination; repeated clicks only navigate.
    f.Store.selectModule(f.download.id);
    await f.handoff();
    assertDelivered(f);
    assert.equal(f.count().imports, 1, 'Repeated confirmed handoff must not copy files again');
  }
  {
    const f = fixture({ missingTarget: true });
    await f.handoff();
    assertDelivered(f);
    assert.equal(f.count().created, 1);
    assert.equal(f.count().imports, 1);
    assert.notEqual(f.saved[f.clean.id].sessionId, TARGET);
    const sourceCheck = f.calls.findIndex(call => call.path === '/api/codex/files' && call.session === SOURCE);
    const createIndex = f.calls.findIndex(call => call.path === '/api/codex/session');
    assert.ok(sourceCheck >= 0 && sourceCheck < createIndex, 'Confirm source files before replacing the missing target');
    const appended = f.Store.getState().modules.find(item => item.id === f.clean.id).messages.slice(2);
    assert.ok(appended.some(message => message.role === 'system' && /恢复|重新建立|重建|失效/.test(message.text)), 'Session recovery needs a visible system record');
  }
  {
    const f = fixture({ missingTarget: true, missingSource: true });
    await f.handoff();
    assert.equal(f.count().created, 0, 'Missing source cannot be replaced by an empty new session');
    assert.equal(f.count().imports, 0);
    assert.equal(f.saved[f.clean.id].sessionId, TARGET);
    assert.equal(f.run.confirmed, false);
    assert.ok(f.task(f.download.id).error, 'Missing source must be reported');
    assertOriginalRecords(f);
  }
  {
    const f = fixture({ missingTarget: true, missingSourceFile: true });
    await f.handoff();
    assert.equal(f.count().created, 0, 'A surviving source session without its CSV must not create a replacement target');
    assert.equal(f.count().imports, 0);
    assert.equal(f.saved[f.clean.id].sessionId, TARGET);
    assert.equal(f.run.confirmed, false);
    assert.ok(f.task(f.download.id).error);
    assertOriginalRecords(f);
  }
  for (const option of ['targetNetworkError', 'incompleteTarget', 'targetWrongSessionError', 'targetServerError']) {
    const f = fixture({ [option]: true });
    await f.handoff();
    assert.equal(f.count().created, 0, option + ' must not silently replace a session');
    assert.equal(f.count().imports, 0);
    assert.equal(f.saved[f.clean.id].sessionId, TARGET);
    assert.equal(f.run.confirmed, false);
    assert.ok(f.task(f.download.id).error);
    assertOriginalRecords(f);
  }
  {
    const f = fixture();
    await f.handoff();
    assertDelivered(f);
    // A confirmed flag is insufficient when its old target directory has vanished.
    f.sessions.delete(f.saved[f.clean.id].sessionId);
    f.Store.selectModule(f.download.id);
    await f.handoff();
    assertDelivered(f);
    assert.equal(f.count().created, 1);
    assert.equal(f.count().imports, 2, 'Lost confirmed target must receive the CSV again');
  }
  {
    const faults = {};
    const f = fixture(faults);
    await f.handoff();
    assertDelivered(f);
    f.sessions.delete(f.saved[f.clean.id].sessionId);
    f.Store.selectModule(f.download.id);
    faults.importFailuresRemaining = 1;
    await f.handoff();
    const recoveredTarget = f.saved[f.clean.id].sessionId;
    assert.notEqual(recoveredTarget, TARGET);
    assert.equal(f.run.confirmed, false, 'Replacing a lost confirmed destination must clear its old delivery confirmation');
    assert.equal(f.Store.getState().activeModuleId, f.download.id);
    assert.equal(f.count().created, 1);
    assert.equal(f.count().imports, 1);
    assert.ok(f.task(f.download.id).error);
    await f.handoff();
    assertDelivered(f);
    assert.equal(f.saved[f.clean.id].sessionId, recoveredTarget, 'Retry must keep the recovered receiving session');
    assert.equal(f.count().created, 1);
    assert.equal(f.count().imports, 2, 'A failed first reimport must remain retryable');
  }
  {
    const f = fixture();
    await f.handoff();
    assertDelivered(f);
    const batchName = f.saved[f.clean.id].inputBatch.names[0];
    f.sessions.set(TARGET, f.sessions.get(TARGET).filter(file => file.name !== batchName));
    f.Store.selectModule(f.download.id);
    await f.handoff();
    assert.equal(f.Store.getState().activeModuleId, f.download.id, 'Confirmed flag cannot navigate to a missing input batch');
    assert.equal(f.count().created, 0);
    assert.equal(f.count().imports, 1);
    assert.ok(f.task(f.download.id).error);
    assertOriginalRecords(f);
  }
  {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let targetRequested = false;
    const f = fixture({ fetchHook: async ({ url }) => {
      if (url.pathname === '/api/codex/files' && url.searchParams.get('session') === TARGET && !targetRequested) {
        targetRequested = true;
        await gate;
      }
    } });
    const first = f.handoff();
    for (let turns = 0; turns < 10 && !targetRequested; turns++) await Promise.resolve();
    assert.equal(targetRequested, true);
    const second = f.handoff();
    release();
    await Promise.all([first, second]);
    assertDelivered(f);
    assert.equal(f.count().imports, 1, 'Concurrent clicks must not duplicate copies or approval');
  }
  {
    const f = fixture({ noTarget: true });
    await f.handoff();
    assertDelivered(f);
    assert.equal(f.count().created, 1, 'A new cleaning module can establish its first session');
  }
  // Exercise the real bridge without a model connection or any live session.
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-handoff-test-'));
  try {
    const bridge = new CodexBridge(temporaryRoot);
    assert.throws(() => bridge.session(TARGET), error => error.code === 'SESSION_NOT_FOUND' && error.sessionId === TARGET);
    assert.equal(fs.existsSync(path.join(bridge.root, TARGET)), false, 'Missing lookup must not create directories');
    const incomplete = path.join(bridge.root, TARGET);
    fs.mkdirSync(path.join(incomplete, 'output'), { recursive: true });
    const priorReport = path.join(incomplete, 'output', 'keep.txt');
    fs.writeFileSync(priorReport, 'previous output');
    assert.throws(() => bridge.session(TARGET), error => error.code === 'SESSION_INCOMPLETE' && error.sessionId === TARGET);
    assert.equal(fs.readFileSync(priorReport, 'utf8'), 'previous output');
    assert.equal(fs.existsSync(path.join(incomplete, 'input')), false, 'An incomplete session must not be silently repaired');

    const sourceSession = bridge.createSession().id;
    const targetSession = bridge.createSession().id;
    const sourceFile = path.join(bridge.session(sourceSession), 'input', CSV_NAME);
    const oldTarget = path.join(bridge.session(targetSession), 'input', 'old-clean.csv');
    fs.writeFileSync(sourceFile, CSV);
    fs.writeFileSync(oldTarget, 'keep historical input');
    const sourceBefore = createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
    const imported = bridge.importInput(targetSession, sourceSession, [CSV_NAME]);
    assert.equal(imported.names.length, 1);
    assert.deepEqual(fs.readFileSync(bridge.download(targetSession, 'input', imported.names[0])), CSV);
    assert.equal(createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex'), sourceBefore);
    assert.equal(fs.readFileSync(oldTarget, 'utf8'), 'keep historical input');
    assert.throws(() => bridge.importInput(TARGET, sourceSession, [CSV_NAME]), error => error.code === 'SESSION_INCOMPLETE');
    assert.equal(fs.readFileSync(priorReport, 'utf8'), 'previous output');
    bridge.sourceBusy.add(sourceSession);
    assert.throws(() => bridge.importInput(targetSession, sourceSession, [CSV_NAME]), /正在进行/);
    bridge.sourceBusy.delete(sourceSession);
    assert.throws(() => bridge.importInput(targetSession, sourceSession, ['../output/keep.txt']), /不可访问|不存在|ENOENT/);
  } finally {
    const absoluteRoot = path.resolve(temporaryRoot);
    if (path.dirname(absoluteRoot) !== path.resolve(os.tmpdir()) || !path.basename(absoluteRoot).startsWith('yanxu-handoff-test-')) throw new Error('Unexpected test cleanup target');
    fs.rmSync(absoluteRoot, { recursive: true, force: true });
  }
  console.log('DOWNLOAD_HANDOFF_TESTS_PASS (VM and real bridge: missing target recovery, source safety, preserved records, confirmed validation, duplicate clicks)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
