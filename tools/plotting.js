'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const prepares = new Map();
const DATA = /\.(csv|tsv|xlsx|xls|json|txt)$/i;
const CODE = /\.(py|r|jl|m|ipynb)$/i;
const PLAN = 'approved-plot-plan.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function rasterType(file) {
  const ext = path.extname(file).toLowerCase();
  if (!fs.statSync(file).size || fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('预览文件为空或超过20MB');
  const fd = fs.openSync(file, 'r'), bytes = Buffer.alloc(12);
  try { fs.readSync(fd, bytes, 0, 12, 0); } finally { fs.closeSync(fd); }
  if (ext === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (['.jpg','.jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (ext === '.webp' && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  throw new Error('该文件不是可预览的PNG/JPEG/WebP图片');
}
function readRecord(bridge, session, id) {
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('无效绘图版本');
  return JSON.parse(fs.readFileSync(path.join(bridge.session(session), '.plots', id + '.json'), 'utf8'));
}
function freezePlan(bridge, session, value) {
  if (!value || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 12000 || !Number.isSafeInteger(value.version) || value.version < 1) throw new Error('请先审核通过绘图方案');
  if (!Array.isArray(value.inputNames) || !value.inputNames.length || value.inputNames.length > 30) throw new Error('请先上传并选择绘图数据');
  const inputFiles = [...new Set(value.inputNames)].map(name => {
    if (typeof name !== 'string' || !DATA.test(name)) throw new Error('请选择有效的绘图数据文件');
    const file = bridge.download(session, 'input', name);
    if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('绘图数据超过20MB');
    return { name, size: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) };
  });
  if (value.previousRunId) readRecord(bridge, session, value.previousRunId);
  return { text: value.text.trim(), version: value.version, planHash: hash(value.text.trim()), inputFiles, previousRunId: value.previousRunId || null };
}
function saveRecord(bridge, job) {
  const records = path.join(bridge.session(job.sessionId), '.plots');
  fs.mkdirSync(records, { recursive:true });
  const file = path.join(records, job.id + '.json');
  const value = { id: job.id, status: job.status, createdAt: job.createdAt, finishedAt: job.status === 'running' ? null : new Date().toISOString(), planVersion: job.plotPlan.version, planHash: job.plotPlan.planHash, model: job.model || null, previousRunId: job.plotPlan.previousRunId, inputFiles: job.plotPlan.inputFiles, error: job.error || null };
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file);
}
function outputFiles(bridge,session,id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效绘图版本');
  const output=path.join(bridge.session(session),'output'), base=path.join(output,id), result=[];
  if (!fs.existsSync(base)) return result;
  if (!fs.realpathSync(base).startsWith(fs.realpathSync(output)+path.sep)) throw new Error('绘图文件不可访问');
  const walk=(directory,prefix='',depth=0)=>{
    if(depth>8 || result.length>=300)return;
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory())walk(path.join(directory,entry.name),prefix+entry.name+'/',depth+1);
      else if(entry.isFile() && !entry.name.endsWith('.tmp'))result.push({group:'output',name:id+'/'+prefix+entry.name,size:fs.statSync(path.join(directory,entry.name)).size});
      if(result.length>=300)break;
    }
  };walk(base);return result;
}
function runs(bridge, session) {
  const directory = path.join(bridge.session(session), '.plots');
  const result = [];
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes:true })) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
    const runId = entry.name.slice(0,-5);
    let record;
    try { record = readRecord(bridge, session, runId); } catch (_) { continue; }
    if (record.status === 'running' && !bridge.jobs.has(record.id)) { record.status = 'interrupted'; record.error = '服务重启，已生成文件保留；核对后可生成新版本。'; }
    record.files = outputFiles(bridge,session,runId);
    result.push(record);
  }
  return result.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
function validateOutputs(bridge, job) {
  const files = outputFiles(bridge,job.sessionId,job.id);
  const image = files.some(file => { try { rasterType(bridge.download(job.sessionId, 'output', file.name)); return true; } catch (_) { return false; } });
  const code = files.some(file => file.size > 0 && CODE.test(file.name));
  if (!image || !code) return '本次未同时生成有效预览图片和绘图代码，请查看回复或日志，补充方案后重新生成。';
  return null;
}
function processRun(command, args, progress, timeout=240000) {
  return new Promise((resolve,reject) => {
    const child = spawn(command, args, { windowsHide:true, stdio:['ignore','pipe','pipe'], env:{...process.env,PYTHONUTF8:'1'} });
    let tail = '', done = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('绘图依赖准备超时，请检查网络后重试')); }, timeout);
    const finish = error => { if (done) return; done=true; clearTimeout(timer); error ? reject(error) : resolve(); };
    child.stdout.on('data', data => { tail=(tail+data).slice(-2000); });
    child.stderr.on('data', data => { tail=(tail+data).slice(-2000); });
    child.on('error', error => finish(error));
    child.on('exit', code => finish(code === 0 ? null : new Error('绘图依赖准备失败：' + tail.slice(-700))));
  });
}
async function prepareRuntime(root, progress=()=>{}) {
  const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (prepares.has(root)) return prepares.get(root);
  const prepare = (async () => {
    if (!fs.existsSync(python)) {
      progress('正在创建项目绘图环境…');
      const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
      const base = process.env.WORKBENCH_PYTHON || (fs.existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3');
      await processRun(base, ['-m','venv',path.join(root,'.venv')], progress);
    }
    try { await processRun(python, ['-c','import matplotlib,pandas,openpyxl,xlrd'], progress, 15000); }
    catch (_) {
      progress('首次绘图：正在准备 matplotlib、pandas 和 Excel 读取依赖，可能需要几分钟…');
      await processRun(python, ['-m','pip','install','--disable-pip-version-check','-r',path.join(root,'requirements-plotting.txt')], progress);
    }
    await processRun(python, ['-c','import matplotlib,pandas,openpyxl,xlrd'], progress,15000);
    progress('绘图环境已就绪。');
    return python;
  })();
  prepares.set(root, prepare);
  try { return await prepare; } catch (error) { prepares.delete(root); throw error; }
}
module.exports = { freezePlan, saveRecord, runs, validateOutputs, rasterType, prepareRuntime, PLAN };
