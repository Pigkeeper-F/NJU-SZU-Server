'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/store.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const oldOrder = ['download-data', 'clean-data', 'calculation', 'result-audit', 'literature-mining', 'manual-review', 'plotting'];
const newOrder = ['download-data', 'clean-data', 'literature-mining', 'calculation', 'plotting', 'result-audit', 'manual-review'];
const at = '2026-10-19T12:00:00.000Z';
function boot(snapshot) {
  const data = new Map(snapshot ? [['fa_state_v1', JSON.stringify(snapshot)]] : []);
  const browser = {localStorage:{getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)}};
  vm.runInNewContext(source, {window:browser});
  return browser.Store;
}
function oldSnapshot(typed = true) {
  return {tabs:[{id:'flow',name:'流程'}], activeTabId:'flow', activeModuleId:'id-calculation', modules:oldOrder.map((type,index)=>({
    id:'id-'+type, name:type, ...(typed ? {type} : {}), mode:type==='calculation'?'modify':null,
    dependsOn:index ? 'id-'+oldOrder[index-1] : null, createdAt:at, status:'approved', approvedAt:at,
    messages:[{id:'msg-'+type,text:'原有对话 '+type,role:'user',at}],
    doc:{content:'规则 '+type,status:'approved',updatedAt:at,approvedAt:at},
    run:{status:'confirmed',at,dir:'original/'+type,artifacts:[{name:type+'.csv',size:42}]}
  }))};
}
for (const typed of [true, false]) {
  const original = oldSnapshot(typed);
  const store = boot(original);
  const result = plain(store.getState());
  assert.deepEqual(result.modules.map(mod=>mod.type), newOrder);
  assert.equal(result.activeModuleId, original.activeModuleId);
  for (const mod of result.modules) {
    const before = original.modules.find(item=>item.id===mod.id);
    for (const field of ['id','createdAt','messages','doc','run','status','approvedAt','mode']) assert.deepEqual(mod[field],before[field],mod.type+': '+field);
  }
  const calc = result.modules.find(mod=>mod.type==='calculation');
  assert.equal(calc.name,'模型调整与计算');
  assert.deepEqual(plain(store.getUpstreamModules(calc.id)).map(mod=>mod.type), ['download-data','clean-data','literature-mining']);
  for (const type of ['download-data','clean-data','literature-mining']) {
    const prep = result.modules.find(mod=>mod.type===type);
    assert.equal(prep.dependsOn,null);
    assert.deepEqual(plain(store.getUpstreamModules(prep.id)),[]);
    assert.equal(store.approveModule(prep.id).nextId,calc.id);
    assert.equal(store.removeModule(prep.id).ok,false);
  }
  const captured = plain(store.getState());
  assert.equal(store.restoreState(captured),true);
  assert.deepEqual(plain(store.getState()),captured);
  assert.deepEqual(plain(boot(captured).getState()),captured);
  for (const mode of ['direct','modify','parameter-update','activity-data-update','direct']) {
    assert.equal(store.setModuleMode(calc.id,mode),true);
    assert.equal(store.getState().modules.length,7);
    assert.equal(store.getState().modules.find(mod=>mod.id===calc.id).name,'模型调整与计算');
  }
}
// Unselected historical calculation must not erase any downstream records.
const unselected = oldSnapshot(); unselected.modules.find(mod=>mod.type==='calculation').mode=null;
assert.equal(boot(unselected).getState().modules.length,7);
// A preparation path can start alone, and missing paths insert before existing calculation.
const store = boot();
const literature = store.addModule('文献挖掘');
assert.equal(literature.type,'literature-mining');
assert.equal(store.getState().modules.length,1);
const clean = store.addModule('数据清洗');
assert.equal(store.removeModule(literature.id).ok,true); // parallel paths do not lock one another
store.appendMessage(clean.id,'保留清洗讨论','user');
const calc = store.approveModule(clean.id).created;
assert.equal(calc.type,'calculation');
store.addModule('下载数据'); store.addModule('文献挖掘');
assert.deepEqual(plain(store.getState()).modules.map(mod=>mod.type),newOrder.slice(0,4));
assert.equal(store.getState().modules.find(mod=>mod.id===clean.id).messages[0].text,'保留清洗讨论');
store.setModuleMode(calc.id,'modify');
const plot=store.approveModule(calc.id).created;
assert.equal(plot.type,'plotting');
const audit=store.approveModule(plot.id).created;
assert.equal(audit.type,'result-audit');
const review=store.approveModule(audit.id).created;
assert.equal(review.type,'manual-review');
assert.equal(store.approveModule(review.id).nextId,null);
assert.deepEqual(plain(store.getState()).modules.map(mod=>mod.type),newOrder);
// Optional historical calculation branches stay attached without replacing completed records.
store.setModuleMode(calc.id,'parameter-update');
const child=store.addModule('参数更新');
assert.equal(store.getUpstreamModules(plot.id)[0].id,child.id);
store.setModuleMode(calc.id,'direct');
assert.equal(store.getUpstreamModules(plot.id)[0].id,calc.id);
assert.equal(store.getState().modules.length,8);
// Existing writing workflows retain their own position and dependencies.
const legacy=oldSnapshot(); legacy.modules.splice(2,0,{id:'writing',name:'旧写作',step:'literature',dependsOn:'id-clean-data',createdAt:at,messages:[]});
const mixed=boot(legacy).getState();
assert.equal(mixed.modules[2].id,'writing');
assert.equal(mixed.modules[2].dependsOn,'id-clean-data');
assert.deepEqual(plain(boot().getUpstreamModules('missing')),[]);
assert.equal(boot().addModule('计算').name,'模型调整与计算');
console.log('WORKFLOW_PARALLEL_TESTS_PASS');
