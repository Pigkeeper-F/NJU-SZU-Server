#!/usr/bin/env node
'use strict';

// Isolated check that modification creates a new code/result version and keeps uploads untouched.
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
    body: JSON.stringify({ sessionId, module: { type: 'calculation', mode: 'modify' }, execute: true, model: 'gpt-6-luna', messages: [
      { role: 'user', text: '研究者已确认的修改规则 v1：将 smoke_model.py 中 double_value 的计算从乘以 2 改为乘以 3；保留其他逻辑和输出字段不变。' },
      { role: 'user', text: '请按上述已确认规则复制并修改代码，然后运行上传的 smoke_input.csv。原上传代码不覆盖。检查新输出 a=6、b=9，保存修改后代码、结果与变更说明。' }
    ] })
  });
  for (let attempt = 0; attempt < 180; attempt++) {
    const job = await api('/api/codex/job?id=' + start.id);
    if (job.status !== 'running') {
      console.log(JSON.stringify({ status: job.status, error: job.error, files: job.files.filter(file => file.group === 'output' && file.name.startsWith(start.id)).map(file => file.name), text: job.text.slice(0, 1600) }, null, 2));
      if (job.status !== 'completed' || !job.files.some(file => file.group === 'output' && file.name === start.id + '/smoke_output.csv')) process.exitCode = 1;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('修改计算检查超时');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
