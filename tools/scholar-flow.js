'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function scholarConfig(run, query) {
  return { topic: query, query, sources: ['google-scholar'], publicationYearFrom: run.compiled.yearFrom,
    publicationYearTo: run.compiled.yearTo, geography: '', language: '', studyTypes: [],
    inclusion: run.compiled.include ? [run.compiled.include] : [], exclusion: run.compiled.exclude ? [run.compiled.exclude] : [],
    targetFields: run.compiled.fields, limit: 10 };
}
function candidatesFromScholar(report) {
  const safe = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; } };
  return (report.records || []).filter(p => p && p.title).slice(0, 10).map(p => {
    const url = safe(p.result_url), match = url.match(/10\.\d{4,9}\/[^?#]+/i);
    const doi = match ? decodeURIComponent(match[0]).toLowerCase() : '';
    const id = doi || 'scholar:' + createHash('sha256').update(String(p.title).toLowerCase()).digest('hex').slice(0, 16);
    const pdfs = (p.fulltext_links || []).filter(link => safe(link.url) && (/pdf/i.test(link.label) || /\.pdf(?:$|\?)/i.test(link.url))).map(link => ({ url: safe(link.url), name: createHash('sha256').update(id).digest('hex').slice(0, 12) + '.pdf' }));
    return { id, title: String(p.title), doi, pmcid: null, source: 'google-scholar', year: '', byline: String(p.byline || ''),
      abstract: '', snippet: String(p.snippet || ''), evidenceLevel: 'search_result_snippet', url, materialUrls: pdfs };
  });
}
async function scholarSearch(connector, { run, query, signal, save, progress, directory, pollMs = 350 }) {
  const config = scholarConfig(run, query), fingerprint = JSON.stringify(config);
  run.scholarQueries = run.scholarQueries || {};
  const entry = run.scholarQueries[query];
  let job;
  if (entry && entry.configKey === fingerprint) {
    const previous = connector.snapshot(entry.id);
    job = previous.status === 'completed' ? previous : connector.start(config, previous.status === 'needs_attention');
  } else job = connector.start(config);
  run.scholarQueries[query] = { id: job.id, configKey: fingerprint }; save();
  const stopped = () => { try { connector.cancel(job.id); } catch (_) {} };
  signal.addEventListener('abort', stopped, { once: true });
  try {
    let message = '';
    while (job.status === 'running') {
      if (signal.aborted) { stopped(); throw new Error('Scholar 检索已停止'); }
      if (job.message !== message) { message = job.message; progress('Google Scholar：' + message); }
      await new Promise(resolve => setTimeout(resolve, pollMs)); job = connector.snapshot(job.id);
    }
    if (signal.aborted) throw new Error('Scholar 检索已停止');
    if (job.status === 'needs_attention') return { attention: true, question: 'Google Scholar 需要人工验证。请在检索浏览器中自行完成验证，再点击“验证后继续执行”；无需重新审核方案。' };
    if (job.status !== 'completed') throw new Error(job.error || job.message || 'Scholar 检索未完成');
    const report = JSON.parse(fs.readFileSync(connector.download(job.id, 'candidates.json'), 'utf8'));
    const folder = path.join(directory, 'scholar', job.id); fs.mkdirSync(folder, { recursive: true });
    for (const name of ['run_config.json', 'candidates.json', 'candidates.csv']) {
      if (!job.files.includes(name)) continue;
      const source = connector.download(job.id, name), target = path.join(folder, name);
      if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      else if (!fs.readFileSync(target).equals(fs.readFileSync(source))) throw new Error('已归档的 Scholar 结果与源文件不一致，请保留记录并重新开始批次');
    }
    return { candidates: candidatesFromScholar(report), search: { source: 'google-scholar', query, url: report.search_url, at: report.retrieved_at, returned: report.count, appliedFilters: report.applied_filters, deferredRules: report.deferred_rules, files: 'scholar/' + job.id, note: '首批候选；片段不是已核实摘要或全文，纳排在下一步执行。' } };
  } finally { signal.removeEventListener('abort', stopped); }
}
module.exports = { scholarSearch, scholarConfig, candidatesFromScholar };
