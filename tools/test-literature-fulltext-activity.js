'use strict';

// Exercise the actual process runner with a virtual clock and child process.
// No Python, browser, network, real timer delay or user task is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, 'literature-connector.js'), 'utf8');
function functionSource(name) {
  const plain = source.indexOf('function ' + name + '(');
  assert.ok(plain >= 0, name);
  const start = source.slice(Math.max(0, plain - 6), plain) === 'async ' ? plain - 6 : plain;
  return source.slice(start, source.indexOf('\n}', plain) + 2);
}
function fakeClock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].callback();
      }
      now = end;
    },
    pending: () => timers.size
  };
}
function fixture() {
  const clock = fakeClock(), children = [], events = [], bases = new Map([['material-child', { candidateCount: 10 }]]);
  const context = vm.createContext({
    fs: { existsSync: () => true }, path,
    STAGE_TIMEOUTS: { discover: 180, dedupe: 120, fulltext: 3600, extract: 1800 },
    stagePythonProcessSpec: async () => ({ executable: 'mock-python', environment: {} }), pythonEnv: () => ({}),
    materialBasisFor: dir => bases.get(dir) || null,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    spawn() {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = [];
      child.kill = signal => child.kills.push(signal); children.push(child); return child;
    }
  });
  vm.runInContext(['timeoutText', 'stageActivitySeconds', 'fulltextActivity', 'runStageProcess'].map(functionSource).join('\n')
    + '\nglobalThis.subject={stageActivitySeconds,runStageProcess};', context);
  return { clock, children, events, bases, subject: context.subject,
    async start(stage = 'fulltext', dir = 'normal-job') {
      const job = { dir, status: 'running', activeStage: stage, limits: { [stage]: 1 } };
      const done = context.subject.runStageProcess('fixture-root', job, 'mock-python', 'fixture.py', [], event => {
        events.push(event);
        if (event?.type === 'attention') job.status = 'needs_attention';
        if (event?.type === 'result') job.status = 'completed';
      }).then(() => null, error => error);
      await new Promise(resolve => setImmediate(resolve));
      const child = children.at(-1);
      return { job, child, done, emit: event => child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n')) };
    }
  };
}

async function main() {
  const budgets = fixture();
  assert.equal(budgets.subject.stageActivitySeconds({ dir: 'material-child', limits: { fulltext: 3600 } }, 'fulltext'), 7200);
  assert.equal(budgets.subject.stageActivitySeconds({ dir: 'material-child', limits: { fulltext: 9000 } }, 'fulltext'), 9000);
  assert.equal(budgets.subject.stageActivitySeconds({ dir: 'normal-job', limits: { fulltext: 3600 } }, 'fulltext'), 3600);
  assert.equal(budgets.subject.stageActivitySeconds({ dir: 'material-child', limits: { extract: 17 } }, 'extract'), 17);
  budgets.bases.set('large-child', { candidateCount: 10000 });
  assert.equal(budgets.subject.stageActivitySeconds({ dir: 'large-child', limits: {} }, 'fulltext'), 86400);

  const progress = fixture(), active = await progress.start();
  progress.clock.advance(800);
  active.emit({ type: 'stage', stage: 'fulltext', message: 'PDF received 1 MB' });
  progress.clock.advance(800);
  assert.equal(active.child.kills.length, 0, 'valid activity extends the fulltext worker beyond its original deadline');
  active.emit({ type: 'stage', stage: 'fulltext', message: 'PDF received 1 MB' });
  progress.clock.advance(200);
  assert.deepEqual(active.child.kills, ['SIGKILL'], 'duplicate progress cannot postpone an idle timeout');
  assert.equal((await active.done).code, 'LITERATURE_STAGE_TIMEOUT');
  assert.equal(active.job.child, null);

  const noise = fixture(), idle = await noise.start(); noise.clock.advance(800);
  idle.child.stdout.emit('data', Buffer.from('unstructured logging\n'));
  for (const event of [null, [], { type: 'log', stage: 'fulltext', message: 'noise' },
    { type: 'stage', stage: 'discover', message: 'wrong stage' }, { type: 'stage', stage: 'fulltext', message: ' ' },
    { type: 'progress', stage: 'fulltext', message: 'bad count', count: '1' },
    { type: 'result', stage: 'fulltext', count: '1' }, { type: 'attention', stage: 'extract', reason: 'login', message: 'wrong terminal' }]) idle.emit(event);
  noise.clock.advance(200); assert.equal(idle.child.kills.length, 1, 'malformed, irrelevant and empty events cannot extend or clear the timer');
  await idle.done;

  for (const terminal of [
    { type: 'attention', stage: 'fulltext', reason: 'deferred_materials', message: 'Waiting for explicit researcher action' },
    { type: 'attention', stage: 'verification', reason: 'page_not_ready', message: 'Original page retained' },
    { type: 'result', stage: 'fulltext', count: 1, message: 'Saved' }
  ]) {
    const paused = fixture(), run = await paused.start();
    for (let step = 0; step < 3; step++) {
      paused.clock.advance(900); run.emit({ type: 'progress', stage: 'fulltext', count: step, message: 'Actual transfer ' + step });
    }
    assert.equal(run.child.kills.length, 0);
    run.emit(terminal); assert.equal(paused.clock.pending(), 0, 'a terminal event disarms active work timing');
    run.emit({ type: 'stage', stage: 'fulltext', message: 'late output cannot restart timing' });
    paused.clock.advance(7 * 86400 * 1000);
    assert.equal(run.child.kills.length, 0, 'human waiting has no worker deadline');
    run.child.emit('close', 0); assert.equal(await run.done, null);
  }

  const other = fixture(), extraction = await other.start('extract');
  other.clock.advance(800); extraction.emit({ type: 'stage', stage: 'extract', message: 'Extracting' });
  other.clock.advance(200); assert.equal(extraction.child.kills.length, 1, 'other stages retain their fixed total budget');
  await extraction.done;
  console.log('LITERATURE_FULLTEXT_ACTIVITY_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
