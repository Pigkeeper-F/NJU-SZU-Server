'use strict';
/**
 * 研究前端的两块语义能力（九步研究流程 · 环节① 的冷启动 + 环节② 的问题凝练）。
 *
 *   planQueries()     选题冷启动：模糊想法 → 检索维度 → 候选检索式（环节①入口）
 *   buildCandidates() 文献空白 → 候选科学问题（环节②的第一次交互）
 *   buildSpecification() 选定的候选问题 → 结构化「科学问题说明书」（环节②的第二次交互）
 *
 * 设计原则（与师兄的分工一致）：
 *   - 机器负责把判断的素材准备好（检索式、候选问题、依据、可行性初判）；
 *   - 人的判断不可替代（选哪条检索式、选哪个问题），所以每一步都把依据摊开给人看。
 *   - 硬约束：所有依据必须来自输入材料，不得虚构文献 id 或空白条目。
 *
 * 纯逻辑模块：模型调用由调用方注入（服务端传 callModel），便于 mock 回归。
 */

const fs = require('fs');
const path = require('path');
const registry = require('./literature-sources');

const MAX_GAPS = 12;
const MAX_NOTES = 40;

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return null; }
}

/** 读作业目录里的调研产物（环节①的输出），供环节②使用。 */
function loadResearchOutputs(jobDir) {
  const notes = loadJson(path.join(jobDir, 'research', 'notes.json'));
  const gaps = loadJson(path.join(jobDir, 'research', 'gaps.json'));
  const synthesis = loadJson(path.join(jobDir, 'research', 'synthesis.json'));
  return {
    notes: (notes && Array.isArray(notes.notes)) ? notes.notes : [],
    gaps: (gaps && Array.isArray(gaps.gaps)) ? gaps.gaps : [],
    consensus: (synthesis && Array.isArray(synthesis.consensus)) ? synthesis.consensus : [],
    disagreements: (synthesis && Array.isArray(synthesis.disagreements)) ? synthesis.disagreements : [],
    topic: (notes && notes.meta && notes.meta.topic) || ''
  };
}

/** 把 json 包裹（可能是代码围栏）解出来。 */
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


/**
 * 判定一条"检索式"是否合格：不含 JSON 噪声、长度合理、像检索式。
 * 免费模型经常不按格式输出（把整个 JSON 片段塞进 query 字段），不校验就会把
 * 一串 JSON 碎片原样渲染到界面上——所以这里要挡一道。
 */
function looksLikeQuery(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 8 || text.length > 600) return false;
  if (text.indexOf('{') >= 0 || text.indexOf('}') >= 0) return false;
  if (text.indexOf('": "') >= 0 || text.indexOf('":"') >= 0) return false;
  if (text.indexOf('":') >= 0 && text.indexOf('"') >= 0) return false;
  return /[A-Za-z一-龥]/.test(text);
}

/** 从模型原文里抠出检索式（JSON 解析失败时的兜底，手工扫描避免复杂正则） */
function salvageQueries(rawText) {
  const found = [];
  const text = String(rawText || '');
  const key = '"query"';
  let at = 0;
  while (found.length < 5) {
    const k = text.indexOf(key, at);
    if (k < 0) break;
    const colon = text.indexOf(':', k + key.length);
    if (colon < 0) break;
    const q1 = text.indexOf('"', colon);
    if (q1 < 0) break;
    let out = '';
    let i = q1 + 1;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (ch === String.fromCharCode(92)) { out += text.charAt(i + 1) || ''; i += 2; continue; }
      if (ch === '"') break;
      out += ch;
      i += 1;
    }
    const value = out.split(String.fromCharCode(10)).join(' ').trim();
    if (looksLikeQuery(value)) found.push(value);
    at = i + 1;
  }
  return found;
}

/** 从模型原文里按行抠出"像检索式"的行（最后一道兜底） */
function salvageByLine(rawText) {
  const found = [];
  const lines = String(rawText || '').split(String.fromCharCode(10));
  const lead = '-*.、)0123456789';
  for (const line of lines) {
    let value = line.trim();
    if (value.length > 1 && lead.indexOf(value.charAt(0)) >= 0) value = value.slice(1).trim();
    if (value.length > 1 && (value.charAt(0) === '"' || value.charAt(0) === "'" || value.charAt(0) === '`')) {
      value = value.slice(1);
    }
    if (value.length > 1 && (value.charAt(value.length - 1) === '"' || value.charAt(value.length - 1) === "'" || value.charAt(value.length - 1) === '`')) {
      value = value.slice(0, value.length - 1);
    }
    value = value.trim();
    const hasLogic = value.indexOf(' AND ') >= 0 || value.indexOf(' OR ') >= 0 || value.indexOf('"') >= 0;
    if (looksLikeQuery(value) && hasLogic && found.indexOf(value) < 0) found.push(value);
    if (found.length >= 5) break;
  }
  return found;
}

