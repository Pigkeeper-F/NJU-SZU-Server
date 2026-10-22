'use strict';

// 来源注册表（设计 §7）：单一真相 = literature-sources.json，JS/Python 共用读取。
// state: 'executable'（可进入执行链）| 'registered'（已登记、明确拒绝）。
// access: 'browser'（浏览器自动化）| 'api'（开放 API，无人工）| 'manual'（人工检索后导入清单）。

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_PATH = path.join(__dirname, 'literature-sources.json');
const SOURCES = loadSources();

//: 冻结的拒绝文案（与 literature_sources.py REJECT_TEMPLATE 逐字一致；契约 §21 不回归）。
const REJECT_TEMPLATE = '尚未接通以下检索来源：{sources}；请明确改为仅检索 Google Scholar，或等待相应连接器。';

function loadSources() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`来源注册表不可读：${REGISTRY_PATH}（${error.message}）`);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.sources)) throw new Error(`来源注册表格式不正确：${REGISTRY_PATH}`);
  return data.sources.filter(item => item && typeof item === 'object' && typeof item.key === 'string' && item.key);
}

function listSources() {
  return SOURCES.map(item => ({ ...item }));
}

function isKnown(key) {
  return SOURCES.some(item => item.key === key);
}

function stateOf(key) {
  const item = SOURCES.find(candidate => candidate.key === key);
  return item ? item.state : null;
}

function sourceOf(key) {
  const item = SOURCES.find(candidate => candidate.key === key);
  return item ? { ...item } : null;
}

function executableSources() {
  return SOURCES.filter(item => item.state === 'executable');
}

function manualSources() {
  return SOURCES.filter(item => item.access === 'manual');
}

//: 候选清单 id 前缀（GSC / PMD / PMC / OAX / EPMC…）。
function idPrefixOf(key) {
  const item = SOURCES.find(candidate => candidate.key === key);
  return item && typeof item.idPrefix === 'string' ? item.idPrefix : '';
}

//: 适配器描述（kind ∈ soc-script / open-api）。
function adapterOf(key) {
  const item = SOURCES.find(candidate => candidate.key === key);
  return item && item.adapter && typeof item.adapter === 'object' ? { ...item.adapter } : {};
}

//: 接入方式（browser / api / manual）。
function accessOf(key) {
  const item = SOURCES.find(candidate => candidate.key === key);
  return item && typeof item.access === 'string' ? item.access : '';
}

//: 未接通来源的拒绝原因。
function reasonOf(key) {
  const item = SOURCES.find(candidate => candidate.key === key);
  return item && typeof item.reason === 'string' ? item.reason : '';
}

//: 人工来源的操作步骤。
function manualStepsOf(key) {
  const item = SOURCES.find(candidate => candidate.key === key);
  return item && Array.isArray(item.manualSteps) ? item.manualSteps.map(step => String(step)) : [];
}

//: 未接通来源的补充说明（原因 + 人工接入步骤）。
function unconnectedDetails(sources) {
  const lines = [];
  for (const key of (Array.isArray(sources) ? sources : [])) {
    const reason = reasonOf(key);
    const steps = manualStepsOf(key);
    if (!reason && !steps.length) continue;
    const label = (sourceOf(key) || {}).label || key;
    lines.push(`· ${label}：${reason || '尚未接通'}`);
    for (const step of steps) lines.push(`    - ${step}`);
  }
  return lines.join('\n');
}

function assertExecutable(sources) {
  const available = new Set(executableSources().map(item => item.key));
  const unavailable = (Array.isArray(sources) ? sources : []).filter(source => !available.has(source));
  if (unavailable.length) throw new Error(`尚未接通以下检索来源：${unavailable.join('、')}；请选择已接通来源，或等待相应连接器。`);
  return true;
}

module.exports = {
  SOURCES, listSources, isKnown, stateOf, executableSources, manualSources,
  sourceOf, idPrefixOf, adapterOf, accessOf, reasonOf, manualStepsOf,
  unconnectedDetails, assertExecutable
};
