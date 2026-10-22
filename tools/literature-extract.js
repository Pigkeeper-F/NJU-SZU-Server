'use strict';

// 文献挖掘 extract 阶段的 Node 半：把逐篇 bundle 经 CodexBridge 交给本机 Codex 提取，
// 再把结果原子写入 extraction/<paper_id>.json，最后调用 Python 侧 --check 收口。
// 契约：docs/literature-mining-stage2-design.md §1.4 / §2.4.4 / §3.2 / §3.6 / §9.5。
// 说明：模型只能拿到消息文本（不依赖文件工具），因此 bundle 全文以消息形式传入。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TOP_KEYS = ['paper_id', 'source_pdf', 'status', 'classification_reason', 'rows', 'warnings', 'skip_reason'];
const INSTRUCTIONS_VERSION = 'extract-contract-v1';
const DEFAULT_TOTAL_BUDGET_SEC = 1800;
const PER_PAPER_TIMEOUT_MS = 600000;
const PYTHON_STEP_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 800;

const EXTRACT_INSTRUCTIONS = [
  '你是文献参数提取器（文献挖掘·提取阶段）。只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 围栏。',
  '',
  '【输出契约】顶层必须是恰好这 7 个键：',
  'paper_id, source_pdf, status, classification_reason, rows, warnings, skip_reason',
  '- paper_id：必须等于输入给出的 paper_id（也是文件名 stem）。',
  '- source_pdf：HTML 稿写 <paper_id>.txt，PDF 稿写 <paper_id>.pdf（由输入 fulltext.path 给出）。',
  '- status：ok（已有报告值行）/ partial（有报告值行但重要字段缺失）/ skipped（无可用报告值）。skipped 必须给出非空 skip_reason。',
  '- classification_reason：为何纳入抽取或跳过（一句话）。',
  '- rows：数组，每个「一个有出处的报告值」一行，键为：',
  '  row_id（<paper_id>-R001 递增）, field, value_raw, unit_raw, value_normalized, unit_normalized,',
  '  conversion, evidence {where, quote}, conditions {…}, provenance',
  '  · field 必须取自输入 field_definitions 的 key，不得自造字段；',
  '  · evidence.where（页码/表号/小节）与 evidence.quote（≤300 字原文摘录）至少一项非空——这是可追溯性的硬要求；',
  '  · 若报告值来自补充材料，evidence.where 必须写出材料文件名及页码/工作表/单元格/Word表格等实际位置；不得把附件数据写成正文来源。',
  '  · value_normalized 仅在按文中给出的规则做单位换算后填写；没有换算就照抄原值，unit_normalized 与 unit_raw 相同；',
  '  · conversion 无换算时为 null，有换算时写明规则；',
  '  · conditions 只填输入 condition_keys 中给出的键（原文可得才填）。',
  '- warnings：数组，记录无法完成的字段与原因。',
  '',
  '【溯源标记格式（冻结）】仅图表读数行与计算行需要填写 provenance，其余留空字符串：',
  '- 图表读数行：provenance = "figure-extracted from {Fig ID} {chart type}"',
  '- 计算行：provenance = "calculated: {formula}"',
  '',
  '【禁推断】不得做以下任何推断或换算，违反即视为错误输出：',
  '1) 不得从地名推断坐标；2) 不得据站点名查气候数据；3) 不得由土类推断质地；',
  '4) 不得由处理缩写推断施肥量；5) 不得由有机肥名称推断 C/N 或 pH；',
  '6) 未给出换算规则时不得把 SOM 折算为 SOC；7) 不得把 POC/MAOC 当作 SOC；',
  '8) 无标定数字化的肉眼读图值不得直接当已提取值（应写进 warnings）。',
  '',
  '【材料状态】补充材料按原格式读取后的文本与位置见材料清单。missing、needs_attention、unreadable、unsupported 的材料不能假装已经读取；partial 或 truncated 只代表当前提供的部分内容。材料未齐或不可读必须写入 warnings，不得宣称全文与补充材料均已核查。',
  '【降级】只有正文及所有材料都没有可用内容时才输出 status="skipped" 并说明原因；正文 degraded 但补充表格有真实报告值时可从该材料提取，明确来源及未完成部分。',
].join('\n');

