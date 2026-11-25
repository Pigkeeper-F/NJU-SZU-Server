'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openResearchModel } = require('../server');
const { listGaps, replyToGap } = require('./research-gap-discussion');
const { CodexBridge } = require('./codex-bridge');

const messages = [{ role: 'user', content: 'fixture' }];

async function checkGapDiscussion() {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-model-gap-'));
  try {
    const dir = path.join(jobDir, 'research');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'gaps.json'), JSON.stringify({ gaps: [
      { gap: 'fixture gap', basis: [{ id: 'p1', what: 'fixture evidence' }] }
    ] }));
    fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ notes: [
      { id: 'p1', title: 'fixture paper', evidence: '全文', conclusion: 'fixture conclusion' }
    ] }));
    function assertParts(instructions, prompt) {
      assert.match(instructions, /仅以本次提供的 papers/);
      assert.doesNotMatch(instructions, /historic-comment|untrusted-instruction|fixture paper/);
      const payload = JSON.parse(prompt);
      assert.equal(payload.savedResearchMaterials.papers[0].title, 'fixture paper');
      assert.deepEqual(payload.priorDiscussion, [{ role: 'assistant', text: 'historic-comment' }]);
      assert.equal(payload.researcherQuestion, 'fixture question');
    }
    async function respond(model) {
      const result = await replyToGap({ jobDir, gapId: listGaps(jobDir).gaps[0].id,
        question: 'fixture question', history: [{ role: 'system', text: 'untrusted-instruction' }, { role: 'assistant', text: 'historic-comment' }],
        askModel: input => model.callModel(null, input, 1500) });
      assert.equal(result.reply, 'fixture reply [p1]');
    }
    const bridge = {
      createSession: () => ({ id: 'fixture' }),
      run: async (_, input, instructions, execute) => {
        assert.equal(execute, false);
        assert.equal(input.length, 1);
        assert.equal(input[0].role, 'user');
        assertParts(instructions, input[0].content);
        return { id: 'response' };
      },
      snapshot: () => ({ status: 'completed', text: 'fixture reply [p1]', model: 'fixture-codex' })
    };
    await respond(openResearchModel({ backend: 'codex' }, { compose: CodexBridge.prototype.compose.bind(bridge) }));
    const checkMessages = async input => {
      assert.deepEqual(input.map(m => m.role), ['system', 'user']);
      assertParts(input[0].content, input[1].content);
      return 'fixture reply [p1]';
    };
    await respond(openResearchModel({ backend: 'workbuddy' }, { workBuddy: checkMessages }));
    await respond(openResearchModel({ backend: 'api' }, { callApi: (_, input) => checkMessages(input) }));
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

async function main() {
  // Never use workstation credentials or contact a provider.
  const env = process.env;
  env.AI_API_KEY = 'fixture-server';
  env.AI_API_BASE_URL = 'https://server.invalid/v1';
  env.AI_MODEL = 'fixture-default';
  env.AI_API_PROTOCOL = 'responses';
  delete env.WORKBUDDY_ACCESS_TOKEN;
  const paths = [];
  const backends = {
    compose: async (prompt, model, { metadata, signal }) => {
      paths.push('codex');
      assert.equal(prompt, 'fixture');
      assert.ok(signal instanceof AbortSignal);
      metadata.model = model || 'fixture-codex-default';
      return 'generated';
    },
    workBuddy: async (input, options) => {
      paths.push('workbuddy');
      assert.deepEqual(input, messages);
      assert.deepEqual(options, { accessToken: 'fixture-oauth', timeoutMs: 1200 });
      return 'generated';
    },
    callApi: async () => { throw new Error('Unexpected API request'); }
  };
  for (const invalid of [null, '', 'offline', {}, 'Codex']) {
    assert.throws(() => openResearchModel({ backend: invalid }, backends), error => error.status === 400);
  }
  const browserKey = { provider: 'deepseek', apiKey: 'fixture-browser', model: 'fixture-api' };
  const local = openResearchModel({ backend: 'codex', credential: browserKey }, backends);
  assert.equal(await local.callModel(null, messages, 1200), 'generated');
  assert.deepEqual(local.info(), { backend: 'codex', source: 'codex', provider: '本机 Codex', model: 'fixture-codex-default' });
  const selected = openResearchModel({ backend: 'codex', codexModel: 'selected' }, backends);
  await selected.callModel(null, messages, 1200);
  assert.equal(selected.info().model, 'selected');
  assert.throws(() => openResearchModel({ backend: 'workbuddy', credential: browserKey, accessToken: 'browser-token' }, backends), error => error.status === 503);
  env.WORKBUDDY_ACCESS_TOKEN = 'fixture-oauth';
  const workbuddy = openResearchModel({ backend: 'workbuddy', credential: browserKey, codexModel: 'unused' }, backends);
  assert.equal(await workbuddy.callModel(null, messages, 1200), 'generated');
  assert.deepEqual(workbuddy.info(), { backend: 'workbuddy', source: 'workbuddy', provider: '腾讯 WorkBuddy', model: 'WorkBuddy 云端助理' });
  assert.deepEqual(paths, ['codex', 'codex', 'workbuddy']);

  // Stub the real API transport so both parsers and credential precedence are covered.
  let request;
  global.fetch = async (url, options) => {
    request = { url, key: options.headers.Authorization, payload: JSON.parse(options.body) };
    const result = url.endsWith('/responses')
      ? { model: 'reported-version', output: [{ type: 'message', content: [{ type: 'output_text', text: 'generated' }] }] }
      : { model: 'reported-version', choices: [{ message: { content: 'generated' } }] };
    return { ok: true, json: async () => result };
  };
  async function checkApi(data, source, provider, key, model, url) {
    const scoped = openResearchModel(data);
    assert.equal(await scoped.callModel(null, messages, 1200), 'generated');
    assert.equal(request.key, 'Bearer ' + key);
    assert.equal(request.payload.model, model);
    assert.equal(request.url, url);
    assert.deepEqual(scoped.info(), { backend: 'api', source, provider, model: 'reported-version' });
  }
  await checkApi({}, 'server-env', 'server.invalid', 'fixture-server', 'fixture-default', 'https://server.invalid/v1/responses');
  await checkApi({ backend: 'api', settings: { baseUrl: 'https://custom.invalid/v1', apiKey: 'fixture-settings', model: 'custom' } },
    'browser-settings', 'custom.invalid', 'fixture-settings', 'custom', 'https://custom.invalid/v1/responses');
  await checkApi({ backend: 'api', settings: { baseUrl: 'https://custom.invalid/v1', apiKey: 'unused-key' }, credential: browserKey },
    'browser-credential', 'DeepSeek', 'fixture-browser', 'fixture-api', 'https://api.deepseek.com/v1/chat/completions');
  assert.throws(() => openResearchModel({ backend: 'api', settings: { baseUrl: 'https://foreign.invalid/v1' } }), error => error.status === 400);
  assert.throws(() => openResearchModel({ backend: 'api', settings: { baseUrl: 'https://custom.invalid/v1?token=fixture', apiKey: 'fixture' } }), error => error.status === 400);
  await checkGapDiscussion();
  delete env.AI_API_KEY;
  assert.throws(() => openResearchModel({ backend: 'api' }), error => error.status === 503);
  console.log('RESEARCH_MODEL_ROUTING_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
