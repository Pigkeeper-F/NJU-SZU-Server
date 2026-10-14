#!/usr/bin/env node
'use strict';

// Small local-only check for the direct-calculation backend. Creates an isolated session.
const base = process.env.WORKBENCH_URL || 'http://localhost:18125';
async function api(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { 'X-Workbench': '1', ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

async function main() {
  const { id: sessionId } = await api('/api/codex/session', { method: 'POST' });
  const source = [
    'import csv',
    'with open("smoke_input.csv", newline="", encoding="utf-8") as source:',
    '    rows = list(csv.DictReader(source))',
    'with open("smoke_output.csv", "w", newline="", encoding="utf-8") as target:',
    '    writer = csv.DictWriter(target, fieldnames=["item", "double_value"])',
    '    writer.writeheader()',
    '    for row in rows:',
    '        writer.writerow({"item": row["item"], "double_value": int(row["value"]) * 2})',
    ''
  ].join('\n');
  await api('/api/codex/upload?session=' + sessionId + '&name=smoke_model.py', { method: 'POST', body: source });
  await api('/api/codex/upload?session=' + sessionId + '&name=smoke_input.csv', { method: 'POST', body: 'item,value\na,2\nb,3\n' });
  const start = await api('/api/codex/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, module: { type: 'calculation', mode: 'direct' }, execute: true, model: 'gpt-6-luna', messages: [{ role: 'user', text: '运行唯一上传的 smoke_model.py，输入 smoke_input.csv。上传文件名有前缀，可复制到本次输出目录并恢复原文件名；不要修改 Python 源码。检查输出应为 a=4、b=6。' }] })
  });
  for (let attempt = 0; attempt < 180; attempt++) {
    const job = await api('/api/codex/job?id=' + start.id);
    if (job.status !== 'running') {
      console.log(JSON.stringify({ status: job.status, error: job.error, files: job.files.filter(file => file.group === 'output').map(file => file.name), text: job.text.slice(0, 1200) }, null, 2));
      if (job.status !== 'completed' || !job.files.some(file => file.group === 'output' && file.name.endsWith('/smoke_output.csv'))) process.exitCode = 1;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('计算检查超时');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
