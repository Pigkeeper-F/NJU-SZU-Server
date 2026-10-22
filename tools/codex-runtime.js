'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

// Prefer the desktop runtime that supplies the current account's model catalog.
// Keep explicit overrides and the npm/PATH fallback for standalone installs.
function resolveCodexBin({ env = process.env, platform = process.platform, arch = process.arch, home = os.homedir() } = {}) {
  if (typeof env.CODEX_BIN === 'string' && env.CODEX_BIN.trim()) return env.CODEX_BIN.trim();
  if (platform === 'darwin') {
    const desktop = '/Applications/ChatGPT.app/Contents/Resources/codex';
    if (isFile(desktop)) return desktop;
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const directory = path.join(local, 'OpenAI', 'Codex', 'bin');
    let candidates = [];
    try {
      candidates = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(directory, entry.name, 'codex.exe'))
        .filter(isFile)
        .map(file => ({ file, modified: fs.statSync(file).mtimeMs }))
        .sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
    } catch (_) { /* Desktop is optional. */ }
    if (candidates.length) return candidates[0].file;
    const direct = path.join(directory, 'codex.exe');
    if (isFile(direct)) return direct;
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const nativeRoot = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-' + arch, 'vendor', target);
    for (const folder of ['bin', 'codex']) {
      const npm = path.join(nativeRoot, folder, 'codex.exe');
      if (isFile(npm)) return npm;
    }
  }
  return 'codex';
}

function readLocalLoginStatus(binary) {
  return new Promise(resolve => {
    const child = spawn(binary, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let text = '', settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(null); }, 5000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { text = (text + chunk.toString('utf8')).slice(-2000); });
    child.on('error', () => finish(null));
    child.on('close', code => finish(code === 0 && /Logged in using ChatGPT/i.test(text) ? 'chatgpt' : null));
  });
}

module.exports = { resolveCodexBin, readLocalLoginStatus };
