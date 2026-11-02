'use strict';

// Only terminal text replies from /literature/prepare are durable here. This is
// neither a runnable job store nor evidence of generated files or confirmation.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KIND = 'literature-prepare';
const MAX_PREPARE_RESULT_BYTES = 20 * 1024 * 1024;
const fail = (message, code = 'INVALID_PREPARE_RESULT', statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
function identifier(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('文献规则整理结果标识无效');
  return value;
}
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function terminalSnapshot(raw) {
  if (!plain(raw) || !['completed', 'failed', 'cancelled'].includes(raw.status)) throw fail('仅可保存文献规则整理的终态文字结果');
  if (raw.kind != null && raw.kind !== KIND) throw fail('不能将其他任务保存为文献规则整理结果');
  if (typeof raw.text !== 'string' || typeof raw.preview !== 'string' || !Array.isArray(raw.events) || raw.events.some(value => typeof value !== 'string')
      || raw.model != null && typeof raw.model !== 'string' || raw.error != null && typeof raw.error !== 'string') throw fail('文献规则整理文字结果结构无效；未截断或补造内容');
  return { id: identifier(raw.id), sessionId: identifier(raw.sessionId), kind: KIND, status: raw.status, model: raw.model ?? null,
    text: raw.text, preview: raw.preview, events: raw.events.slice(), error: raw.error ?? null, files: [] };
}
function directory(root, names, create = false) {
  let current = path.resolve(root);
  for (const name of names) {
    current = path.join(current, name);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') throw fail('文献规则整理结果所属任务目录不存在', 'PREPARE_RESULT_SESSION_MISSING', 404); throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('文献规则整理结果目录不安全，未读写', 'PREPARE_RESULT_UNSAFE_PATH');
  }
  return current;
}
function jobDirectories(root, snapshot) {
  directory(root, ['.workbench', snapshot.sessionId, 'input']);
  directory(root, ['.workbench', snapshot.sessionId, 'output', snapshot.id]);
}
function readLiteraturePrepareResult(root, id, expectedSessionId) {
  identifier(id);
  if (expectedSessionId != null) identifier(expectedSessionId);
  let dir;
  try { dir = directory(root, ['.workbench', 'literature-prepare-results']); }
  catch (error) { if (error.code === 'PREPARE_RESULT_SESSION_MISSING') return null; throw error; }
  const file = path.join(dir, id + '.json'); let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('文献规则整理结果文件不安全，未读取', 'PREPARE_RESULT_UNSAFE_PATH');
  if (stat.size > MAX_PREPARE_RESULT_BYTES) throw fail('文献规则整理结果超过20MiB，未截断', 'PREPARE_RESULT_CAPACITY', 413);
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { throw fail('文献规则整理结果文件损坏，未恢复任务', 'PREPARE_RESULT_CORRUPT', 409); }
  if (!plain(record) || record.schemaVersion !== 1 || record.kind !== KIND || typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt))) throw fail('文献规则整理结果版本或类型不符', 'PREPARE_RESULT_CORRUPT', 409);
  const snapshot = terminalSnapshot(record.snapshot);
  if (snapshot.id !== id || expectedSessionId != null && snapshot.sessionId !== expectedSessionId || record.snapshot.kind !== KIND
      || !Array.isArray(record.snapshot.files) || record.snapshot.files.length) throw fail('文献规则整理结果归属或纯文字类型不符', 'PREPARE_RESULT_SCOPE_MISMATCH', 409);
  jobDirectories(root, snapshot);
  return snapshot;
}
function saveLiteraturePrepareResult(root, raw) {
  const snapshot = terminalSnapshot(raw);
  const record = { schemaVersion: 1, kind: KIND, savedAt: new Date().toISOString(), snapshot };
  const body = JSON.stringify(record);
  if (Buffer.byteLength(body, 'utf8') > MAX_PREPARE_RESULT_BYTES) throw fail('文献规则整理结果超过20MiB，未保存、未截断', 'PREPARE_RESULT_CAPACITY', 413);
  jobDirectories(root, snapshot);
  const dir = directory(root, ['.workbench', 'literature-prepare-results'], true);
  const existing = readLiteraturePrepareResult(root, snapshot.id, snapshot.sessionId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw fail('文献规则整理终态结果已存在，未覆盖旧回复', 'PREPARE_RESULT_CONFLICT', 409);
    return { saved: true, deduplicated: true, id: snapshot.id };
  }
  const lock = path.join(dir, '.prepare-' + snapshot.id + '.lock');
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const committed = readLiteraturePrepareResult(root, snapshot.id, snapshot.sessionId);
    if (committed && JSON.stringify(committed) === JSON.stringify(snapshot)) return { saved: true, deduplicated: true, id: snapshot.id };
    throw fail('文献规则整理结果正在保存，请重试；旧回复未覆盖', 'PREPARE_RESULT_CONFLICT', 409);
  }
  const temporary = path.join(dir, '.prepare-' + randomUUID() + '.tmp'), target = path.join(dir, snapshot.id + '.json');
  try {
    // Recheck after acquiring the cross-process, per-job publication lock.
    const committed = readLiteraturePrepareResult(root, snapshot.id, snapshot.sessionId);
    if (committed) {
      if (JSON.stringify(committed) !== JSON.stringify(snapshot)) throw fail('文献规则整理终态结果已存在，未覆盖旧回复', 'PREPARE_RESULT_CONFLICT', 409);
      return { saved: true, deduplicated: true, id: snapshot.id };
    }
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, body, 'utf8'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    // All cooperating saves hold the same per-job lock. Publish only the
    // complete fsynced file, never an incrementally written terminal reply.
    fs.renameSync(temporary, target);
    return { saved: true, deduplicated: false, id: snapshot.id };
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.rmdirSync(lock);
  }
}

module.exports = { saveLiteraturePrepareResult, readLiteraturePrepareResult, MAX_PREPARE_RESULT_BYTES };
