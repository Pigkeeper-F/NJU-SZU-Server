'use strict';

// Actual Python process identity and cancellation. All files/processes are
// isolated fixtures; this never launches a browser or reads a real task.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LiteratureConnector } = require('./literature-connector');

const repository = path.resolve(__dirname, '..');
const python = path.join(repository, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const script = `import importlib.util,json,os,pathlib,sys,time
args=sys.argv[1:]
job=pathlib.Path(args[args.index('--output-dir')+1])
(job/'actual-process.json').write_text(json.dumps(dict(pid=os.getpid(),prefix=sys.prefix,executable=sys.executable,
    utf8=os.environ.get('PYTHONUTF8'),encoding=os.environ.get('PYTHONIOENCODING'),
    playwright=importlib.util.find_spec('playwright').origin)),encoding='utf-8')
print(json.dumps(dict(type='stage',stage='fixture-ready',message='isolated process ready')),flush=True)
time.sleep(2)
(job/'late-write.txt').write_text('must not exist after cancellation',encoding='utf-8')
time.sleep(20)
`;

async function main() {
  assert.ok(fs.existsSync(python), 'requires existing repo .venv; never installs dependencies');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-stage-cancel-'));
  let connector;
  try {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools', 'literature_search.py'), script);
    connector = new LiteratureConnector(root, { prepare: async () => python });
    const started = connector.start({ topic: 'isolated cancel', query: 'fixture', sources: ['pubmed'], limit: 10 });
    const live = connector.jobs.get(started.id), processFile = path.join(live.dir, 'actual-process.json');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(processFile) && Date.now() < deadline) await sleep(20);
    assert.ok(fs.existsSync(processFile), 'actual script must start within the bounded probe interval');
    const identity = JSON.parse(fs.readFileSync(processFile, 'utf8'));
    const child = live.child;
    assert.ok(child && Number.isSafeInteger(child.pid));
    assert.equal(child.pid, identity.pid, 'job.child PID must identify the actual Python script, not a Windows venv redirector');
    assert.equal(path.resolve(identity.prefix).toLowerCase(), path.resolve(repository, '.venv').toLowerCase());
    assert.equal(path.resolve(identity.executable).toLowerCase(), path.resolve(python).toLowerCase());
    assert.equal(identity.utf8, '1');
    assert.equal(identity.encoding, 'utf-8');
    assert.ok(identity.playwright.toLowerCase().startsWith(path.resolve(repository, '.venv').toLowerCase()), 'base interpreter must retain original venv libraries');
    const closed = new Promise(resolve => child.once('close', resolve));
    assert.equal(connector.cancel(started.id).status, 'cancelled');
    await Promise.race([closed, sleep(3000).then(() => { throw new Error('actual Python script did not close after cancellation'); })]);
    await sleep(2200);
    assert.equal(fs.existsSync(path.join(live.dir, 'late-write.txt')), false, 'cancelled actual driver must not perform a late write');
    assert.equal(connector.snapshot(started.id).status, 'cancelled');

    // Stop at the async process-spec boundary: no stage may appear afterward.
    const stopped = new LiteratureConnector(root, { prepare: async () => python });
    const originalRunStage = stopped.runStage.bind(stopped);
    stopped.runStage = (...args) => {
      const pending = originalRunStage(...args);
      stopped.cancel(args[2].id);
      return pending;
    };
    const cancelledBeforeSpawn = stopped.start({ topic: 'cancel before stage', query: 'fixture', sources: ['pubmed'], limit: 10 });
    await sleep(100);
    const cancelledJob = stopped.jobs.get(cancelledBeforeSpawn.id);
    assert.equal(cancelledJob.status, 'cancelled');
    assert.equal(cancelledJob.child, null);
    assert.equal(fs.existsSync(path.join(cancelledJob.dir, 'actual-process.json')), false);
    console.log('LITERATURE_STAGE_REAL_PROCESS_CANCEL_TESTS_PASS');
  } finally {
    if (connector) {
      for (const job of connector.jobs.values()) {
        if (job.child && job.status === 'running') {
          const child = job.child;
          connector.cancel(job.id);
          await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('close', resolve); });
        }
      }
    }
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-stage-cancel-')) throw new Error('unsafe fixture cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
