'use strict';

// This reports the current process, not the newer static files it may be serving.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const BACKEND_FILES = [
  'server.js',
  'tools/codex-bridge.js',
  'tools/codex-runtime.js',
  'tools/literature-common.py',
  'tools/literature-config.js',
  'tools/literature-connector.js',
  'tools/literature-extract.js',
  'tools/literature-flow.js',
  'tools/literature-runtime.js',
  'tools/literature-sources.js',
  'tools/literature-sources.json',
  'tools/literature_browser.py',
  'tools/literature_extra_sources.py',
  'tools/literature_pubmed.py',
  'tools/literature_search.py',
  'tools/literature_sources.py',
  'tools/literature_source_runner.py',
  'tools/literature_source_worker.py',
  'tools/literature_source_guard.py',
  'tools/literature_fulltext.py',
  'tools/literature_fulltext_browser.py',
  'tools/literature_fulltext_evidence.py',
  'tools/literature_extract.py',
  'tools/scholar-flow.js',
  'tools/source-download.js'
];

function normalizedRoot(root) {
  let result = path.resolve(root);
  try { result = fs.realpathSync(result); } catch (_) { /* A missing root still has a stable identity. */ }
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function workspaceIdFor(root) {
  return createHash('sha256').update(normalizedRoot(root)).digest('hex');
}

function backendFingerprint(root) {
  const directory = path.resolve(root);
  const hash = createHash('sha256');
  for (const relative of BACKEND_FILES) {
    hash.update(relative + '\0');
    try {
      const bytes = fs.readFileSync(path.join(directory, relative));
      hash.update(String(bytes.length) + '\0');
      hash.update(bytes);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('missing\0');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function createLiteratureRuntime({ root, port, isBusy = () => false }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('运行信息端口无效');
  if (typeof isBusy !== 'function') throw new Error('运行信息需要本地工作状态检查函数');
  const directory = path.resolve(root);
  // The absolute path resolves to the same cached module used by this server's connector.
  const { executableSources } = require(path.join(directory, 'tools', 'literature-sources.js'));
  const supportedSources = Object.freeze(executableSources().map(source => source.key));
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const workspaceId = workspaceIdFor(directory);
  const loadedFingerprint = backendFingerprint(directory);
  return {
    snapshot() {
      let restartRequired = true, busy = true;
      try { restartRequired = backendFingerprint(directory) !== loadedFingerprint; } catch (_) { /* Unreadable code is unsafe to reuse. */ }
      try { busy = Boolean(isBusy()); } catch (_) { /* Never advise a restart when work state is unknown. */ }
      return {
        protocolVersion: 1,
        instanceId,
        startedAt,
        pid: process.pid,
        port,
        workspaceId,
        loadedFingerprint,
        restartRequired,
        supportedSources: [...supportedSources],
        busy,
        browserSession: 'persistent-research-browser'
      };
    }
  };
}

module.exports = { workspaceIdFor, backendFingerprint, createLiteratureRuntime };
