'use strict';
/**
 * 文献调研环节（九步研究流程 · 环节①）的要点抽取与研究空白归纳。
 *
 * 与「文献挖掘」能力节点的区别：
 *   文献挖掘 = 为计算模块抽参数（字段口径是"这个参数多少、什么单位"）
 *   文献调研 = 为研究决策抽要点（字段口径是"这篇研究了什么、结论是什么、局限在哪"）
 * 两者共用检索 / 去重 / 全文的底层产物（candidates.json、fulltext/files/*.txt）。
 *
 * 产出（写在作业目录 research/ 下，与既有 dedupe/ fulltext/ extraction/ 同级）：
 *   research/notes.json      逐篇结构化要点
 *   research/notes.csv       同上，扁平表格
 *   research/synthesis.json  共识 / 分歧 / 研究空白（结构化）
 *   research/synthesis.md    同上，人读版
 *   research/gaps.json       研究空白清单
 *   research/gaps.md         同上，人读版
 *
 * 诚实性约束（契约见 docs/literature-research-workflow-draft.md）：
 *   只有题录（没有全文）的文献，其结论不得超出题录能支持的范围——产物里以 evidence 字段标出。
 */

const fs = require('fs');
const path = require('path');

const NOTES_BATCH = 3;        // 每次请求处理的篇数
const TEXT_CHARS = 4000;      // 每篇送进模型的正文字符上限
const SYNTHESIS_CHARS = 12000; // 送进综合调用的要点字符上限

