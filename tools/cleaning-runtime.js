'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const preparing = new Map();

function pythonCall(python, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proxy = require('./source-download').proxyFor('https:');
    const child = spawn(python, args, { cwd: options.cwd, windowsHide: true,
      env: { ...process.env, ...(proxy ? {HTTPS_PROXY:proxy.href,HTTP_PROXY:proxy.href} : {}), PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }, signal: options.signal });
    let stdout = '', stderr = '', size = 0;
    const timer = setTimeout(() => child.kill(), options.timeout || 120000);
    child.stdout.on('data', data => { size += data.length; if (size > 8 * 1024 ** 2) child.kill(); else stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr || '清洗程序未完成（退出码 ' + code + '）')); });
  });
}

async function prepare(root, excel = false, progress = () => {}) {
  const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const base = process.env.WORKBENCH_PYTHON || (fs.existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3');
  if (!excel) { await pythonCall(base, ['-c', 'import sys; assert sys.version_info >= (3,10), "Python 3.10+ required"']); return base; }
  if (preparing.has(root)) return preparing.get(root);
  const work = (async () => {
    const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!fs.existsSync(python)) {
      progress('正在创建项目Python虚拟环境…');
      await pythonCall(base, ['-m', 'venv', path.join(root, '.venv')]);
    }
    try { await pythonCall(python, ['-c', 'import openpyxl,xlrd']); }
    catch (_) {
      progress('正在准备Excel读取依赖 openpyxl / xlrd…');
      await pythonCall(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(root, 'requirements-cleaning.txt')], { timeout: 600000 });
    }
    await pythonCall(python, ['-c', 'import sys,openpyxl,xlrd; assert sys.version_info >= (3,10)']);
    return python;
  })();
  preparing.set(root, work);
  try { return await work; } catch (error) { preparing.delete(root); throw error; }
}

module.exports = { prepare, pythonCall };
