'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LiteratureConnector } = require('./literature-connector');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-materials-'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
function fixture(connector) {
  const id = randomUUID(), dir = path.join(connector.base, id);
  write(path.join(dir, 'job.json'), { id, status: 'needs_attention', resumeStage: 'fulltext', files: [], events: [], config: {}, stages: {} });
  return { id, dir };
}
function file(task, relative, body = 'fixture material') {
  const target = path.join(task.dir, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body); return target;
}
function material(relative, patch = {}) {
  return { material_id: 'M1', role: 'supplement', label: 'Supplementary table', filename: 'table.xlsx', path: relative,
    format: 'xlsx', mime_type: 'application/octet-stream', size: 16, download_status: 'downloaded', read_status: 'unsupported',
    read_reason: 'Saved original file; parser is not installed', ...patch };
}
function main() {
  const connector = new LiteratureConnector(root, { prepare: async () => { throw new Error('view cannot run/install'); } });
  connector.runStage = async () => { throw new Error('view cannot execute'); };
  const task = fixture(connector), name = 'fulltext/materials/CNKI-001/unpacked/table.xlsx'; file(task, name);
  const body = 'fulltext/files/CNKI-001.pdf'; file(task, body);
  const manifest = { version: 1, papers: [{ paper_id: 'CNKI-001', title: 'Paper title', doi: '10.1000/example', main_pdf_status: 'downloaded',
    supplement_check: { status: 'checked', reason: 'Inspected official supplement list' }, materials: [material(name),
      material(body, { role: 'main_pdf', format: 'pdf', filename: 'CNKI-001.pdf', read_status: 'unreadable', read_reason: 'PDF parser could not read this saved original' })],
    transient_url: 'https://private.example?token=must-not-leak' }] };
  const manifestPath = path.join(task.dir, 'fulltext/materials.json'); write(manifestPath, manifest);
  const jobBefore = fs.readFileSync(path.join(task.dir, 'job.json')), manifestBefore = fs.readFileSync(manifestPath);
  const inventory = connector.materials(task.id);
  assert.equal(inventory.schema, 1); assert.equal(inventory.legacy, false);
  assert.equal(inventory.papers[0].materials[0].available, true);
  assert.equal(inventory.papers[0].materials[0].read_status, 'unsupported');
  assert.equal(inventory.papers[0].materials[1].read_status, 'unreadable');
  assert.equal(connector.download(task.id, name), path.join(task.dir, name));
  assert.equal(connector.download(task.id, body), path.join(task.dir, body));
  assert.ok(!JSON.stringify(inventory).includes('must-not-leak'));
  assert.deepEqual(fs.readFileSync(path.join(task.dir, 'job.json')), jobBefore);
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
  assert.equal(connector.jobs.size, 0, 'view/download cannot bind or write a running job');
  const unregistered = 'fulltext/materials/CNKI-001/private.txt'; file(task, unregistered);
  assert.throws(() => connector.download(task.id, unregistered), /未登记/);
  for (const bad of ['fulltext/materials/CNKI-001/../../job.json', 'fulltext/materials/CNKI-001/table.xlsx:stream',
    'fulltext/materials/CNKI-001\\table.xlsx', 'fulltext/materials/CNKI-001/CON.txt']) {
    manifest.papers[0].materials = [material(bad)]; write(manifestPath, manifest);
    assert.throws(() => connector.download(task.id, bad), /未登记|不存在|路径/);
  }
  // A registered but missing file is distinct from a successfully saved file.
  manifest.papers[0].materials = [material('fulltext/materials/CNKI-001/missing.csv')]; write(manifestPath, manifest);
  const missing = connector.materials(task.id).papers[0].materials[0];
  assert.equal(missing.available, false); assert.equal(missing.download_status, 'missing');
  // A path below a symlink/junction is not authorized even if in the manifest.
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
  const linked = path.join(task.dir, 'fulltext/materials/CNKI-001/linked');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedName = 'fulltext/materials/CNKI-001/linked/secret.txt';
  manifest.papers[0].materials = [material(linkedName)]; write(manifestPath, manifest);
  assert.throws(() => connector.download(task.id, linkedName), /未登记/);
  fs.unlinkSync(linked);
  manifest.papers[0].materials = [material(name, { read_reason: 'https://private.example?token=secret SID=another', download_reason: 'https://download.example?ticket=private token=secret',
    reused_from: { job_id: randomUUID(), paper_id: 'CNKI-001', url: 'https://private.example/session' } })];
  manifest.schema = 1; delete manifest.version; write(manifestPath, manifest);
  const sanitized = JSON.stringify(connector.materials(task.id));
  assert.ok(!sanitized.includes('private.example') && !sanitized.includes('another') && !sanitized.includes('secret') && !sanitized.includes('download.example'));

  const legacy = fixture(connector); const legacyPath = 'fulltext/files/PMID-001.txt'; file(legacy, legacyPath, 'old visible body');
  write(path.join(legacy.dir, 'fulltext/status.json'), { items: [{ paper_id: 'PMID-001', title: 'Old paper', status: 'fetched_html', path: legacyPath, size: 16 }] });
  const legacyJob = fs.readFileSync(path.join(legacy.dir, 'job.json')), listing = connector.materials(legacy.id);
  assert.equal(listing.legacy, true); assert.equal(listing.papers[0].supplement_check.status, 'uninspected');
  assert.equal(listing.papers[0].main_pdf_status, 'missing');
  assert.ok(!fs.existsSync(path.join(legacy.dir, 'fulltext/materials.json')));
  assert.deepEqual(fs.readFileSync(path.join(legacy.dir, 'job.json')), legacyJob);
  assert.throws(() => connector.materials('../bad'), /无效/);
  console.log('LITERATURE_MATERIALS_TESTS_PASS');
}
try { main(); } catch (error) { console.error(error); process.exitCode = 1; } finally {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-materials-')) throw new Error('unsafe fixture cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
}