function readEffectiveSchema(jobDir) {
  const file = path.join(jobDir, 'confirmations.json');
  if (!fs.existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
  const records = Array.isArray(data?.records) ? data.records : [];
  let latest = null;
  for (const record of records) {
    if (record && record.kind === 'fieldDefinitions' && Array.isArray(record.fields)) latest = record;
  }
  return latest ? { fields: latest.fields, at: latest.at || '' } : null;
}

function buildExtractPrompt(bundle) {
  const fulltext = bundle.fulltext || {};
  const sections = [
    EXTRACT_INSTRUCTIONS,
    ['【本次文献】',
      `paper_id: ${bundle.paper_id}`,
      `title: ${bundle.title || ''}`,
      `doi: ${bundle.doi || ''}`,
      `source_url: ${bundle.source_url || ''}`,
      `source_pdf: ${fulltext.kind === 'pdf' ? `${bundle.paper_id}.pdf` : `${bundle.paper_id}.txt`}`,
      `instructions_version: ${bundle.instructions_version || INSTRUCTIONS_VERSION}`,
    ].join('\n'),
    '【已确认字段定义】（field 只能取这里的 key）\n' + JSON.stringify(bundle.field_definitions || [], null, 2),
    '【条件键 condition_keys】' + JSON.stringify(bundle.condition_keys || []),
    `【正文】kind=${fulltext.kind || ''} chars=${fulltext.chars || 0} truncated=${fulltext.truncated ? 'true' : 'false'}` +
      (bundle.degraded ? `\n【降级标记】${bundle.degraded.reason || ''}` : ''),
    String(fulltext.text || ''),
    '【材料完整性与可读性】\n' + JSON.stringify(bundle.materials_check || { manifest_present: false, supplement_check: { status: 'uninspected' } }, null, 2),
    '【同篇原始材料及读取结果】（content_ref=fulltext 的正文见上文；其余只使用实际提供的内容和位置）\n' + JSON.stringify(Array.isArray(bundle.materials) ? bundle.materials : [], null, 2),
  ];
  return sections.join('\n\n');
}

function parseExtractionJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    body = fence[1].trim();
  } else {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) body = body.slice(start, end + 1);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  for (const key of TOP_KEYS) if (!(key in data)) return null;
  if (typeof data.paper_id !== 'string' || typeof data.status !== 'string' || !Array.isArray(data.rows)) return null;
  return data;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) { try { fs.unlinkSync(temporary); } catch (_) {} }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function pythonStep({ python, script, config, jobDir, extraArgs = [], onEvent, cwd, timeoutMs = PYTHON_STEP_TIMEOUT_MS }) {
  return new Promise(resolve => {
    const args = ['-u', script, '--config', config, '--output-dir', jobDir, ...extraArgs];
    const child = spawn(python, args, {
      cwd,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    const events = [];
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(null, '提取阶段子进程超时');
    }, timeoutMs);
    function finish(code, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, error, events, stderr: stderr.trim() });
    }
    function consume(line) {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch (_) {
        return;
      }
      events.push(event);
      if (event.type === 'stage' && typeof onEvent === 'function') onEvent(event);
      if (event.type === 'attention' && typeof onEvent === 'function') onEvent(event);
    }
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > 200000) buffer = '';
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    child.on('error', error => finish(null, error.message));
    child.on('close', code => {
      consume(buffer);
      finish(code, code === 0 ? null : `阶段脚本退出码 ${code}`);
    });
  });
}

