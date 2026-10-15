'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
const { createHash } = require('node:crypto');
const MAX_BYTES = 20 * 1024 * 1024;
const TYPES = new Set(['.csv', '.tsv', '.xlsx', '.xls', '.json', '.txt', '.zip', '.pdf', '.xml', '.md']);
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
let systemProxy = null, proxyCheckedAt = 0;

function proxyFor(protocol) {
  // Reuse the user's network configuration; never store proxy credentials in reports.
  const configured = process.env.SOURCE_DOWNLOAD_PROXY || (protocol === 'https:' ? process.env.HTTPS_PROXY : process.env.HTTP_PROXY);
  if (configured) return new URL(configured);
  if (process.platform !== 'win32') return null;
  if (Date.now() - proxyCheckedAt > 60000) {
    proxyCheckedAt = Date.now(); systemProxy = null;
    try {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const enabled = execFileSync('reg.exe', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled)) {
        const value = execFileSync('reg.exe', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
        systemProxy = value.match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1].trim() || null;
      }
    } catch (_) { /* No configured system proxy: connect directly. */ }
  }
  if (!systemProxy) return null;
  const address = systemProxy.includes('=') ? systemProxy.split(';').find(part => part.startsWith(protocol.slice(0, -1) + '='))?.split('=')[1] : systemProxy;
  return address ? new URL(address.includes('://') ? address : 'http://' + address) : null;
}
function proxyAgent(target, proxy, signal) {
  if (proxy.protocol !== 'http:' || proxy.username || proxy.password) throw new Error('下载代理目前支持无认证的 HTTP 代理，请检查网络配置');
  const agent = new (target.protocol === 'https:' ? https.Agent : http.Agent)();
  agent.createConnection = (_settings, done) => {
    const ip = target.resolvedAddresses[0].address;
    const authority = (net.isIP(ip) === 6 ? '[' + ip + ']' : ip) + ':' + (target.port || (target.protocol === 'https:' ? 443 : 80));
    // CONNECT to the validated IP, rather than letting the proxy resolve the source again.
    const connect = http.request({ hostname: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: authority, signal, headers: { Host: authority } });
    connect.once('error', done);
    connect.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); done(new Error('下载代理连接失败：HTTP ' + response.statusCode)); return; }
      if (head.length) socket.unshift(head);
      if (target.protocol === 'http:') { done(null, socket); return; }
      const secure = tls.connect({ socket, servername: net.isIP(target.hostname) ? undefined : target.hostname, rejectUnauthorized: true });
      const failed = error => done(error);
      secure.once('error', failed);
      secure.once('secureConnect', () => { secure.removeListener('error', failed); done(null, secure); });
    });
    connect.end();
  };
  return agent;
}

function privateAddress(value) {
  let ip = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(ip) === 6) ip = new URL('http://[' + ip + ']').hostname.slice(1, -1);
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19);
  }
  if (net.isIP(ip) === 6) {
    if (ip.startsWith('::ffff:')) {
      const mapped = ip.slice(7);
      if (net.isIP(mapped) === 4) return privateAddress(mapped);
      const parts = mapped.split(':');
      if (parts.length === 2) { const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16); return privateAddress([n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.')); }
      return true;
    }
    return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip) || ip.startsWith('ff');
  }
  return true;
}
async function validateSource(raw, lookup = dns.lookup) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请提供无需登录凭据的 HTTP(S) 文件地址');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('不能下载本机或私网地址');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error('不能下载本机或私网地址');
  url.resolvedAddresses = addresses.map(item => ({ address: item.address, family: net.isIP(item.address) }));
  return url;
}
async function publicFetch(raw, options, lookup) {
  const target = await validateSource(raw, lookup);
  const proxy = proxyFor(target.protocol);
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    const request = client.get(target, {
      signal: options.signal,
      ...(proxy ? { agent: proxyAgent(target, proxy, options.signal) } : {}),
      // Pin the validated DNS answer, including when Node requests all addresses.
      lookup: (_host, settings, done) => {
        if (settings.all) return done(null, target.resolvedAddresses);
        const address = target.resolvedAddresses.find(item => !settings.family || item.family === settings.family) || target.resolvedAddresses[0];
        done(null, address.address, address.family);
      }
    }, response => {
      response.cancel = async () => { response.destroy(); };
      resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: { get: name => response.headers[name.toLowerCase()] || null }, body: response });
    });
    request.once('error', reject);
  });
}
async function fetchSource(source, options = {}) {
  const lookup = options.lookup || dns.lookup;
  const fetcher = options.fetch || ((raw, settings) => publicFetch(raw, settings, lookup));
  let url = await validateSource(source.url, lookup);
  let name = source.name || decodeURIComponent(path.basename(url.pathname));
  if (typeof name !== 'string' || !name || name.length > 180 || /[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name) || !TYPES.has(path.extname(name).toLowerCase())) throw new Error('请填写 CSV、TSV、Excel、JSON、TXT、ZIP 或 PDF 文件名');
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  const timer = setTimeout(() => controller.abort(), 30000);
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const signal = controller.signal;
  try {
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetcher(url.href, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error('下载地址跳转异常');
    url = await validateSource(new URL(location, url).href, lookup);
  }
  if (!response.ok) throw new Error('下载失败：HTTP ' + response.status);
  if (/text\/html/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); throw new Error('该地址返回网页，请提供实际文件下载地址'); }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('文件超过 20MB，请另行获取原始文件'); }
  if (!response.body) throw new Error('下载文件为空');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) { await response.body.cancel().catch(() => {}); throw new Error('文件超过 20MB'); }
    chunks.push(Buffer.from(chunk));
  }
  if (!size) throw new Error('下载文件为空');
  const data = Buffer.concat(chunks);
  return { name, size, data, finalUrl: url.href, sha256: createHash('sha256').update(data).digest('hex') };
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
module.exports = { fetchSource, validateSource, privateAddress, MAX_BYTES, proxyFor };