const NOTE_FIELDS = ['question', 'data', 'method', 'conclusion', 'limitation'];

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((key) => csvCell(row[key])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function titleKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 解析模型输出里的 JSON（容忍 ```json 围栏与前后杂音）。 */
function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const start = raw.search(/[[{]/);
  if (start < 0) return null;
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch (error) { return null; }
      }
    }
  }
  return null;
}

/** 读检索阶段产物（candidates.json）。 */
function loadCandidates(jobDir) {
  const data = loadJson(path.join(jobDir, 'candidates.json'));
  if (!data) return null;
  const records = Array.isArray(data.records) ? data.records : [];
  return {
    meta: {
      source: data.source || '',
      query: data.query || '',
      search_url: data.search_url || '',
      retrieved_at: data.retrieved_at || '',
      count: data.count || records.length,
      scope: data.scope || '',
      caution: data.caution || ''
    },
    records
  };
}

/** 读全文阶段产物（fulltext/files/*.txt），按 candidate_id 或标题匹配回候选。 */
function collectFulltexts(jobDir, records) {
  const dir = path.join(jobDir, 'fulltext', 'files');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { entries = []; }
  const texts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.txt')) continue;
    let content = '';
    try { content = fs.readFileSync(path.join(dir, entry.name), 'utf8'); } catch (error) { continue; }
    texts.push({ stem: entry.name.replace(/\.txt$/i, ''), content });
  }
  const byStem = {};
  for (const item of texts) byStem[item.stem] = item.content;

  const matched = {};
  const used = {};
  for (const record of records) {
    const id = String(record.candidate_id || '');
    if (id && byStem[id] !== undefined && !used[id]) {
      matched[id] = byStem[id];
      used[id] = true;
      continue;
    }
    const key = titleKey(record.title);
    if (!key) continue;
    for (const item of texts) {
      if (used[item.stem]) continue;
      const head = titleKey(item.content.slice(0, 3000));
      if (head.includes(key) || key.includes(titleKey(item.content.slice(0, 3000)).slice(0, 40))) {
        matched[id] = item.content;
        used[item.stem] = true;
        break;
      }
    }
  }
  return { matched, total: texts.length, usedCount: Object.keys(used).length };
}

/** 组装送进模型的文献包。 */
function buildBundles(records, fulltexts) {
  return records.map((record) => {
    const id = String(record.candidate_id || '');
    const text = fulltexts.matched[id] || '';
    return {
      id,
      title: record.title || '',
      authors: record.authors || record.byline || '',
      year: record.year || '',
      venue: record.venue || '',
      doi: record.doi || '',
      source: record.source || '',
      query: record.query || '',
      retrieved_at: record.retrieved_at || '',
      snippet: record.snippet || '',
      hasFulltext: Boolean(text),
      text: text.slice(0, TEXT_CHARS)
    };
  });
}

function notesPrompt(bundles) {
  const payload = bundles.map((bundle) => ({
    id: bundle.id,
    title: bundle.title,
    authors: bundle.authors,
    year: bundle.year,
    venue: bundle.venue,
    doi: bundle.doi,
    source: bundle.source,
    evidence: bundle.hasFulltext ? '全文' : '仅题录',
    snippet: bundle.snippet ? bundle.snippet.slice(0, 800) : '',
    body: bundle.hasFulltext ? bundle.text : ''
  }));
  return [
    '你是科研文献调研助手。下面给出若干篇文献的题录与正文片段（evidence 标"仅题录"的没有正文）。',
    '请为每篇抽取结构化要点，严格输出一个 JSON 数组，每篇一个对象，字段：',
    '{"id": "原文 id", "question": "研究问题", "data": "数据来源", "method": "方法",',
    ' "conclusion": "结论", "limitation": "局限", "evidence": "全文|仅题录"}',
    '要求：',
    '1. 只依据给出的材料，不要补充材料里没有的信息；材料里没有的字段写"文中未说明"。',
    '2. evidence 为"仅题录"的文献，只能写题录能支持的内容（标题、作者、期刊、摘要片段），',
    '   不得推断方法细节、实验结果或结论——这是硬要求。',
    '3. id 必须与输入完全一致，顺序一致，不得增删条目。',
    '4. 只输出 JSON 数组，不要任何解释文字或代码围栏。',
    '',
    JSON.stringify(payload, null, 1)
  ].join('\n');
}

function synthesisPrompt(notes) {
  const brief = notes.map((note) => ({
    id: note.id,
    title: note.title,
    authors: note.authors,
    year: note.year,
    evidence: note.evidence,
    question: note.question,
    conclusion: note.conclusion,
    limitation: note.limitation
  }));
  return [
    '你是科研文献调研助手。下面是若干篇文献的结构化要点（evidence 标"仅题录"的结论可信度有限）。',
    '请做横向归纳，严格输出一个 JSON 对象：',
    '{',
    '  "consensus": [{"statement": "领域共识的一句话", "refs": ["id", ...]}],',
    '  "disagreements": [{"statement": "存在的分歧/争议", "refs": ["id", ...]}],',
    '  "gaps": [{"gap": "研究空白的具体描述",',
    '             "basis": [{"id": "...", "what": "该文献里指向这个空白的具体结论"}],',
    '             "direction": "可检验的研究方向"}]',
    '}',
    '要求：',
    '1. refs 与 basis.id 只能是输入中出现过的 id，且每条至少一个；写不出依据的条目不要写。',
    '2. gaps 必须能从上面的要点推出（basis 至少一条），不得凭空想象研究空白；',
    '   若确实推不出，把 gaps 设为空数组——空数组是允许的答案。',
    '3. 共识与分歧要如实反映文献间的差异，不要把个别论文的主张当成领域共识。',
    '4. 只输出 JSON 对象，不要解释文字。',
    '',
    JSON.stringify(brief, null, 1)
  ].join('\n');
}

function normalizeNote(raw, bundle) {
  const note = { id: bundle.id };
  for (const field of NOTE_FIELDS) {
    const value = raw && typeof raw[field] === 'string' ? raw[field].trim() : '';
    note[field] = value || '文中未说明';
  }
  note.evidence = bundle.hasFulltext ? '全文' : '仅题录';
  note.title = bundle.title;
  note.authors = bundle.authors;
  note.year = bundle.year;
  note.venue = bundle.venue;
  note.doi = bundle.doi;
  note.source = bundle.source;
  note.query = bundle.query;
  note.retrieved_at = bundle.retrieved_at;
  return note;
}

function collectRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean).slice(0, 12);
}

function renderGapsMd(gaps, notes) {
  const byId = {};
  for (const note of notes) byId[note.id] = note;
  const lines = ['# 研究空白清单', ''];
  if (!gaps.length) {
    lines.push('（本次未识别出可支撑的研究空白——这是如实结论，不硬凑。）');
    lines.push('');
    lines.push('可能原因：候选文献数量偏少、检索式过窄、或该方向已被充分研究。');
    return lines.join('\n');
  }
  gaps.forEach((gap, index) => {
    lines.push(`## ${index + 1}. ${gap.gap || '（未命名空白）'}`);
    lines.push('');
    lines.push(`- **可检验方向**：${gap.direction || '待明确'}`);
    lines.push('- **支撑依据**：');
    const basis = Array.isArray(gap.basis) ? gap.basis : [];
    if (!basis.length) {
      lines.push('  - （无——本条不应存在，产出时已过滤）');
    }
    for (const item of basis) {
      const note = byId[String(item.id)] || null;
      const cite = note ? `${note.title}（${note.authors || '作者未记录'}${note.year ? '，' + note.year : ''}）` : String(item.id);
      lines.push(`  - ${cite}：${item.what || ''}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

function renderSynthesisMd(synthesis) {
  const lines = ['# 综述要点（共识 / 分歧）', ''];
  lines.push('## 共识');
  if (synthesis.consensus.length) {
    for (const item of synthesis.consensus) {
      lines.push(`- ${item.statement}　（出处：${item.refs.join('、') || '—'}）`);
    }
  } else {
    lines.push('- （未归纳出可支撑的共识）');
  }
  lines.push('');
  lines.push('## 分歧');
  if (synthesis.disagreements.length) {
    for (const item of synthesis.disagreements) {
      lines.push(`- ${item.statement}　（出处：${item.refs.join('、') || '—'}）`);
    }
  } else {
    lines.push('- （未归纳出明显分歧）');
  }
  lines.push('');
  lines.push('> 完整的研究空白清单见 `gaps.md`；逐篇要点见 `notes.csv`。');
  return lines.join('\n');
}

/**
 * 跑一次文献调研（要点抽取 + 横向归纳）。
 * @param {object} options
 * @param {object} options.job        作业对象（需含 dir）
 * @param {object} options.modelCfg   模型配置（baseUrl / model / apiKey / protocol）
 * @param {Function} options.callModel (cfg, messages, timeoutMs) => Promise<string>
 * @param {Function} [options.onEvent]
 */
async function runResearchStage({ job, modelCfg, callModel, onEvent } = {}) {
  const jobDir = job && job.dir;
  if (!jobDir) throw new Error('缺少作业目录');
  if (typeof callModel !== 'function') throw new Error('缺少模型调用入口');

  const candidates = loadCandidates(jobDir);
  if (!candidates || !candidates.records.length) {
    throw new Error('该作业还没有检索候选（candidates.json 不存在或为空），请先完成首批检索。');
  }
  const fulltexts = collectFulltexts(jobDir, candidates.records);
  const bundles = buildBundles(candidates.records, fulltexts);
  if (onEvent) onEvent({ type: 'research:start', total: bundles.length, withFulltext: bundles.filter((b) => b.hasFulltext).length });

  const notes = [];
  const failures = [];
  for (let i = 0; i < bundles.length; i += NOTES_BATCH) {
    const batch = bundles.slice(i, i + NOTES_BATCH);
    let raw = null;
    try {
      const text = await callModel(modelCfg, [{ role: 'user', content: notesPrompt(batch) }], 180000);
      raw = parseJsonLoose(text);
    } catch (error) {
      failures.push({ batch: batch.map((b) => b.id), error: (error && error.message) || String(error) });
    }
    const list = Array.isArray(raw) ? raw : [];
    for (const bundle of batch) {
      const hit = list.find((item) => item && String(item.id) === bundle.id);
      notes.push(normalizeNote(hit, bundle));
    }
    if (onEvent) onEvent({ type: 'research:progress', done: notes.length, total: bundles.length });
  }

  // 横向归纳：要点太多时按字符上限截断，并在产物里写明被截断。
  let briefNotes = notes;
  let truncated = false;
  let briefText = JSON.stringify(briefNotes);
  if (briefText.length > SYNTHESIS_CHARS) {
    truncated = true;
    briefNotes = [];
    let used = 0;
    for (const note of notes) {
      const piece = JSON.stringify(note);
      if (used + piece.length > SYNTHESIS_CHARS) break;
      briefNotes.push(note);
      used += piece.length;
    }
    briefText = JSON.stringify(briefNotes);
  }

  let synthesis = { consensus: [], disagreements: [], gaps: [] };
  let synthesisError = null;
  try {
    const text = await callModel(modelCfg, [{ role: 'user', content: synthesisPrompt(briefNotes) }], 180000);
    const parsed = parseJsonLoose(text);
    if (parsed && typeof parsed === 'object') {
      synthesis = {
        consensus: (Array.isArray(parsed.consensus) ? parsed.consensus : [])
          .map((item) => ({ statement: String((item && item.statement) || ''), refs: collectRefs(item && item.refs) }))
          .filter((item) => item.statement),
        disagreements: (Array.isArray(parsed.disagreements) ? parsed.disagreements : [])
          .map((item) => ({ statement: String((item && item.statement) || ''), refs: collectRefs(item && item.refs) }))
          .filter((item) => item.statement),
        gaps: (Array.isArray(parsed.gaps) ? parsed.gaps : [])
          .map((item) => ({
            gap: String((item && item.gap) || ''),
            basis: (Array.isArray(item && item.basis) ? item.basis : [])
              .map((b) => ({ id: String((b && b.id) || ''), what: String((b && b.what) || '') }))
              .filter((b) => b.id),
            direction: String((item && item.direction) || '')
          }))
          .filter((item) => item.gap && item.basis.length)
      };
    } else {
      synthesisError = '综合归纳返回的不是可解析的 JSON';
    }
  } catch (error) {
    synthesisError = (error && error.message) || String(error);
  }

  const meta = {
    topic: (job.config && job.config.topic) || '',
    query: (job.config && job.config.query) || '',
    source: candidates.meta.source,
    search_url: candidates.meta.search_url,
    retrieved_at: candidates.meta.retrieved_at,
    candidate_count: candidates.records.length,
    with_fulltext: bundles.filter((b) => b.hasFulltext).length,
    only_title: bundles.filter((b) => !b.hasFulltext).length,
    synthesis_truncated: truncated,
    synthesis_input_notes: briefNotes.length,
    failures
  };

  const outDir = path.join(jobDir, 'research');
  const files = [];
  const notesFile = path.join(outDir, 'notes.json');
  writeJson(notesFile, { meta, notes });
  files.push('research/notes.json');

  const csvFile = path.join(outDir, 'notes.csv');
  writeText(csvFile, toCsv(notes, [
    'id', 'title', 'authors', 'year', 'venue', 'doi', 'source', 'evidence',
    'question', 'data', 'method', 'conclusion', 'limitation'
  ]));
  files.push('research/notes.csv');

  const synthesisFile = path.join(outDir, 'synthesis.json');
  writeJson(synthesisFile, { meta, ...synthesis, error: synthesisError });
  files.push('research/synthesis.json');

  const synthesisMd = path.join(outDir, 'synthesis.md');
  writeText(synthesisMd, renderSynthesisMd(synthesis));
  files.push('research/synthesis.md');

  const gapsFile = path.join(outDir, 'gaps.json');
  writeJson(gapsFile, { meta, gaps: synthesis.gaps, error: synthesisError });
  files.push('research/gaps.json');

  const gapsMd = path.join(outDir, 'gaps.md');
  writeText(gapsMd, renderGapsMd(synthesis.gaps, notes));
  files.push('research/gaps.md');

  if (onEvent) onEvent({ type: 'research:done', files, notes: notes.length, gaps: synthesis.gaps.length });

  return {
    ok: !synthesisError,
    meta,
    notes,
    synthesis,
    gaps: synthesis.gaps,
    files,
    error: synthesisError
  };
}

module.exports = { runResearchStage, parseJsonLoose, notesPrompt, synthesisPrompt, buildBundles };