function lastEvent(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === type) return events[index];
  }
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function awaitBridge(bridge, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = bridge.snapshot(jobId);
    if (!snapshot || snapshot.status !== 'running') return snapshot;
    if (Date.now() >= deadline) {
      try { await bridge.cancel(jobId); } catch (_) {}
      return { ...snapshot, status: 'timeout', error: '单篇提取超时' };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function degradedResult(bundle, reason) {
  const fulltext = bundle.fulltext || {};
  const source = fulltext.path || (fulltext.kind === 'pdf' ? `${bundle.paper_id}.pdf` : `${bundle.paper_id}.txt`);
  return {
    paper_id: bundle.paper_id,
    source_pdf: source,
    status: 'skipped',
    classification_reason: '待补充：未获得可用的提取结果',
    rows: [],
    warnings: [reason],
    skip_reason: reason,
  };
}

function skeletonUsable(data, paperId) {
  return !!data && data.paper_id === paperId && Array.isArray(data.rows);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function bundledInputs(jobDir) {
  const inputsDir = path.join(jobDir, 'extraction', 'inputs');
  if (!fs.existsSync(inputsDir)) return [];
  return fs.readdirSync(inputsDir).filter(name => name.endsWith('.json')).sort();
}

// bundle 的字段定义与当前有效 schema 不一致 → 需要 --force 重建并重跑该篇（§2.4.4/§4.4）。
function staleBundles(jobDir, schema) {
  const stale = [];
  for (const name of bundledInputs(jobDir)) {
    const bundle = readJson(path.join(jobDir, 'extraction', 'inputs', name));
    if (!bundle || !Array.isArray(bundle.field_definitions)) continue;
    if (JSON.stringify(canonical(bundle.field_definitions)) !== JSON.stringify(canonical(schema.fields))) {
      stale.push(path.basename(name, '.json'));
    }
  }
  return stale;
}

async function runExtractStage({ bridge, jobDir, config, python, onEvent, sessionId = null } = {}) {
  const emitEvent = typeof onEvent === 'function' ? onEvent : () => {};
  const fail = message => {
    emitEvent({ type: 'error', message });
    return { ok: false, extracted: 0, skipped: 0, error: message };
  };
  if (!bridge || !jobDir || !python) return fail('提取阶段缺少必要参数（bridge/jobDir/python）');
  const root = path.resolve(__dirname, '..');
  const configPath = path.join(jobDir, 'run_config.json');
  const schema = readEffectiveSchema(jobDir);
  if (!schema) {
    emitEvent({
      type: 'attention', stage: 'awaiting_confirmation',
      message: '提取前需由研究者确认主题参数字段含义与单位；确认后点击继续。',
    });
    return { ok: false, paused: true, extracted: 0, skipped: 0 };
  }

  const prepareStale = staleBundles(jobDir, schema);
  const prepare = await pythonStep({
    python, script: path.join(root, 'tools', 'literature_extract.py'), config: configPath, jobDir,
    extraArgs: prepareStale.length ? ['--prepare', '--force'] : ['--prepare'], onEvent: emitEvent, cwd: root,
  });
  const prepareError = lastEvent(prepare.events, 'error');
  if (prepare.error || prepareError) return fail(prepareError?.message || prepare.error || '提取输入包生成失败');

  const inputsDir = path.join(jobDir, 'extraction', 'inputs');
  const bundles = bundledInputs(jobDir);
  const model = config && typeof config === 'object' && config.extraction && typeof config.extraction === 'object' ? config.extraction.model || null : null;
  const limits = config && typeof config === 'object' && config.limits && typeof config.limits === 'object' ? config.limits : {};
  const totalBudgetMs = (Number.isFinite(limits.extract) && limits.extract > 0 ? limits.extract : DEFAULT_TOTAL_BUDGET_SEC) * 1000;
  const deadline = Date.now() + totalBudgetMs;
  const session = sessionId || (typeof bridge.createSession === 'function' ? bridge.createSession().id : 'literature-mining');

  let extracted = 0;
  let skipped = 0;
  const written = [];
  for (const name of bundles) {
    const paperId = path.basename(name, '.json');
    const bundle = readJson(path.join(inputsDir, name));
    if (!bundle || !bundle.paper_id) { skipped += 1; continue; }
    const outputPath = path.join(jobDir, 'extraction', `${paperId}.json`);
    const existing = readJson(outputPath);
    if (!prepareStale.length && skeletonUsable(existing, paperId)) {  // §4.4 resume：结果已存在且骨架可用 → 不重复调用模型
      extracted += 1;
      written.push(`extraction/${paperId}.json`);
      continue;
    }
    const text = String(bundle.fulltext?.text || '');
    if (!text.trim() || bundle.degraded) {
      writeJsonAtomic(outputPath, degradedResult(bundle, bundle.degraded?.reason || '全文正文为空，待补充'));
      skipped += 1;
      written.push(`extraction/${paperId}.json`);
      continue;
    }
    if (Date.now() >= deadline) {
      writeJsonAtomic(outputPath, degradedResult(bundle, '提取阶段超时，未完成（待补充）'));
      skipped += 1;
      written.push(`extraction/${paperId}.json`);
      continue;
    }
    let reply = null;
    let failure = null;
    try {
      const started = await bridge.run(session, [{ role: 'user', content: buildExtractPrompt(bundle) }],
        EXTRACT_INSTRUCTIONS, false, model, 'literature-mining', null);
      const remaining = Math.max(1000, Math.min(PER_PAPER_TIMEOUT_MS, deadline - Date.now()));
      const snapshot = await awaitBridge(bridge, started.id, remaining);
      if (snapshot?.status === 'completed') reply = parseExtractionJson(snapshot.text);
      else failure = snapshot?.error || (snapshot?.status === 'timeout' ? '单篇提取超时' : '模型未返回可解析的提取 JSON');
      if (!reply && !failure) failure = '模型未返回可解析的提取 JSON';
      if (reply && reply.paper_id !== paperId) failure = `模型返回的 paper_id（${reply.paper_id}）与输入不一致`;
    } catch (error) {
      failure = error.message || String(error);
    }
    if (reply && !failure) {
      writeJsonAtomic(outputPath, reply);
      extracted += 1;
    } else {
      writeJsonAtomic(outputPath, degradedResult(bundle, `待补充：${failure || '提取失败'}`));
      skipped += 1;
    }
    written.push(`extraction/${paperId}.json`);
  }

  const check = await pythonStep({
    python, script: path.join(root, 'tools', 'literature_extract.py'), config: configPath, jobDir,
    extraArgs: ['--check'], onEvent: emitEvent, cwd: root,
  });
  const checkError = lastEvent(check.events, 'error');
  if (check.error || checkError) return fail(checkError?.message || check.error || '提取结果校验未通过');

  const inputFiles = bundles.map(name => `extraction/inputs/${name}`);
  let message = `提取完成：${extracted} 篇已提取`;
  if (skipped) message += `，${skipped} 篇标为待补充`;
  emitEvent({
    type: 'result', stage: 'extraction', message,
    count: extracted,
    counts: { bundles: bundles.length, extracted, skipped },
    files: [...inputFiles, ...written, 'extraction/check_report.json'],
  });
  return { ok: true, extracted, skipped, bundles: bundles.length, sessionId: session };
}

module.exports = { EXTRACT_INSTRUCTIONS, buildExtractPrompt, parseExtractionJson, runExtractStage };
