#!/usr/bin/env node
'use strict';
// Regression for the real A-rule platform path: server source has a final
// newline; the browser editor trims approved text; CSV and TXT began as
// reference standards. Only real production functions are composed below.
// All requests use an isolated in-memory server; no live cleaning is run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const adapter = require('../js/clean-execution-plan');
const compiler = require('../js/clean-verification-rules');
const tasksSource = fs.readFileSync(path.join(__dirname, '../js/tasks.js'), 'utf8');
const codexSource = fs.readFileSync(path.join(__dirname, '../js/codex.js'), 'utf8');
const original = fs.readFileSync(path.join(__dirname, 'fixtures/fbsh80-a-plan.md'), 'utf8').replace(/\r\n?/g, '\n');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function fn(source, name) {
  const start = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(start, name);
  return source.slice(start.index, source.indexOf('\n  }', start.index) + 4);
}
assert.ok(original.endsWith('\n'), 'Frozen A source retains its final newline');
const originalPlan = adapter.prepare(original);
assert.ok(originalPlan);
const csv = originalPlan.inputReferenceNames[0], txt = originalPlan.standardReferenceNames[0];
const binding = { sourceName: csv, inputName: csv, sha256: '0247cc2079a04125980ccf9510a4e3d56960734633012ef6181dddd65965f2c0' };
const resolved = adapter.resolve(original, binding);
assert.ok(resolved);
const basePatch = { id: 'fixture-a-resolved', sessionId: 'fixture-a-session', beforeText: original, afterText: resolved.text,
  beforeSha256: sha(original), afterSha256: sha(resolved.text), binding,
  authorization: { text: '同步平台内A规则，保留原版本和讨论，让我直接点执行。' }, createdAt: '2026-10-27T14:00:00Z' };
