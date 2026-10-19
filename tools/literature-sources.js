'use strict';

// 来源注册表（设计 §7）：单一真相 = literature-sources.json，JS/Python 共用读取。
// state: 'executable'（可进入执行链）| 'registered'（已登记、明确拒绝）。

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_PATH = path.join(__dirname, 'literature-sources.json');
const SOURCES = loadSources();

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

function executableSources() {
  return SOURCES.filter(item => item.state === 'executable');
}

function assertExecutable(sources) {
  const available = new Set(executableSources().map(item => item.key));
  const unavailable = (Array.isArray(sources) ? sources : []).filter(source => !available.has(source));
  if (unavailable.length) throw new Error(`尚未接通以下检索来源：${unavailable.join('、')}；请选择已接通来源，或等待相应连接器。`);
  return true;
}

module.exports = { SOURCES, listSources, isKnown, stateOf, executableSources, assertExecutable };
