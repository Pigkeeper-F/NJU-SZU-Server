'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 2 * 1024 ** 3;
const MAX_FILES = 300;
const INTERNAL_FILES = new Set(['run-state.json']);
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[i] = value >>> 0;
}

function within(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function safeName(name) {
  if (!name || name === '.' || name === '..' || /[\\/:\x00-\x1f]/.test(name) || name.endsWith('.') || name.endsWith(' ')) throw new Error('结果文件路径不安全，无法打包');
  if (name.startsWith('.') || /(?:^|[-_.])(?:credentials?|secrets?|tokens?|api[-_]?keys?|auth)(?:[-_.]|$)/i.test(name)) throw new Error('结果目录含隐藏文件或凭据文件，请检查后再打包');
  if (['input', 'reference', 'material'].includes(name.toLowerCase())) throw new Error('结果目录含输入或参考材料目录，无法作为本次结果打包');
}

function checkedDirectory(dir, boundary) {
  if (!within(boundary, dir)) throw new Error('结果目录超出当前任务范围');
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('结果目录不能使用符号链接或其他特殊文件');
  if (!within(fs.realpathSync(boundary), fs.realpathSync(dir))) throw new Error('结果目录超出当前任务范围');
}

function collectFiles(bridge, sessionId, runId, limits) {
  if (!UUID.test(sessionId || '') || !UUID.test(runId || '')) throw new Error('无效的任务或运行标识');
  if (bridge.active(sessionId)) throw new Error('当前任务正在执行，请等待完成后下载结果包');
  const root = path.resolve(bridge.root);
  const session = path.resolve(bridge.session(sessionId));
  if (session !== path.join(root, sessionId)) throw new Error('结果目录超出当前任务范围');
  checkedDirectory(session, root);
  const output = path.join(session, 'output');
  checkedDirectory(output, session);
  const run = path.join(output, runId);
  if (!fs.existsSync(run)) throw new Error('本次结果目录不存在，请刷新文件列表');
  checkedDirectory(run, output);
  const files = [];
  let totalBytes = 0, directoryCount = 0;
  function walk(dir, parts, depth) {
    if (depth > 32 || ++directoryCount > 1000) throw new Error('结果目录层级或数量过多，无法打包');
    checkedDirectory(dir, run);
    for (const name of fs.readdirSync(dir).sort()) {
      if (INTERNAL_FILES.has(name.toLowerCase())) continue;
      safeName(name);
      const filename = path.join(dir, name), stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error('结果目录含符号链接，无法安全打包');
      const relative = [...parts, name];
      if (stat.isDirectory()) { walk(filename, relative, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink > 1) throw new Error('结果目录含特殊文件或硬链接，无法安全打包');
      if (!within(run, fs.realpathSync(filename))) throw new Error('结果文件超出本次运行范围');
      const zipName = Buffer.from(relative.join('/'), 'utf8');
      if (zipName.length > 65535) throw new Error('结果文件路径过长，无法打包');
      if (stat.size > limits.bytes || (totalBytes += stat.size) > limits.bytes) throw new Error('结果文件或整包超过2GiB上限');
      files.push({ filename, zipName, stat });
      if (files.length > limits.files) throw new Error('本次结果超过300个文件，请分批下载');
    }
  }
  walk(run, [], 0);
  if (!files.length) throw new Error('本次运行没有可下载的结果文件');
  return { run, files };
}

function dosTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

async function writeZip(filename, run, files, limits, bridge, sessionId) {
  const target = await fs.promises.open(filename, 'wx', 0o600);
  let position = 0;
  const central = [];
  const write = async buffer => {
    if (position + buffer.length > limits.bytes) throw new Error('结果压缩包超过2GiB上限，请分批下载');
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await target.write(buffer, offset, buffer.length - offset);
      if (!bytesWritten) throw new Error('结果压缩包写入失败');
      offset += bytesWritten;
    }
    position += buffer.length;
  };
  try {
    for (const entry of files) {
      if (bridge.active(sessionId)) throw new Error('当前任务开始执行，请等待完成后再打包');
      // Recheck each parent and opened file so replacements cannot redirect packaging.
      let parent = path.dirname(entry.filename);
      while (within(run, parent)) {
        checkedDirectory(parent, run);
        if (parent === run) break;
        parent = path.dirname(parent);
      }
      const latest = fs.lstatSync(entry.filename);
      if (latest.isSymbolicLink() || !latest.isFile() || latest.nlink > 1 || latest.dev !== entry.stat.dev || latest.ino !== entry.stat.ino || latest.size !== entry.stat.size || latest.mtimeMs !== entry.stat.mtimeMs) throw new Error('结果文件已变化，请刷新后重新下载');
      const input = await fs.promises.open(entry.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const opened = await input.stat();
        if (!opened.isFile() || opened.dev !== latest.dev || opened.ino !== latest.ino || opened.size !== latest.size || opened.mtimeMs !== latest.mtimeMs) throw new Error('结果文件已变化，请刷新后重新下载');
        const offset = position, stamp = dosTime(opened.mtime);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0808, 6);
        local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12); local.writeUInt16LE(entry.zipName.length, 26);
        await write(local); await write(entry.zipName);
        let crc = 0xffffffff, size = 0;
        for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
          size += chunk.length;
          if (size > opened.size) throw new Error('结果文件已变化，请刷新后重新下载');
          for (let index = 0; index < chunk.length; index++) crc = CRC_TABLE[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8);
          await write(chunk);
        }
        const after = await input.stat();
        if (size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('结果文件已变化，请刷新后重新下载');
        crc = (crc ^ 0xffffffff) >>> 0;
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12);
        await write(descriptor);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0808, 8);
        record.writeUInt16LE(stamp.time, 12); record.writeUInt16LE(stamp.date, 14); record.writeUInt32LE(crc, 16);
        record.writeUInt32LE(size, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(entry.zipName.length, 28); record.writeUInt32LE(offset, 42);
        central.push(record, entry.zipName);
      } finally { await input.close(); }
    }
    const centralOffset = position;
    for (const record of central) await write(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(position - centralOffset, 12); end.writeUInt32LE(centralOffset, 16);
    await write(end); await target.sync();
    if (bridge.active(sessionId)) throw new Error('当前任务开始执行，请等待完成后再打包');
    return position;
  } finally { await target.close(); }
}

