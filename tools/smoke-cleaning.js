'use strict';
// Explicit live smoke test: uses the signed-in Codex account and its quota.
// Only synthetic data in a separately-created temporary project are processed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { CodexBridge } = require('./codex-bridge');
const { CleaningTasks } = require('./cleaning');
const parent = path.resolve(__dirname, '../.workbench/test-fixtures');
fs.mkdirSync(parent, {recursive:true});
const root = fs.mkdtempSync(path.join(parent, 'live-cleaning-'));
fs.mkdirSync(path.join(root, 'tools'));
fs.copyFileSync(path.join(__dirname, 'cleaning_core.py'), path.join(root, 'tools/cleaning_core.py'));
const bridge = new CodexBridge(root), manager = new CleaningTasks(root, bridge);
let session, id, passed = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const account = await bridge.status();
  assert(account.loggedIn && account.model, 'Codex login/model unavailable');
  console.log('Live model catalog default:', account.model);
  const selected = process.env.CLEANING_SMOKE_MODEL || account.model;
  assert(account.models.some(m => m.model === selected), 'Selected smoke model is not listed');
  console.log('Live smoke selected model:', selected);
  session = bridge.createSession().id;
  const input = bridge.upload(session, 'synthetic.csv', Buffer.from("code,Value\n'004,-11.000000\n'005,0.000000\n")).name;
  const plan = {confirmed:true,version:1,inputs:[{name:input}],text:'保留全部2行。保留原始code和Value字段及所有原值。新增code_clean列，仅去掉code开头的一个单引号，保留前导零；新增value_t列，使用精确十进制将Value乘以1000，不改变库存负号。不要插补、删除或合并。'};
  id = manager.start(session, plan, selected, '只处理本次合成夹具。按平台冻结的脚本命令执行，完成后由平台核验。').id;
  const deadline = Date.now() + 240000;
  let stage;
  while (Date.now() < deadline) {
    const state = manager.snapshot(session,id);
    if (state.stage !== stage) {stage=state.stage;console.log('Stage:',stage);}
    if (state.status !== 'running' && !manager.running.has(id)) {
      assert.equal(state.status,'completed',state.error || state.text);
      assert(['passed','partial'].includes(state.verification.status));
      assert(state.verification.checks.every(check=>check.status==='passed'));
      assert.equal(state.model,selected);
      assert.equal(state.effort,account.effort || 'high');
      const result = JSON.parse(fs.readFileSync(path.join(bridge.session(session),'output',id,'cleaning-result.json'),'utf8'));
      const rows = result.tables[0].rows;
      assert.equal(rows.length,2);assert.equal(rows[0].code_clean,'004');
      assert.equal(Number(rows[0].value_t),-11000);assert.equal(rows[0].Value,'-11.000000');
      console.log('LIVE_CLEANING_PASS:',state.model,state.effort,'2 synthetic rows; original values and negative sign retained; program checks passed; pending scientific checks:',state.verification.pending_checks.length);
      passed=true;return;
    }
    await wait(500);
  }
  throw new Error('Live cleaning smoke test exceeded four minutes');
}
main().catch(error=>{console.error(error.message);console.error('Fixture retained for diagnosis:',root);process.exitCode=1;}).finally(async()=>{
  if(session && id && manager.running.has(id)) {
    await manager.cancel(session,id).catch(()=>{});
    for(let i=0;i<100&&manager.running.has(id);i++)await wait(50);
  }
  bridge.close();
  if(passed) {assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true,force:true});}
});
