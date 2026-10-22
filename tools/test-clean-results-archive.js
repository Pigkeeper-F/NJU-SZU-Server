'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Writable } = require('node:stream');
const { streamCleanResultsArchive, MAX_BYTES } = require('./clean-results-archive');

class Response extends Writable {
  constructor(fail = false) { super(); this.parts = []; this.headersSent = false; this.fail = fail; }
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  _write(chunk, _encoding, done) { if (this.fail) done(new Error('fixture connection closed')); else { this.parts.push(Buffer.from(chunk)); done(); } }
}

function sha(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

async function main() {
  const base = path.resolve(__dirname, '../.workbench/test-fixtures');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'clean-results-archive-'));
  const sessionId = randomUUID(), runId = randomUUID(), otherRunId = randomUUID();
  const root = path.join(dir, '.workbench'), session = path.join(root, sessionId), run = path.join(session, 'output', runId), tempRoot = path.join(dir, 'temp');
  for (const folder of [run, path.join(session, 'input'), path.join(session, 'reference'), path.join(session, 'material'), path.join(session, 'output', otherRunId), tempRoot]) fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.join(run, '中文目录'));
  fs.writeFileSync(path.join(run, '贸易结果.csv'), '\ufeff出口国,进口国,数量\nA,B,80\n');
  fs.writeFileSync(path.join(run, '中文目录', '绘图代码.py'), 'print("测试")\n');
  fs.writeFileSync(path.join(run, 'empty.csv'), '');
  fs.writeFileSync(path.join(run, 'run-state.json'), '{"internal":"not-a-result"}');
  fs.writeFileSync(path.join(session, 'input', 'source.csv'), 'original unchanged');
  fs.writeFileSync(path.join(session, 'reference', 'reference.md'), 'not a result');
  fs.writeFileSync(path.join(session, 'material', 'paper.txt'), 'not a result');
  fs.writeFileSync(path.join(session, 'output', otherRunId, 'other.csv'), 'other run');
  let active = false;
  const bridge = { root, active: () => active, session: id => { assert.equal(id, sessionId); return session; } };
  const originals = [path.join(run, '贸易结果.csv'), path.join(run, '中文目录', '绘图代码.py'), path.join(session, 'input', 'source.csv')].map(filename => ({ filename, hash: sha(filename) }));
  const options = { tempRoot };
  async function rejected(pattern, mutateOptions = options, id = runId, customBridge = bridge) {
    const res = new Response();
    await assert.rejects(streamCleanResultsArchive(customBridge, sessionId, id, res, mutateOptions), pattern);
    assert.equal(res.headersSent, false, 'validation failures must precede HTTP download headers');
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'temporary archive must be cleaned on failure');
  }
  try {
    const res = new Response();
    await streamCleanResultsArchive(bridge, sessionId, runId, res, options);
    assert.equal(res.status, 200); assert.equal(res.headers['Content-Type'], 'application/zip');
    assert.match(res.headers['Content-Disposition'], /filename\*=UTF-8''%E6%B8%85%E6%B4%97/);
    const packed = Buffer.concat(res.parts);
    assert.equal(Number(res.headers['Content-Length']), packed.length);
    const zip = path.join(dir, 'verified.zip'); fs.writeFileSync(zip, packed);
    const python = path.resolve(__dirname, '../.venv/Scripts/python.exe');
    const inspect = 'import zipfile,json,sys,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}))';
    const entries = JSON.parse(execFileSync(python, ['-c', inspect, zip], { encoding: 'utf8', windowsHide: true }));
    assert.deepEqual(Object.keys(entries).sort(), ['empty.csv', '中文目录/绘图代码.py', '贸易结果.csv'].sort());
    assert.equal(entries['贸易结果.csv'], originals[0].hash);
    assert.equal(entries['中文目录/绘图代码.py'], originals[1].hash);
    for (const original of originals) assert.equal(sha(original.filename), original.hash, 'packaging must never modify source files');
    assert.deepEqual(fs.readdirSync(tempRoot), []);

    active = true; await rejected(/正在执行/); active = false;
    let activeChecks = 0;
    await rejected(/开始执行/, options, runId, { ...bridge, active: () => ++activeChecks >= 3 });
    await rejected(/无效/, options, '../' + otherRunId);
    await rejected(/不存在/, options, randomUUID());
    await rejected(/超出/, options, runId, { ...bridge, session: () => path.join(dir, 'outside') });
    await rejected(/300/, { ...options, maxFiles: 2 });
    const total = originals.slice(0, 2).reduce((sum, item) => sum + fs.statSync(item.filename).size, 0);
    await rejected(/上限/, { ...options, maxBytes: total - 1 });
    await rejected(/压缩包超过/, { ...options, maxBytes: total + 1 });

    for (const name of ['.env', 'credentials.json']) {
      const secret = path.join(run, name); fs.writeFileSync(secret, 'must never be included');
      await rejected(/隐藏文件或凭据/); fs.unlinkSync(secret);
    }
    const nestedInput = path.join(run, 'input'); fs.mkdirSync(nestedInput); fs.writeFileSync(path.join(nestedInput, 'raw.csv'), 'do not package');
    await rejected(/输入或参考/); fs.unlinkSync(path.join(nestedInput, 'raw.csv')); fs.rmdirSync(nestedInput);

    const link = path.join(run, 'linked-results');
    fs.symlinkSync(path.join(session, 'output', otherRunId), link, 'junction');
    await rejected(/符号链接/); fs.unlinkSync(link);
    const hardlink = path.join(run, 'linked-source.csv'); fs.linkSync(path.join(session, 'input', 'source.csv'), hardlink);
    await rejected(/硬链接/); fs.unlinkSync(hardlink);

    const large = path.join(run, 'too-large.csv'), fd = fs.openSync(large, 'w');
    try { fs.ftruncateSync(fd, MAX_BYTES + 1); } finally { fs.closeSync(fd); }
    await rejected(/2GiB/); fs.unlinkSync(large);

    const brokenResponse = new Response(true);
    await streamCleanResultsArchive(bridge, sessionId, runId, brokenResponse, options);
    assert.equal(brokenResponse.destroyed, true); assert.deepEqual(fs.readdirSync(tempRoot), []);
    for (const original of originals) assert.equal(sha(original.filename), original.hash);
    console.log('CLEAN_RESULTS_ARCHIVE_TESTS_PASS (real ZIP bytes, Unicode, provenance preserved, session/run isolation, busy/size/path/link/credentials guards, temporary cleanup)');
  } finally {
    if (path.dirname(dir) !== base || !path.basename(dir).startsWith('clean-results-archive-')) throw new Error('Unexpected fixture directory');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