async function streamCleanResultsArchive(bridge, sessionId, runId, res, options = {}) {
  const limits = { bytes: Math.min(MAX_BYTES, options.maxBytes || MAX_BYTES), files: Math.min(MAX_FILES, options.maxFiles || MAX_FILES) };
  if (!Number.isSafeInteger(limits.bytes) || limits.bytes < 1 || !Number.isSafeInteger(limits.files) || limits.files < 1) throw new Error('无效的结果打包限制');
  const { run, files } = collectFiles(bridge, sessionId, runId, limits);
  const tempRoot = fs.realpathSync(options.tempRoot || os.tmpdir());
  const dir = await fs.promises.mkdtemp(path.join(tempRoot, 'yanxu-clean-results-'));
  const filename = path.join(dir, 'results.zip');
  try {
    const size = await writeZip(filename, run, files, limits, bridge, sessionId);
    if (res.destroyed) throw new Error('下载连接已关闭，请重新下载');
    const downloadName = '清洗结果_' + runId.slice(0, 8) + '.zip';
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size,
      'Content-Disposition': 'attachment; filename="clean-results-' + runId.slice(0, 8) + '.zip"; filename*=UTF-8\'\'' + encodeURIComponent(downloadName),
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    try { await pipeline(fs.createReadStream(filename), res); }
    catch (error) { res.destroy(error); }
  } finally {
    // Only this invocation's own file and empty directory may be removed.
    if (path.dirname(dir) !== tempRoot || !path.basename(dir).startsWith('yanxu-clean-results-') || path.dirname(filename) !== dir) throw new Error('临时结果包路径校验失败');
    await fs.promises.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.promises.rmdir(dir);
  }
}

module.exports = { streamCleanResultsArchive, MAX_BYTES, MAX_FILES };
