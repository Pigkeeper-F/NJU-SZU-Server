'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const dns = require('node:dns').promises;
const { publicFetch, validateSource } = require('./source-download');
const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function officialUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'bulks-faostat.fao.org' || url.port || url.username || url.password || !url.pathname.startsWith('/production/')) throw new Error('官方整包地址必须属于 FAOSTAT 官方下载主机');
  return url.href;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function writeJson(file, value) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
async function transferFile(raw, file, options = {}) {
  const checkUrl = value => options.official ? officialUrl(value) : new URL(value).href;
  raw = checkUrl(raw);
  const lookup = options.lookup || dns.lookup;
  const fetcher = options.fetch || ((url, settings) => publicFetch(url, settings, lookup));
  const maxBytes = options.maxBytes || MAX_ARCHIVE_BYTES;
  const sidecar = file + '.transfer.json';
  const prior = readJson(sidecar);
  let offset = 0;
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('下载暂存路径不可用');
    if (prior?.source === raw && (prior.etag || prior.lastModified)) offset = fs.statSync(file).size;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let idle;
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new Error('下载超过90秒没有收到数据，请检查网络并继续原任务')), 90000); };
  touch();
  let response, handle, url = raw;
  try {
    const headers = offset ? { Range: 'bytes=' + offset + '-', 'If-Range': prior.etag || prior.lastModified } : {};
    for (let redirects = 0; redirects <= 5; redirects++) {
      checkUrl(url); await validateSource(url, lookup);
      response = await fetcher(url, { headers, signal: controller.signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location'); await response.body?.cancel?.();
      if (!location || redirects === 5) throw new Error('官方压缩包跳转异常');
      url = checkUrl(new URL(location, url).href);
    }
    if (!response.ok || ![200, 206].includes(response.status)) throw new Error('官方压缩包下载失败：HTTP ' + response.status);
    if (/text\/html/i.test(response.headers.get('content-type') || '') || options.requireZip && /application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('该地址未返回所需文件，请检查数据源');
    const etag = response.headers.get('etag'), lastModified = response.headers.get('last-modified');
    let totalBytes = Number(response.headers.get('content-length')) || null;
    if (response.status === 206) {
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(response.headers.get('content-range') || '');
      if (!offset || !match || Number(match[1]) !== offset || Number(match[2]) + 1 !== Number(match[3]) || (prior.etag && etag && prior.etag !== etag)) throw new Error('官方续传响应与已有文件不匹配，未拼接文件');
      totalBytes = Number(match[3]);
    } else offset = 0;
    if (offset >= maxBytes || totalBytes && totalBytes > maxBytes) throw new Error('官方压缩包超过2GiB上限');
    if (!response.body) throw new Error('官方压缩包内容为空');
    const disk = fs.statfsSync(require('node:path').dirname(file));
    if (Number(disk.bavail) * Number(disk.bsize) < (totalBytes || 512 * 1024 ** 2) - offset + 128 * 1024 ** 2) throw new Error('磁盘空间不足，原文件保留');
    writeJson(sidecar, { source: raw, finalUrl: url, etag, lastModified, totalBytes });
    handle = await fs.promises.open(file, offset ? 'a' : 'w');
    let bytes = offset;
    options.onProgress?.({ bytes, totalBytes, resumedBytes: offset });
    for await (const chunk of response.body) {
      touch();
      if (controller.signal.aborted) throw controller.signal.reason || new Error('下载已停止');
      bytes += chunk.byteLength;
      if (bytes > maxBytes || totalBytes && bytes > totalBytes) throw new Error('下载字节超过声明大小或2GiB上限');
      const buffer = Buffer.from(chunk); let written = 0;
      while (written < buffer.length) written += (await handle.write(buffer, written, buffer.length - written)).bytesWritten;
      options.onProgress?.({ bytes, totalBytes, resumedBytes: offset });
    }
    await handle.sync(); await handle.close(); handle = null;
    if (!bytes || totalBytes && bytes !== totalBytes) throw new Error('官方压缩包未下载完整，保留断点以便继续');
    const signature = Buffer.alloc(4), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, signature, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (options.requireZip && !signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('下载内容不是有效ZIP压缩包');
    return { size: bytes, sha256: await hashFile(file), finalUrl: url, etag, lastModified, resumedBytes: offset };
  } finally {
    clearTimeout(idle); options.signal?.removeEventListener('abort', abort);
    await handle?.close().catch(() => {});
    await response?.body?.cancel?.().catch(() => {});
  }
}
const transferArchive = (raw, file, options = {}) => transferFile(raw, file, { ...options, official: true, requireZip: true });
module.exports = { transferFile, transferArchive, hashFile, officialUrl, readJson, writeJson, MAX_ARCHIVE_BYTES };