/** 清洗说明文字：去掉控制字符、压缩空白、限长 */
function cleanNote(value, maxLen) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out += (code < 32) ? ' ' : value.charAt(i);
  }
  const parts = out.split(' ').filter(function (part) { return part.length > 0; });
  return parts.join(' ').slice(0, maxLen || 300);
}

function asList(value, limit) {
  const out = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (out.length >= limit) break;
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) out.push(text);
    } else if (item && typeof item === 'object') {
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 环节① · 选题冷启动
// ---------------------------------------------------------------------------

//: 各来源的检索语法差异。写进提示词，避免模型把 Scholar 的语法照搬给所有源。
const SOURCE_SYNTAX = {
  'google-scholar': 'Google Scholar：短语用双引号，OR / AND 连接，必要时加括号',
  'pubmed': 'PubMed：用字段标签，如 "soil organic carbon"[Title/Abstract] AND fertilization[Title/Abstract]；也可用 MeSH Terms',
  'pmc': 'PMC：与 PubMed 相同（NCBI E-utilities），用 [Title/Abstract] 等字段标签',
  'openalex': 'OpenAlex：自然语言关键词（检索标题/摘要全文），不要写字段标签或大括号',
  'europe-pmc': 'Europe PMC：可用 TITLE_ABS:"..."、AUTH:"..." 等字段，AND / OR 连接',
  'semantic-scholar': 'Semantic Scholar：自然语言关键词，支持 + | 等简单连接，不要写字段标签'
};

function normalizePlanSources(sources) {
  const requested = Array.isArray(sources) ? sources.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const executable = registry.executableSources().map((item) => item.key);
  const picked = requested.filter((key, index) => executable.indexOf(key) >= 0 && requested.indexOf(key) === index);
  return picked.length ? picked : ['google-scholar'];
}

function planPrompt(idea, sources) {
  const lines = [
    '你是科研选题助手。用户给出一个**可能还很模糊**的研究想法，请帮���把它变成可执行的文献检索。',
    '',
    '请输出 JSON：',
    '{',
    '  "dimensions": [{"name": "检索维度名", "keywords": ["同义词/上下位词", "..."]}],',
    '  "queries": [{"query": "通用检索式（Google Scholar 语法）", "rationale": "为什么这样检索、能捞到什么"}],',
    '  "perSource": [{"source": "来源 key", "query": "该来源能直接执行的检索式", "rationale": "该源的检索意图"}]',
    '}',
    '',
    '要求：',
    '1. dimensions 给 3–5 个维度，每个维度 3–6 个关键词或同义词。',
    '2. queries 给 3 条不同角度的检索式：一条宽口径（覆盖该方向主要工作）、一条聚焦方法、',
    '   一条聚焦具体对象/场景。每条要说明检索意图。',
    '3. perSource 必须覆盖下列每一个目标来源，每个来源一条、按该来源自己的语法写；',
    '   不要把一条检索式原样复制给所有来源。各源语法：'
  ];
  for (const key of sources) {
    lines.push('   - ' + key + '（' + ((registry.sourceOf(key) && registry.sourceOf(key).label) || key) + '）：' + (SOURCE_SYNTAX[key] || '自然语言关键词'));
  }
  lines.push(
    '4. 不要编造具体文献或结果；这里只负责把想法转成检索。',
    '5. 只输出 JSON。',
    '',
    '目标来源：' + sources.join('、'),
    '研究想法：' + idea
  );
  return lines.join('\n');
}

async function planQueries({ idea, sources, callModel, modelCfg } = {}) {
  const text = String(idea || '').trim();
  if (!text) throw new Error('请先写下你的研究想法（哪怕只有一句话）');
  if (typeof callModel !== 'function') throw new Error('缺少模型调用入口');
  const targets = normalizePlanSources(sources);
  const reply = await callModel(modelCfg, [{ role: 'user', content: planPrompt(text, targets) }], 120000);
  const parsed = parseJsonLoose(reply);
  const dimensions = (parsed && typeof parsed === 'object')
    ? asList(parsed.dimensions, 6).map((item) => ({
      name: cleanNote((item && item.name) || '', 60),
      keywords: asList(item && item.keywords, 8).map((k) => cleanNote(String(k), 40))
    })).filter((item) => item.name)
    : [];
  let queries = (parsed && typeof parsed === 'object')
    ? asList(parsed.queries, 5).map((item) => ({
      query: cleanNote((item && item.query) || '', 600),
      rationale: cleanNote((item && item.rationale) || '', 300)
    })).filter((item) => looksLikeQuery(item.query))
    : [];
  // 模型没按格式输出时的兜底：先正则抠，再按行抠
  if (!queries.length) {
    const salvaged = salvageQueries(reply);
    if (salvaged.length) queries = salvaged.map((q) => ({ query: q, rationale: '' }));
  }
  if (!queries.length) {
    const byLine = salvageByLine(reply);
    if (byLine.length) queries = byLine.map((q) => ({ query: q, rationale: '' }));
  }
  if (!queries.length) throw new Error('选题拆解没有给出可用的检索式（模型输出无法解析）');
  // 按来源分化的检索计划：模型可能漏源或写错源，这里按本次目标来源收敛。
  let perSource = (parsed && typeof parsed === 'object' && Array.isArray(parsed.perSource))
    ? asList(parsed.perSource, 10).map((item) => ({
      source: cleanNote(String((item && item.source) || ''), 60),
      query: cleanNote((item && item.query) || '', 600),
      rationale: cleanNote((item && item.rationale) || '', 300)
    })).filter((item) => targets.indexOf(item.source) >= 0 && looksLikeQuery(item.query))
    : [];
  const seenSources = new Set();
  perSource = perSource.filter((item) => {
    if (seenSources.has(item.source)) return false;
    seenSources.add(item.source);
    return true;
  });
  for (const key of targets) {
    if (!seenSources.has(key)) {
      perSource.push({
        source: key,
        query: queries[0].query,
        rationale: '模型未单列该来源，沿用通用检索式；可在界面上改写'
      });
    }
  }
  return { idea: text, dimensions, queries, sources: targets, perSource };
}

// ---------------------------------------------------------------------------
// 环节② · 候选科学问题
// ---------------------------------------------------------------------------

function gapsBrief(gaps) {
  return asList(gaps, MAX_GAPS).map((gap, index) => ({
    index: index + 1,
    gap: String(gap.gap || ''),
    direction: String(gap.direction || ''),
    basis: asList(gap.basis, 4).map((b) => ({ id: String(b.id || ''), what: String(b.what || '') }))
  }));
}

function notesBrief(notes) {
  return asList(notes, MAX_NOTES).map((note) => ({
    id: String(note.id || ''),
    title: String(note.title || ''),
    authors: String(note.authors || ''),
    year: note.year || '',
    evidence: String(note.evidence || ''),
    question: String(note.question || ''),
    conclusion: String(note.conclusion || ''),
    limitation: String(note.limitation || '')
  }));
}

function candidatesPrompt(idea, gaps, notes) {
  return [
    '你是科研选题助手。下面是研究想法、文献调研得出的研究空白清单（每条含支撑依据）、以及已读文献的要点。',
    '请提出 **3–5 个候选科学问题**——不是把所有空白都变成问题，而是挑出「值得做、且做得动」的那几个。',
    '',
    '输出 JSON 数组，每个元素：',
    '{',
    '  "statement": "一句话研究问题",',
    '  "hypothesis": "可检验的假设（可证伪的表述）",',
    '  "variables": ["关键变量"],',
    '  "boundary": "研究边界条件（对象范围、时空尺度、适用条件）",',
    '  "gapRefs": ["对应空白的原文"],',
    '  "basis": [{"id": "文献 id", "what": "该文献里支持这个问题的具体结论"}],',
    '  "feasibility": "可行性初判：需要什么数据与方法、可能卡在哪、能否被证伪"',
    '}',
    '',
    '硬要求：',
    '1. gapRefs 必须是输入里空白的原文；basis.id 必须是输入里出现过的文献 id。不得虚构。',
    '2. 每个问题至少对应一条空白、至少一条文献依据；写不出依据的条目不要写。',
    '3. 变量与边界要具体到能操作，不要写「效果」「影响」这类无法测量的词。',
    '4. 若输入材料不足以支撑任何问题，返回空数组——这是允许的答案。',
    '5. 只输出 JSON 数组。',
    '',
    '【研究想法】' + String(idea || ''),
    '',
    '【研究空白】',
    JSON.stringify(gapsBrief(gaps), null, 1),
    '',
    '【文献要点】',
    JSON.stringify(notesBrief(notes), null, 1)
  ].join('\n');
}

function normalizeCandidate(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const statement = String(raw.statement || '').trim();
  if (!statement) return null;
  return {
    id: 'Q' + (index + 1),
    statement,
    hypothesis: String(raw.hypothesis || '').trim(),
    variables: asList(raw.variables, 8).map(String),
    boundary: String(raw.boundary || '').trim(),
    gapRefs: asList(raw.gapRefs, 6).map(String),
    basis: asList(raw.basis, 6).map((item) => ({
      id: String((item && item.id) || ''),
      what: String((item && item.what) || '')
    })).filter((item) => item.id),
    feasibility: String(raw.feasibility || '').trim()
  };
}

async function buildCandidates({ idea, gaps, notes, callModel, modelCfg } = {}) {
  if (typeof callModel !== 'function') throw new Error('缺少模型调用入口');
  if (!asList(gaps, 1).length) throw new Error('没有研究空白可用——先完成文献调研环节（环节①）。');
  const reply = await callModel(modelCfg, [{ role: 'user', content: candidatesPrompt(idea, gaps, notes) }], 180000);
  const parsed = parseJsonLoose(reply);
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.candidates) ? parsed.candidates : []);
  const candidates = [];
  let dropped = 0;
  for (const item of list) {
    const candidate = normalizeCandidate(item, candidates.length);
    // 硬要求：每个候选至少对应一条空白、至少一条文献依据。
    // 提示词里已经要求过，但模型的输出不能全信——没有依据的条目在这里直接丢掉。
    if (!candidate) { dropped += 1; continue; }
    if (!candidate.gapRefs.length || !candidate.basis.length) { dropped += 1; continue; }
    candidates.push(candidate);
    if (candidates.length >= 5) break;
  }
  return { idea: String(idea || ''), candidates, dropped };
}

