'use strict';

const fs = require('node:fs');
const path = require('node:path');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(message, status = 409) { return Object.assign(new Error(message), { status }); }

// Auxiliary research/import requests have no connector child process. Keep
// their writes serialized and visible to the normal safe-restart handshake.
class LiteratureAuxiliary {
  constructor(root, scholar) { this.root = root; this.scholar = scholar; this.active = false; }
  get busy() { return this.active; }
  assertIdle() { if (this.active) throw failure('文献调研或清单导入正在处理，请完成后再操作原任务。'); }
  acquire() {
    this.assertIdle(); this.active = true;
    let released = false;
    return () => { if (!released) { released = true; this.active = false; } };
  }
  job(id, { importing = false } = {}) {
    if (!UUID.test(id || '')) throw failure('检索任务标识无效。', 400);
    const dir = path.join(this.root, '.workbench', 'literature', id);
    let saved;
    try { saved = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')); }
    catch (_) { throw failure('检索任务不存在。', 404); }
    if (!saved || saved.id !== id || !fs.existsSync(path.join(dir, 'run_config.json'))) throw failure('检索任务记录不完整。', 404);
    if (saved.materialReplenishment || saved.replenishmentInvalid || fs.existsSync(path.join(dir, 'materials-basis.json'))) throw failure('材料补齐记录仅用于获取 PDF 和补充材料，不能导入候选或生成新的调研结果。');
    if (saved.segmentTask || saved.segmentInvalid || fs.existsSync(path.join(dir, 'segment-basis.json'))) throw failure('分段任务的文献和材料已冻结，不能导入候选或生成新的调研结果。');
    const live = this.scholar.jobs.get(id);
    if (saved.deletedAt || live?.deletedAt) throw failure('检索任务已删除，请先恢复。');
    if (saved.status === 'running' || live?.status === 'running' || live?.child || live?.browserOpening) {
      throw failure('检索任务正在运行，请完成或停止后再操作。');
    }
    const state = live || saved;
    if (importing && (state.processingBasis || fs.existsSync(path.join(dir, 'processing-basis.json')))) {
      throw failure('已有候选的后续处理快照已冻结；请回原检索任务补检或导入，再建立新的后续处理。');
    }
    if (importing && fs.existsSync(path.join(dir, 'confirmations.json'))) {
      throw failure('该任务已有提取字段确认，请另建同库任务导入，保留原结果。');
    }
    const confirmedImport = importing && state.config?.researchPlan && fs.existsSync(path.join(dir, 'research-basis.json'));
    if (!confirmedImport && !fs.existsSync(path.join(dir, 'candidates.json'))) throw failure('当前任务没有候选清单。');
    if (importing) {
      if (confirmedImport) {
        if (['extraction', 'validation', 'export', 'confirmations.json'].some(name => fs.existsSync(path.join(dir, name)))) throw failure('该任务已有提取或分析产物，请另建同库任务导入，保留原结果。');
        return live || this.scholar.loadPersisted(id);
      }
      const frozen = ['dedupe', 'fulltext', 'extraction', 'validation', 'export', 'research', 'confirmations.json']
        .some(name => fs.existsSync(path.join(dir, name)));
      if (state.status !== 'completed' || state.resumeStage !== 'dedupe' || state.stages?.discover !== 'done' || frozen) {
        throw failure('该任务已进入后续处理或检索尚未完成；请在新的仅检索任务中导入，原结果保留。');
      }
    }
    return live || this.scholar.loadPersisted(id);
  }
}

module.exports = { LiteratureAuxiliary };
