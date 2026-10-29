'use strict';
// Offline lifecycle fixtures. Model generation is stubbed; only known fixture
// Python is executed, inside this test's temporary project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Writable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { CodexBridge } = require('./codex-bridge');
const { CleaningTasks, generated, selection } = require('./cleaning');
const { pythonCall } = require('./cleaning-runtime');
const { cleanResultsView } = require('./clean-results-view');
const PYTHON = process.env.WORKBENCH_PYTHON || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const code = 'def clean(tables, config):\n    return {"tables":[{"name":t["id"],"columns":t["columns"],"rows":t["rows"],"lineage":[[s] for s in t["source_ids"]]} for t in tables],"dispositions":{}}\n';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle(manager, session, id) {
  for (let i=0; i<300; i++) { const state=manager.snapshot(session,id); if(state.status!=='running' && !manager.running.has(id))return state; await wait(20); }
  throw new Error('Fixture cleaning timed out');
}
async function zip(manager, session, id, inputs, filename) {
  const chunks=[];
  const res=new Writable({write(chunk,_enc,done){chunks.push(chunk);done();}});
  res.writeHead=status=>assert.equal(status,200);
  await manager.archive(session,id,inputs,res);
  fs.writeFileSync(filename,Buffer.concat(chunks));
  return JSON.parse(await pythonCall(PYTHON,['-c','import zipfile,json,sys; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',filename]));
}
async function main(){
  const parent=path.resolve(__dirname,'../.workbench/test-fixtures');fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'cleaning-'));
  const tools=path.join(root,'tools');fs.mkdirSync(tools);
  fs.copyFileSync(path.join(__dirname,'cleaning_core.py'),path.join(tools,'cleaning_core.py'));
  const bridge=new CodexBridge(root),session=bridge.createSession().id;
  const source=bridge.upload(session,'fixture.csv',Buffer.from('code,value\n004,-11.000000\n005,0.000000\n')).name;
  let generations=0,executions=0;
  bridge.compose=async(_prompt,_model,opts)=>{assert.match(_prompt,/config.rules.version为整数1/);generations++;opts.metadata.model='fixture-model';opts.metadata.effort='low';return JSON.stringify({code,checks:[{op:'preserve_fields',table:1,fields:['code','value'],basis:'保留原值'}]});};
  bridge.run=async(s,_messages,_instructions,execute,_model,type,_mode,_plot,prepared)=>{
    assert.equal(s,session);assert.equal(type,'clean-data');assert.equal(execute,true);executions++;
    const job={id:prepared.id,sessionId:s,status:'running',messages:[],events:[],preview:''};bridge.jobs.set(job.id,job);
    const work=path.join(bridge.session(s),'output',job.id);
    const bundle=path.join(bridge.session(s),'.cleaning',job.id,'package');
    void pythonCall(PYTHON,[path.join(bundle,'cleaning_core.py'),'run','--bundle',bundle,'--input-dir',path.join(bridge.session(s),'input'),'--output-dir',work])
      .then(()=>{job.status='completed';},error=>{job.status='failed';job.error=error.message;});
    return bridge.snapshot(job.id);
  };
  const manager=new CleaningTasks(root,bridge,{python:PYTHON});
  try{
    assert.throws(()=>manager.start(session,{text:'unconfirmed',version:1,inputs:[{name:source}]}),/确认/);
    assert.throws(()=>selection([{name:'../fixture.csv'}]),/无效/);
    assert.throws(()=>generated(JSON.stringify({code,checks:[{op:'row_count',table:1,expected:2,basis:'not approved'}]}),'保留原值'),/原句/);
    const profile=await manager.profile(session,[{name:source}]);assert.equal(profile.row_count,2);
    const plan={confirmed:true,text:'保留原值；不得丢行',version:1,inputs:[{name:source}]};
    const start=manager.start(session,plan,null,'fixture instructions');
    assert.throws(()=>manager.start(session,plan),/运行/);
    const done=await settle(manager,session,start.id);
    assert.equal(done.status,'completed',done.error);assert.equal(done.verification.status,'passed');
    assert.equal(done.model,'fixture-model');assert.equal(done.effort,'low');
    assert.equal(done.verification.researcher_acceptance,'not_assessed');
    assert.equal(generations,1);assert.equal(executions,1);
    assert.equal(cleanResultsView(bridge,session,start.id).cleaning.id,start.id);
    const replay=manager.replay(session,start.id,'fixture instructions');
    const again=await settle(manager,session,replay.id);
    assert.equal(again.status,'completed',again.error);assert.equal(generations,1,'Replay must not regenerate project code');
    assert.deepEqual(again.verification.output_files,done.verification.output_files);
    const recovered=new CleaningTasks(root,new CodexBridge(root));
    assert.equal(recovered.snapshot(session,start.id).status,'completed','Completion survives server restart');
    const record=recovered.create(session,{rules:plan});
    const restart=new CleaningTasks(root,new CodexBridge(root),{recover:true});
    assert.equal(restart.snapshot(session,record.id).status,'interrupted');

    const without=await zip(manager,session,start.id,false,path.join(root,'without.zip'));
    assert(without.includes('clean.py')&&without.includes('cleaning_core.py')&&without.includes('requirements-lock.txt'));
    assert(!without.some(name=>name.startsWith('inputs/')),'Raw data are opt-in');
    const withInput=path.join(root,'with.zip');
    const names=await zip(manager,session,start.id,true,withInput);assert(names.includes('inputs/'+source));
    const foreign=path.join(root,'other-computer');fs.mkdirSync(foreign);
    await pythonCall(PYTHON,['-c','import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',withInput,foreign]);
    await pythonCall(PYTHON,[path.join(foreign,'cleaning_core.py'),'run','--bundle',foreign,'--input-dir',path.join(foreign,'inputs'),'--output-dir',path.join(foreign,'replay-output')]);
    const one=fs.readFileSync(path.join(bridge.session(session),'output',start.id,'table-01.csv'));
    assert(one.equals(fs.readFileSync(path.join(foreign,'replay-output/table-01.csv'))),'Portable bundle runs without model access and has identical data');
    const raw=path.join(bridge.session(session),'input',source);fs.chmodSync(raw,0o644);fs.appendFileSync(raw,'999,3\n');
    const changed=manager.replay(session,start.id,'fixture');
    const refused=await settle(manager,session,changed.id);assert.equal(refused.status,'failed');assert.match(refused.error,/指纹/);assert.equal(generations,1);
    // The production bridge retains its existing OS sandbox for frozen runs.
    const actualBridge=new CodexBridge(root), otherSession=actualBridge.createSession().id, preparedId=randomUUID(), requests=[];
    const work=path.join(actualBridge.session(otherSession),'output',preparedId);fs.mkdirSync(work);
    actualBridge.status=async()=>({loggedIn:true,model:'fixture-model',models:[{model:'fixture-model',defaultReasoningEffort:'low'}]});
    actualBridge.rpc=async(method,params)=>{requests.push({method,params});return method==='thread/start'?{thread:{id:randomUUID()}}:{turn:{id:randomUUID()}};};
    await actualBridge.run(otherSession,[{role:'user',content:'run frozen fixture'}],'',true,null,'clean-data',null,null,{id:preparedId,inputs:[],effort:'low'});
    for(let i=0;i<100&&!actualBridge.jobs.get(preparedId).turnId;i++)await wait(5);
    const turn=requests.find(r=>r.method==='turn/start');assert(turn);
    assert.equal(turn.params.sandboxPolicy.type,'workspaceWrite');assert.equal(turn.params.sandboxPolicy.networkAccess,false);
    assert.equal(turn.params.effort,'low','Frozen replay retains recorded effort rather than adopting a new default');
    assert.deepEqual(turn.params.sandboxPolicy.writableRoots,[work]);
    assert.match(requests.find(r=>r.method==='thread/start').params.developerInstructions,/仅执行已冻结/);
    actualBridge.finish(actualBridge.jobs.get(preparedId),'completed');
    bridge.compose=async()=>JSON.stringify({code:'def clean(tables, config):\n    return {"questions":["请确认异常值是否保留"]}\n'});
    const runtimePending=manager.start(session,plan,null,'fixture');
    const runtimePaused=await settle(manager,session,runtimePending.id);
    assert.equal(runtimePaused.status,'needs_attention',runtimePaused.error);
    assert.match(runtimePaused.questions.join(' '),/异常值/);
    assert.equal(executions,3,'Runtime questions pause after the frozen program starts');
    bridge.compose=async()=>JSON.stringify({code,questions:['请明确单位口径']});
    const pending=manager.start(session,plan,null,'fixture');
    const paused=await settle(manager,session,pending.id);assert.equal(paused.status,'needs_attention');assert.equal(executions,3,'Unresolved scientific questions must not execute');
    bridge.compose=async(_p,_m,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('fixture cancellation')),{once:true}));
    const stopping=manager.start(session,plan,null,'fixture');
    for(let i=0;i<100&&manager.snapshot(session,stopping.id).stage!=='generating';i++)await wait(10);
    await manager.cancel(session,stopping.id);
    assert.equal((await settle(manager,session,stopping.id)).status,'cancelled','Cancellation must not be overwritten by a late failure');
    assert.equal(executions,3);
    console.log('CLEANING_TESTS_PASS: frozen rules, deterministic profile, lifecycle, independent verification, no-regeneration replay, portable ZIP and restart');
  }finally{
    assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
