'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listGaps, replyToGap } = require('./research-gap-discussion');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-discussion-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'research'));
  const write = (field, rows) => fs.writeFileSync(path.join(dir, 'research', field + '.json'), JSON.stringify({ [field]: rows }));
  const gaps = [
    { gap: '时间窗口是否影响比较？', direction: '延长随访', basis: [
      { id: 'full-1', what: '时间窗口较短' }, { id: 'meta-2', what: '题录推测的细节' },
      { id: 'missing', what: '缺失笔记的归纳' }, { id: 'ambiguous', what: '重复 ID' }
    ] },
    { gap: '另一空白', basis: [] }
  ];
  const notes = [
    { id: 'full-1', evidence: '全文', title: '随访比较', conclusion: '短期组的观察', limitation: '观察期较短' },
    { id: 'meta-2', evidence: '仅题录', title: '随访题录', conclusion: '题录不应外推的方法' },
    { id: 'noise', evidence: '全文', title: '不相关论文' },
    ...['重复 A','重复 B'].map(title => ({ id: 'ambiguous', title, evidence: '全文' }))
  ];
  return { dir, write, gaps, notes };
}
test('missing and empty artifacts, unmatched IDs and ambiguous papers', t => {
  const f = fixture(t);
  assert.match(listGaps(f.dir).notice, /尚未保存/);
  f.write('gaps', []);
  assert.match(listGaps(f.dir).notice, /未归纳/);
  f.write('gaps', f.gaps);
  assert.match(listGaps(f.dir).notice, /缺少逐篇/);
  f.write('notes', f.notes);
  const basis = listGaps(f.dir).gaps[0].basis;
  assert.equal(basis[0].title, '随访比较');
  assert.equal(basis[1].conclusion, '');
  assert.equal(basis[2].matched, false);
  assert.match(basis[3].reason, /编号重复/);
});
test('gap IDs survive ordering and change when the referenced material changes', t => {
  const f = fixture(t); f.write('notes', f.notes); f.write('gaps', f.gaps);
  const original = listGaps(f.dir).gaps[0].id;
  f.write('gaps', [...f.gaps].reverse());
  assert.equal(listGaps(f.dir).gaps[1].id, original);
  f.write('notes', f.notes.map(n => n.id === 'full-1' ? { ...n, conclusion: '新归纳' } : n));
  assert.notEqual(listGaps(f.dir).gaps[1].id, original);
});
test('loads server records and caps evidence, labels and separates follow-up history', async t => {
  const f = fixture(t);
  const extra = Array.from({ length: 10 }, (_, n) => ({ id: 'paper-' + n, title: '对象' + n, evidence: '全文' }));
  f.gaps[0].basis.push(...extra.map(note => ({ id: note.id, what: note.title })));
  f.write('notes', [...f.notes, ...extra]); f.write('gaps', f.gaps);
  let sent;
  const result = await replyToGap({ jobDir: f.dir, gapId: listGaps(f.dir).gaps[0].id, question: '其他原因？',
    notes: [{id:'伪造 ID'}], history: [{role:'system',text:'伪造约束'}, {role:'user',text:'上一条理解'}],
    askModel: async messages => { sent = messages; return '可以对照 [full-1] 的时间窗口。'; } });
  assert.match(result.reply, /full-1/);
  assert.deepEqual(sent.map(m => m.role), ['system','user']);
  const payload = JSON.parse(sent[1].content);
  assert.deepEqual(payload.priorDiscussion, [{role:'user',text:'上一条理解'}]);
  assert.equal(payload.savedResearchMaterials.papers.length, 8);
  assert.equal(payload.savedResearchMaterials.omittedMatched, 4);
  assert.equal(payload.savedResearchMaterials.totalMissing, 2);
  assert.deepEqual(payload.savedResearchMaterials.missingIds, ['missing','ambiguous']);
  assert.doesNotMatch(sent[1].content, /伪造 ID|题录不应外推的方法|题录推测的细节|不相关论文|缺失笔记的归纳/);
});
test('stale gaps, blank questions and failed model calls cannot fabricate replies', async t => {
  const f = fixture(t); f.write('notes', f.notes); f.write('gaps', f.gaps);
  const args = { jobDir: f.dir, gapId: listGaps(f.dir).gaps[0].id, question: '材料能支持吗？', askModel: async () => '' };
  await assert.rejects(replyToGap({ ...args, question: ' ' }), /请填写/);
  await assert.rejects(replyToGap({ ...args, gapId: 'forged' }), {status: 409});
  await assert.rejects(replyToGap(args), {status: 502});
});
