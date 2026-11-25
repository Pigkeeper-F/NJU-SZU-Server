'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = {
  ApiKeys: {
    getActiveCredential: () => ({ provider: 'deepseek', apiKey: 'fixture-d' }),
    getCredential: id => id === 'deepseek' ? { provider: id, apiKey: 'fixture-d' } : null
  },
  Store: { llmSettings: { read: () => ({}), resolve: () => ({ model: 'fixture-group' }) } },
  CodexUI: { useCodex: () => true, getModel: () => 'fixture-codex' }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/research-model.js'), 'utf8'), { window: root });
const fields = choice => JSON.parse(JSON.stringify(root.ResearchModel.fields({ params: { researchBackend: choice } })));
assert.deepEqual(fields(), { backend: 'codex', codexModel: 'fixture-codex' });
assert.deepEqual(fields('workbuddy'), { backend: 'workbuddy' });
assert.deepEqual(fields('deepseek'), { backend: 'api', credential: { provider: 'deepseek', apiKey: 'fixture-d' } });
assert.deepEqual(fields('api'), { backend: 'api', settings: { model: 'fixture-group' } });
assert.throws(() => fields('openai'), /OpenAI/);
assert.throws(() => fields('removed-provider'), /选择/);
root.CodexUI.useCodex = () => false;
assert.equal(fields('follow').credential.provider, 'deepseek');
root.ApiKeys.getActiveCredential = () => null;
assert.deepEqual(fields('follow'), fields('api'));
console.log('RESEARCH_MODEL_PICKER_TESTS_PASS');
