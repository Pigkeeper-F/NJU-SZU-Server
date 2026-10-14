'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { normalizeConfig } = require('./literature-config');

const ID = /^[a-f0-9-]{36}$/;
const DELIVERABLES = new Set(['candidates.json', 'candidates.csv', 'run_config.json']);

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, windowsHide: true });
    if (options.job) options.job.child = child;
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(new Error('准备检索环境超时'));
    }, options.timeout || 180000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.job?.child === child) options.job.child = null;
      if (error) reject(error); else resolve(output.trim());
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-3000); });
    }
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? null : new Error(output.trim() || `命令退出码 ${code}`)));
  });
}

async function findPython(root) {
  const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  const candidates = [process.env.WORKBENCH_PYTHON, 'python3', 'python', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', bundled].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const result = await runCommand(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3, 10)))'], { cwd: root, timeout: 5000 });
      if (result === '1') return candidate;
    } catch (_) { /* Try the next installed interpreter. */ }
  }
  throw new Error('未找到 Python 3.10+。请安装后重试，或设置 WORKBENCH_PYTHON 指向可用解释器。');
}

async function preparePython(root, job, progress) {
  const venv = path.join(root, '.venv');
  const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const marker = path.join(venv, '.literature-ready');
  if (fs.existsSync(python) && fs.existsSync(marker)) return python;
  progress('environment', '准备 Python 虚拟环境与 Chromium（首次运行可能较久）');
  if (!fs.existsSync(python)) {
    const base = await findPython(root);
    await runCommand(base, ['-m', 'venv', venv], { cwd: root, timeout: 120000, job });
  }
  await runCommand(python, ['-m', 'pip', 'install', '-r', path.join(root, 'requirements-literature.txt')], { cwd: root, timeout: 300000, job });
  await runCommand(python, ['-m', 'playwright', 'install', 'chromium'], { cwd: root, timeout: 300000, job });
  fs.writeFileSync(marker, new Date().toISOString() + '\n');
  return python;
}

function runSearchProcess(root, job, python, onEvent) {
  return new Promise((resolve, reject) => {
    const script = path.join(root, 'tools', 'literature_search.py');
    const args = ['-u', script, '--config', path.join(job.dir, 'run_config.json'), '--output-dir', job.dir];
    if (job.resumeCurrent) args.push('--scrape-current');
    const child = spawn(python, args, {
      cwd: root, env: process.env, windowsHide: true
    });
    job.child = child;
    let buffer = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(new Error('检索超过 3 分钟，已停止；如遇验证请手动完成后重试。'));
    }, 180000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (job.child === child) job.child = null;
      if (error) reject(error); else resolve();
    }
    function consume(line) {
      if (!line.trim()) return;
      try { onEvent(JSON.parse(line)); } catch (_) { stderr = '检索脚本返回了无效状态'; }
    }
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > 100000) buffer = '';
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      consume(buffer);
      finish(code === 0 ? null : new Error(job.error || stderr || `检索脚本退出码 ${code}`));
    });
  });
}

class LiteratureConnector {
  constructor(root, options = {}) {
    this.root = root;
    this.base = path.join(root, '.workbench', 'literature');
    this.jobs = new Map();
    this.prepare = options.prepare || ((job, progress) => preparePython(root, job, progress));
    this.search = options.search || ((job, python, onEvent) => runSearchProcess(root, job, python, onEvent));
  }

  public(job) {
    return { id: job.id, status: job.status, stage: job.stage, message: job.message,
      count: job.count, config: job.config, files: job.files, events: job.events, error: job.error };
  }

  persist(job) {
    fs.mkdirSync(job.dir, { recursive: true });
    fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(this.public(job), null, 2) + '\n');
  }

  update(job, stage, message) {
    job.stage = stage;
    job.message = message;
    job.events.push({ at: new Date().toISOString(), stage, message });
    job.events = job.events.slice(-30);
    this.persist(job);
  }

  start(rawConfig, resumeCurrent = false) {
    const config = normalizeConfig(rawConfig, { executable: true });
    if ([...this.jobs.values()].some(job => job.status === 'running')) throw new Error('已有文献检索正在运行，请等待或停止后重试');
    const id = randomUUID();
    const job = { id, dir: path.join(this.base, id), config, resumeCurrent: resumeCurrent === true, status: 'running', stage: 'queued',
      message: '任务已排队', count: 0, files: ['run_config.json'], events: [], error: null, child: null };
    this.jobs.set(id, job);
    fs.mkdirSync(job.dir, { recursive: true });
    fs.writeFileSync(path.join(job.dir, 'run_config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    this.update(job, 'queued', '准备首批候选检索');
    void this.run(job);
    return this.public(job);
  }

  async run(job) {
    try {
      const python = await this.prepare(job, (stage, message) => this.update(job, stage, message));
      if (job.status !== 'running') return;
      await this.search(job, python, event => {
        if (job.status !== 'running' || !event || typeof event !== 'object') return;
        if (event.type === 'stage') this.update(job, String(event.stage || 'running'), String(event.message || '正在处理'));
        if (event.type === 'attention') {
          job.status = 'needs_attention';
          this.update(job, 'verification', String(event.message || '需要人工完成浏览器验证'));
        }
        if (event.type === 'error') {
          job.error = String(event.message || '检索失败');
          job.status = 'failed';
          this.update(job, 'failed', job.error);
        }
        if (event.type === 'result') {
          job.count = Number.isInteger(event.count) ? event.count : 0;
          job.files = ['run_config.json', ...(Array.isArray(event.files) ? event.files : [])].filter(name => DELIVERABLES.has(name) && fs.existsSync(path.join(job.dir, name)));
          job.status = 'completed';
          this.update(job, 'completed', String(event.message || `已保存 ${job.count} 条候选`));
        }
      });
      if (job.status === 'running') {
        job.status = 'failed'; job.error = '检索脚本未返回结果'; this.update(job, 'failed', job.error);
      }
    } catch (error) {
      if (job.status === 'cancelled') return;
      job.status = 'failed'; job.error = error.message;
      this.update(job, 'failed', job.error);
    }
  }

  snapshot(id) {
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const live = this.jobs.get(id);
    if (live) return this.public(live);
    const file = path.join(this.base, id, 'job.json');
    if (!fs.existsSync(file)) throw new Error('检索任务不存在');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.status === 'running') {
      saved.status = 'failed'; saved.stage = 'interrupted';
      saved.error = '本地服务已重启，检索中断；已保存的文件仍可下载。';
      saved.files = [...DELIVERABLES].filter(name => fs.existsSync(path.join(this.base, id, name)));
    }
    return saved;
  }

  download(id, name) {
    const job = this.snapshot(id);
    if (!DELIVERABLES.has(name) || !job.files.includes(name)) throw new Error('结果文件不存在');
    const file = path.join(this.base, id, name);
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('结果文件不可下载');
    return file;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') throw new Error('检索任务未在运行');
    job.status = 'cancelled';
    if (job.child) { try { job.child.kill('SIGTERM'); } catch (_) {} }
    this.update(job, 'cancelled', '检索已停止；持久浏览器保持打开');
    return this.public(job);
  }
}

module.exports = { LiteratureConnector };
