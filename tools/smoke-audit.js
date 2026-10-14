#!/usr/bin/env node
'use strict';

// Read-only audit of an existing isolated calculation session.
const sessionId = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(sessionId || '')) throw new Error('Provide a calculation session id');
const base = process.env.WORKBENCH_URL || 'http://localhost:18125';
async function api(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { 'X-Workbench': '1', ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}
async function main() {
  const start = await api('/api/codex/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, module: { type: 'result-audit' }, execute: false, model: 'gpt-6-luna', messages: [{ role: 'user', text: '只读核查上一次计算的 smoke_output.csv：核对 a 和 b 两行的 double_value，说明依据的运行目录。不要修改文件。' }] })
  });
  for (let attempt = 0; attempt < 180; attempt++) {
    const job = await api('/api/codex/job?id=' + start.id);
    if (job.status !== 'running') {
      console.log(JSON.stringify({ status: job.status, error: job.error, text: job.text.slice(0, 1800) }, null, 2));
      if (job.status !== 'completed' || !job.text.includes('4') || !job.text.includes('6')) process.exitCode = 1;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('核查检查超时');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
