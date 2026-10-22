'use strict';

// Standalone fixtures only: never open a user's session or execute output code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CodexBridge } = require('./codex-bridge');
const { cleanResultsView } = require('./clean-results-view');

const project = path.resolve(__dirname, '..');
const fixtureBase = path.join(project, '.workbench', 'test-fixtures');
const oldRun = '11111111-1111-4111-8111-111111111111';
const newRun = '22222222-2222-4222-8222-222222222222';
const emptyRun = '33333333-3333-4333-8333-333333333333';
const linkedRun = '44444444-4444-4444-8444-444444444444';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const all = view => Object.values(view.groups).flat();
const find = (view, group, basename) => view.groups[group].find(file => path.posix.basename(file.name) === basename);
const runId = entry => typeof entry === 'string' ? entry : entry.id || entry.runId;

async function main() {
  fs.mkdirSync(fixtureBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureBase, 'clean-results-view-'));
  try {
    const bridge = new CodexBridge(root);
    const session = bridge.createSession().id;
    const sessionDir = bridge.session(session);
    const outputDir = path.join(sessionDir, 'output');
    const originalName = 'aabbccdd-FAOSTAT_TM_2024.csv';
    const original = Buffer.from('\ufeffReporter,Partner,Value\r\nA,B,42\r\n', 'utf8');
    const originalPath = path.join(sessionDir, 'input', originalName);
    fs.writeFileSync(originalPath, original);
    const originalHash = sha(fs.readFileSync(originalPath));

    const files = {
      [oldRun]: {
        'unified_trade_v1.csv': 'exporter,importer,trade_quantity_t\r\nA,B,25\r\nB,A,3\r\n',
        'check_report_v1.md': '# 检查报告\n尚有待讨论项目；不代表人工验收通过。\n',
        'unilateral_v1.csv': 'exporter,importer,available_side,reported_t\nA,C,export,0\n',
        'duplicate_keys_v1.csv': '\ufeffkey,count\r\n\r\n   \r\n',
        'aggregate_candidates_v1.csv': 'entity_code,entity_name\n',
        'unresolved_rows_v1.csv': 'source_row,reason',
        'mirror_differences_v1.csv': 'exporter,importer,difference\nA,B,0\nB,A,2\n',
        'entity_screening_v1.csv': 'entity_code,classification_status\n1,screening only; official classification not verified\n',
        'field_dictionary_v1.md': '# 字段字典\n字段仅供解释。\n',
        'clean_tm_v1.py': 'raise RuntimeError("This output code must never execute")\n'
      },
      [newRun]: {
        // Two data records, including quoted delimiters and a physical newline.
        'unified_trade_v2.csv': '\ufeffexporter,importer,note\r\n"A, Alpha",B,"line one\r\nline two"\r\nB,A,"escaped ""quote"""\r\n\r\n   \r\n',
        'unilateral_v2.csv': 'exporter,importer,note\nA,C,"not closed\n',
        'duplicate_keys_v2.csv': 'key,count\n' + 'a,1\n'.repeat(80000),
        'custom_model_input.csv': 'x,y\n1,2\n',
        'custom_model_input.xlsx': Buffer.from('fixture workbook placeholder'),
        'notes.txt': '保留的其他说明。\n'
      }
    };
    for (const [id, entries] of Object.entries(files)) {
      const dir = path.join(outputDir, id);
      fs.mkdirSync(dir);
      const timestamp = new Date(id === oldRun ? '2025-01-01T00:00:00Z' : '2025-02-01T00:00:00Z');
      for (const [name, bytes] of Object.entries(entries)) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, bytes);
        fs.utimesSync(file, timestamp, timestamp);
      }
      fs.utimesSync(dir, timestamp, timestamp);
    }
    fs.mkdirSync(path.join(outputDir, emptyRun));
    fs.utimesSync(path.join(outputDir, emptyRun), new Date('2025-03-01T00:00:00Z'), new Date('2025-03-01T00:00:00Z'));

    const latest = await cleanResultsView(bridge, session);
    assert.equal(latest.sessionId, session);
    assert.equal(latest.runId, newRun, '默认选择最新有文件的运行，不被空运行替换');
    assert.ok(latest.runs.map(runId).includes(oldRun));
    assert.ok(latest.runs.map(runId).includes(newRun));
    assert.deepEqual(Object.keys(latest.groups).sort(), ['auxiliary', 'issues', 'main', 'reports']);
    assert.ok(latest.inputs.some(file => file.group === 'input' && file.name === originalName), '原始文件独立保留');
    assert.ok(Array.isArray(latest.otherFiles));
    assert.equal(find(latest, 'main', 'unified_trade_v2.csv').rowCount, 2, 'CSV 按逻辑记录计数，支持 BOM、引号、逗号、换行与末尾空白');
    assert.ok(find(latest, 'main', 'custom_model_input.csv'), '未知数据 CSV 不应被隐藏');
    assert.ok(find(latest, 'main', 'custom_model_input.xlsx'), '未知 Excel 不应被隐藏');
    assert.ok(find(latest, 'auxiliary', 'notes.txt'), '未知说明文件归入辅助');
    for (const name of ['unilateral_v2.csv', 'duplicate_keys_v2.csv']) {
      const file = find(latest, 'issues', name);
      assert.ok(file, '不完整或超扫描上限的 CSV 继续显示在问题清单中');
      assert.equal(file.rowCount == null, true, '不完整或未读完文件不能伪造精确行数');
      assert.notEqual(file.empty, true, '未知行数不能误判为空表');
    }
    assert.ok(all(latest).every(file => file.name.startsWith(newRun + '/')), '本次结果不混入历史运行');

    const historical = await cleanResultsView(bridge, session, oldRun);
    assert.equal(historical.runId, oldRun, '支持显式选择历史运行');
    assert.deepEqual(Object.fromEntries(Object.entries(historical.groups).map(([key, value]) => [key, value.length])), {
      main: 1, reports: 1, issues: 1, auxiliary: 7
    });
    assert.equal(find(historical, 'main', 'unified_trade_v1.csv').rowCount, 2);
    assert.equal(find(historical, 'issues', 'unilateral_v1.csv').rowCount, 1);
    assert.match(find(historical, 'auxiliary', 'mirror_differences_v1.csv').label, /对照.*含一致记录/);
    for (const name of ['duplicate_keys_v1.csv', 'aggregate_candidates_v1.csv', 'unresolved_rows_v1.csv']) {
      const file = find(historical, 'auxiliary', name);
      assert.equal(file.rowCount, 0);
      assert.equal(file.empty, true);
      assert.match(file.label, /无记录的检查清单/);
      assert.doesNotMatch(file.label, /验收通过|核查通过|全部合格/, '空清单不等于研究者验收');
    }
    for (const file of all(historical)) {
      assert.equal(file.group, 'output');
      assert.equal(typeof file.size, 'number');
      assert.ok(file.label, '每个输出有可读标签');
    }

    for (const invalid of ['../input', oldRun + '/../' + newRun, '\\..\\input', '/etc/passwd', '%2e%2e%2finput']) {
      await assert.rejects(async () => cleanResultsView(bridge, session, invalid), undefined, '非法或越界运行标识必须拒绝');
    }
    await assert.rejects(async () => cleanResultsView(bridge, session, '55555555-5555-4555-8555-555555555555'), undefined, '不存在的运行不得静默回退');

    // Windows permits directory junctions without Developer Mode. This fake run
    // points outside the session, while remaining inside disposable fixture root.
    const outside = path.join(root, 'outside-output');
    fs.mkdirSync(outside);
    const secret = path.join(outside, 'must-not-read.csv');
    fs.writeFileSync(secret, 'secret\nnot a task result\n');
    const link = path.join(outputDir, linkedRun);
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(async () => cleanResultsView(bridge, session, linkedRun), undefined, '符号链接运行目录不能越过会话目录');
    const afterLink = await cleanResultsView(bridge, session);
    assert.ok(!afterLink.runs.map(runId).includes(linkedRun), '运行列表不呈现外部链接目录');
    assert.ok(!all(afterLink).some(file => file.name.includes('must-not-read')));
    fs.unlinkSync(link);
    assert.equal(sha(fs.readFileSync(originalPath)), originalHash, '所有展示与历史切换均不得修改原始数据');
    assert.equal(sha(fs.readFileSync(secret)), sha(Buffer.from('secret\nnot a task result\n')), '外部链接目标保持不变');
    console.log('clean results view tests passed');
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(fixtureBase) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