// ---------------------------------------------------------------------------
// 环节② · 问题说明书
// ---------------------------------------------------------------------------

function specificationPrompt(idea, candidate, gaps, notes) {
  return [
    '你是科研选题助手。请把选定的候选科学问题展开成一份「科学问题说明书」，',
    '它要作为后续环节（数据获取与清洗、方法选择与运行、图表绘制、文章撰写）的输入契约。',
    '',
    '必须用 Markdown 二级标题分出这些小节，标题照抄：',
    '## 研究问题',
    '## 可检验形式',
    '## 研究对象与关键变量',
    '## 边界条件',
    '## 与文献空白的对应',
    '## 可行性初判',
    '## 预期贡献',
    '',
    '要求：',
    '1. 只依据给定材料；材料里没有的写「待明确」，不要编造数据、方法或文献。',
    '2. 每条论断标明依据（文献 id 或空白编号），让下游能回溯。',
    '3. 「可检验形式」要写清什么结果算支持、什么结果算否定。',
    '4. 不要写「结果显著」这类空话；写不出来的部分直接标「待明确」。',
    '',
    '【研究想法】' + String(idea || ''),
    '',
    '【选定的候选问题】',
    JSON.stringify(candidate, null, 1),
    '',
    '【研究空白】',
    JSON.stringify(gapsBrief(gaps), null, 1),
    '',
    '【文献要点】',
    JSON.stringify(notesBrief(notes), null, 1)
  ].join('\n');
}

async function buildSpecification({ idea, candidate, gaps, notes, callModel, modelCfg } = {}) {
  if (typeof callModel !== 'function') throw new Error('缺少模型调用入口');
  if (!candidate || !candidate.statement) throw new Error('缺少选定的候选问题');
  const reply = await callModel(modelCfg, [{ role: 'user', content: specificationPrompt(idea, candidate, gaps, notes) }], 180000);
  const text = String(reply || '').trim();
  if (!text) throw new Error('模型没有返回问题说明书');
  return {
    markdown: text,
    candidate,
    writtenAt: new Date().toISOString()
  };
}

module.exports = {
  planQueries,
  buildCandidates,
  buildSpecification,
  loadResearchOutputs,
  parseJsonLoose,
  planPrompt,
  candidatesPrompt,
  specificationPrompt
};