async function run(browserStyle, uploadAliases = false) {
  const aliasSource = csv.replace('3f7c827b-', '1918facb-');
  const aliasInput = csv.replace('3f7c827b-', '3490741e-');
  const duplicateInput = csv.replace('3f7c827b-', '70000000-');
  const currentBinding = uploadAliases ? { ...binding, sourceName: aliasSource, inputName: aliasInput } : binding;
  const currentResolved = adapter.resolve(original, currentBinding);
  assert.ok(currentResolved, 'The upload aliases must be resolved against the unchanged approved A source');
  const patch = { ...copy(basePatch), binding: currentBinding, afterText: currentResolved.text, afterSha256: sha(currentResolved.text),
    ...(uploadAliases ? { standardFiles: [{ name: txt, group: 'reference', size: 811, sha256: 'b'.repeat(64) }] } : {}) };
  const inputName = currentBinding.inputName, referenceName = currentBinding.sourceName;
  const approved = browserStyle === 'crlf' ? original.trim().replace(/\n/g, '\r\n') : original.trim();
  const module = { id: 'fixture-clean', type: 'clean-data', messages: [{ role: 'user', text: '此前全部讨论保留。' }], doc: { status: 'draft', content: '此前方案保留。' }, run: { id: 'prior-output' } };
  const project = { id: 'fixture-project', rulesByModule: { [module.id]: { draft: approved, confirmed: approved, versions: [{ at: '2026-10-26T00:00:00Z', text: approved }] } } };
  const index = { activeTaskId: project.id, tasks: [project] }, state = { modules: [module], activeModuleId: module.id };
  const t = { files: [], busy: false, backend: 'codex' }, saved = { [module.id]: { sessionId: patch.sessionId,
    cleanStandardNames: uploadAliases ? [referenceName] : [csv, txt] } };
  const originalModule = copy(module), calls = [], persisted = [], notices = [], memory = {};
  let files = [{ group: 'reference', name: referenceName, size: 7654 }, { group: 'reference', name: txt, size: 811 },
    ...(uploadAliases ? [{ group: 'input', name: inputName, size: 7654 }, { group: 'input', name: duplicateInput, size: 7654 }] : [])], managerSaves = 0;
  const Store = { getState: () => state };
  const root = { Store, CleanExecutionPlan: adapter, CleanVerificationRules: compiler, ModuleSpace: { isBusy: () => false } };
  const context = vm.createContext({ root, Store, index, saved, memory, INDEX_KEY: 'research_tasks_v1',
    switching: false, pendingRules: null, startingExecution: null, cleanVerificationStage: null,
    current: () => project, task: id => { assert.equal(id, module.id); return t; }, busy: () => false,
    saveIndex() { managerSaves++; persisted.push(copy(index)); return true; }, persist() { persisted.push(copy(saved)); },
    showMessage: value => notices.push(value), render() {},
    session: async id => { assert.equal(id, module.id); return saved[id].sessionId; },
    request: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, body });
      if (url === '/api/codex/clean/rule-update?session=' + patch.sessionId) return { update: copy(patch) };
      if (url === '/api/codex/clean/rule-update-ack') {
        assert.equal(body.sessionId, patch.sessionId); assert.equal(body.updateId, patch.id);
        assert.equal(body.afterSha256, patch.afterSha256); assert.equal(body.version, 2);
        return { acknowledged: true };
      }
      if (url === '/api/codex/files?session=' + patch.sessionId) return { files: copy(files) };
      if (url === '/api/codex/clean/bind-input') {
        assert.equal(uploadAliases, false, 'An existing hash-bound alias input must never be recopied');
        assert.deepEqual(body, { sessionId: patch.sessionId, names: [csv], confirm: true });
        files = files.filter(file => file.group !== 'input').concat({ group: 'input', name: csv, size: 7654 });
        return { sessionId: patch.sessionId, inputNames: [csv], boundSources: [csv], sourceToInput: { [csv]: csv }, files: copy(files) };
      }
      throw Error('Unexpected request; live execution is forbidden: ' + url);
    }, Date, JSON, Error });
  vm.runInContext(fn(tasksSource, 'applyCleanRuleUpdate') + '\n'
    + ['cleanStandardNames', 'basisForClean', 'syncCleanRuleUpdate', 'prepareConfirmedExecution'].map(name => fn(codexSource, name)).join('\n')
    + '\nglobalThis.subject={applyCleanRuleUpdate,syncCleanRuleUpdate,prepareConfirmedExecution,basisForClean};', context);
  root.TaskManager = { applyCleanRuleUpdate: context.subject.applyCleanRuleUpdate, currentTaskId: () => index.activeTaskId,
    rulesForModule(id) { const rules = project.rulesByModule[id]; return { text: rules.confirmed, draft: rules.draft, dirty: rules.draft.trim() !== rules.confirmed, version: rules.versions.length }; } };
  root.CodexUI = { cleanSessionId: id => saved[id]?.sessionId || null, syncCleanRuleUpdate: context.subject.syncCleanRuleUpdate };
  const update = await context.subject.syncCleanRuleUpdate(module.id);
  assert.equal(update.applied, true, 'A trimmed/CRLF browser approval receives the staged source update');
  const rules = project.rulesByModule[module.id];
  assert.equal(rules.versions.length, 2); assert.equal(rules.versions[0].text, approved, 'Original browser approval stays byte-for-byte in history');
  assert.equal(rules.confirmed, currentResolved.text); assert.equal(rules.draft, currentResolved.text); assert.equal(managerSaves, 1);
  assert.deepEqual(Array.from(saved[module.id].cleanStandardNames), [txt], 'CSV stops being a standard; TXT remains the actual standard');
  assert.deepEqual(Array.from(saved[module.id].inputBatch.names), [inputName]);
  assert.equal(calls.filter(call => call.url === '/api/codex/clean/rule-update-ack').length, 1);
  const prepared = adapter.prepare(rules.confirmed), compiled = compiler.compile(prepared.executionText);
  assert.equal(compiled.manualChecks.state, 'specified'); assert.equal(compiled.manualChecks.rules.length, 3);
  assert.ok(compiled.manualChecks.rules.every(rule => !rule.reason), 'All three original human standards remain explicit');
  if (uploadAliases) {
    const oldHumanRows = original.split('\n').filter(line => /^\| H[123] \|/.test(line));
    const newHumanRows = rules.confirmed.split('\n').filter(line => /^\| H[123] \|/.test(line));
    assert.deepEqual(newHumanRows, oldHumanRows.map(line => line.split(csv).join(inputName)), 'H2/H3 change only their byte-identical CSV filename citations');
    assert.ok(!rules.confirmed.includes('3f7c827b-'), 'No stale CSV alias remains in the active rule');
  }
  assert.equal(await context.subject.prepareConfirmedExecution(module.id), true, 'The actual execution preparation must not throw the standard-originals error');
  assert.equal(t.preparedCleanPlan.text, currentResolved.text); assert.equal(t.preparedCleanPlan.version, 2);
  assert.deepEqual(Array.from(t.preparedCleanPlan.inputNames), [inputName]); assert.deepEqual(Array.from(t.preparedCleanPlan.standardNames), [txt]);
  assert.equal(t.executeOnce, true); assert.equal(t.execute, false);
  assert.ok(t.files.some(file => file.group === 'input' && file.name === inputName));
  assert.ok(t.files.some(file => file.group === 'reference' && file.name === referenceName), 'Original CSV stays in reference');
  if (uploadAliases) {
    assert.ok(t.files.some(file => file.group === 'input' && file.name === duplicateInput), 'The unused duplicate stays on disk');
    assert.ok(!t.preparedCleanPlan.inputNames.includes(duplicateInput), 'The unused duplicate is never mixed into the selected 80 rows');
  }
  assert.deepEqual(module, originalModule, 'Discussion, doc and prior result are untouched');
  const again = await context.subject.syncCleanRuleUpdate(module.id);
  assert.equal(again.unchanged, true); assert.equal(project.rulesByModule[module.id].versions.length, 2); assert.equal(managerSaves, 1);
  assert.equal(calls.filter(call => call.url === '/api/codex/clean/bind-input').length, uploadAliases ? 0 : 1);
  assert.ok(!calls.some(call => call.url === '/api/codex/run' || call.url.includes('/verify')), 'No run, re-confirmation or verification is started by synchronization');
  return { browserStyle, uploadAliases, version: rules.versions.length, inputNames: Array.from(t.preparedCleanPlan.inputNames), standardNames: Array.from(t.preparedCleanPlan.standardNames), manual: compiled.manualChecks.state, requests: calls.length };
}
(async () => {
  const results = [await run('trimmed-lf'), await run('crlf'), await run('trimmed-lf', true)];
  console.log('PASS A platform handoff: original newline -> browser trimmed/CRLF -> authorised v2 -> input binding -> execution preparation; no standard-originals error, live run or re-confirmation.');
  console.log(JSON.stringify(results));
})().catch(error => { console.error(error); process.exitCode = 1; });
