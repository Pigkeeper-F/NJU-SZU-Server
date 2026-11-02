'use strict';
// Config construction only: no browser, network, job creation or research run.
const assert = require('node:assert/strict');
const path = require('node:path');
const confirmed = require('./literature-confirmed-plan');
const root = path.resolve(__dirname, '..');
const data = confirmed.catalog(root);
assert.equal(data.entries.length, 10);
assert.equal(data.followups.length, 9);
for (const entry of [...data.entries, ...data.followups]) {
  const { config, basis } = confirmed.buildConfig(root, entry.id, new Date('2026-10-31T01:00:00Z'));
  assert.equal(config.researchPlan.presetId, entry.id);
  assert.equal(config.researchPlan.boundDate, '2026-10-31');
  assert.equal(config.screeningPolicy.id, entry.screeningPolicy.id);
  assert.deepEqual(config.sources, [entry.source]);
  assert.equal(basis.entry.query, entry.query);
  if (entry.role === 'supplement') {
    assert.equal(basis.entry.autoStart, false);
    assert.equal(basis.entry.executionMode, 'independent_prepared_task');
    assert.equal(config.scholarPlan, undefined);
  }
  if (entry.source === 'web-of-science') assert.match(config.query, /DOP=2000-01-01\/2026-10-31/);
  if (entry.source === 'google-scholar') {
    assert.equal(config.scholarPlan.version, 2);
    assert.equal(config.scholarPlan.yearSpan, 0);
    assert.equal(config.scholarPlan.topics.length, entry.queries.length);
  }
}
assert.throws(() => confirmed.buildConfig(root, 'missing-supplement'), /请选择/);
console.log('Confirmed followups: 19 independent configuration presets checked; no research started.');
