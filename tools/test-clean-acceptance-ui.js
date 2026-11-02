#!/usr/bin/env node
'use strict';
// Production cleaning acceptance UI under an in-memory fixture. No data files,
// real sessions, model calls, cleaning execution or network are operated.
const assert = require('node:assert/strict'), fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/codex.js'),'utf8');
const tasksSource=fs.readFileSync(path.join(__dirname,'../js/tasks.js'),'utf8');
const chatSource=fs.readFileSync(path.join(__dirname,'../js/chat.js'),'utf8');
const compiler=require('../js/clean-verification-rules');
const executionPlan=require('../js/clean-execution-plan');
function fn(text,name){const match=new RegExp('^  (?:async )?function '+name+'\\(','m').exec(text);assert.ok(match,name);return text.slice(match.index,text.indexOf('\n  }',match.index)+4);}
function node(tag,text,className){return {tag,textContent:text||'',className:className||'',children:[],open:false,append(...v){this.children.push(...v);},setAttribute(k,v){this[k]=v;}};}
const all=x=>[x,...(x.children||[]).flatMap(all)], text=x=>all(x).map(v=>v.textContent).join('\n');
const button=(x,label)=>all(x).find(v=>v.tag==='button'&&v.textContent===label);
const clone=x=>JSON.parse(JSON.stringify(x));
const names=['basisForClean','cleanStandardNames','uploadCleanStandards','cleanVerificationControls','cleanAcceptanceScope','cleanStandardSelectionMatches','noteUnavailableCleanSession','cleanAcceptanceReady','cleanAcceptanceReport','loadCleanAcceptanceRuns','loadCleanAcceptance','decideCleanAcceptance','recordCleanManualCheck','cleanManualCheckPanel','cleanAcceptanceArtifact','cleanAcceptancePanel','confirmCleanAcceptance','downloadAcceptanceArtifact','queueCleanAcceptancePoll','prepareConfirmedExecution','cancelPreparedExecution','reply','watch'];
function fixture(options={}){
 const plan='已确认本批体重数据，保留原始值和逐条去向。',mod={id:'clean',type:'clean-data',name:'数据清洗'},mods=[mod],t={files:[],busy:false,cleanRuns:[]},saved={clean:{sessionId:'clean-session'}};
 t.backend='codex';
 const run={id:'run-one',status:'completed',createdAt:'2026-10-27T01:00:00Z',planVersion:1,planText:plan};t.cleanRuns=[run];t.cleanRunsLoadedSession='clean-session';
 let report={id:'report-one',runId:run.id,status:'ready',planSha256:'frozen-plan-hash',checks:[{id:'lineage',label:'逐条去向',status:'passed',evidence:'10条都有对应去向'}],issues:[],summary:{inputRows:10,cleanedRows:3,pendingRows:6,duplicateRows:1},artifacts:[{name:'run-one/verification/report-one/report.json',label:'完整核验报告'}],...clone(options.report||{})};
 let ruleText=plan,dirty=false,globalBusy=false,hook=null,timerNext=1,projectId='fixture-project';const timers=new Map();const calls=[],actions=[],invalidations=[],messages=[];const tasks=new Map([['clean',t]]);
 const task=id=>{if(!tasks.has(id))tasks.set(id,{files:[],busy:false});return tasks.get(id);};
 const store={getState:()=>({modules:mods,activeModuleId:'clean'}),invalidateCleanAcceptance(...args){invalidations.push(args);},addModule(name){actions.push('create-target');mods.push({id:'calculation',type:'calculation',name});},markRun(id,info){actions.push('mark');assert.ok(info.cleanAcceptance);mod.run={...info,status:'ran'};return mod.run;},confirmRun(){actions.push('confirm-run');mod.run.status='confirmed';return true;},appendMessage(...value){messages.push(value);},approveModule(){actions.push('approve');},selectModule(id){actions.push('select:'+id);}};
 const context=vm.createContext({setTimeout(fn,ms){assert.equal(ms,1500);const id=timerNext++;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},root:{TaskManager:{rulesForModule:()=>({text:ruleText,version:1,dirty}),currentTaskId:()=>projectId},CleanVerificationRules:compiler,ModuleSpace:{isBusy:()=>globalBusy}},ModuleSpace:{render(){}},Store:store,saved,task,node,render(){},persist(){},session:async id=>{actions.push('session:'+id);saved[id]||={};return saved[id].sessionId||='calculation-session';},
 request:async(url,settings={})=>{const body=typeof settings.body==='string'?JSON.parse(settings.body):settings.body || null;calls.push({url,body});if(hook){const override=await hook(url,body);if(override!==undefined)return override;}
 if(url.startsWith('/api/codex/files?'))return {files:[{group:'input',name:'current.csv',size:50},{group:'input',name:'historical.csv',size:40}]};
 if(url.startsWith('/api/codex/clean/runs?'))return{runs:clone(t.cleanRuns)};
 if(url.startsWith('/api/codex/clean/verification?'))return clone(report);
 if(url==='/api/codex/clean/verify'){actions.push('verify');assert.equal(body.confirm,true);return clone(report);}
 if(url==='/api/codex/clean/decision'){actions.push('decision');const issue=report.issues.find(v=>v.id===body.issueId);assert.equal(body.reportId,report.id);issue.resolution={decision:body.decision,note:body.note};report.status=body.decision==='accept'?'ready':'rejected';return clone(report);}
 if(url==='/api/codex/clean/manual-check'){actions.push('manual-check');const check=report.manualChecks.find(v=>v.id===body.checkId);assert.equal(body.reportId,report.id);check.history=check.history || [];if(check.resolution)check.history.push(clone(check.resolution));check.resolution={conclusion:body.conclusion,note:body.note,evidence:body.evidence,reviewer:body.reviewer,at:'2026-10-27T03:00:00Z',actor:'human'};report.status=body.conclusion==='passed'?'ready':body.conclusion==='rejected'?'rejected':'needs_manual';return clone(report);}
 if(url==='/api/codex/clean/confirm'){actions.push('confirm');assert.equal(body.rulesText,plan);assert.equal(body.reportId,report.id);return{confirmed:true,runId:run.id,reportId:report.id,cleanedNames:['run-one/cleaned.csv']};}
 if(url==='/api/codex/import-input'){actions.push('import');assert.equal(body.sourceGroup,'output');assert.equal(body.cleanRunId,run.id);assert.equal(body.cleanReportId,report.id);return{names:['copied-cleaned.csv'],files:[{group:'input',name:'copied-cleaned.csv',size:50}]};}
 throw new Error('Unexpected or executable API '+url);
 }});
 vm.runInContext(names.map(n=>fn(source,n)).join('\n')+'\nglobalThis.subject={'+names.join(',')+'};',context);
 const h={mod,t,saved,run,context,calls,actions,invalidations,messages,mods,timers,async tick(){const entry=timers.entries().next().value;assert.ok(entry,'A poll is queued');timers.delete(entry[0]);await entry[1]();},subject:context.subject,getReport:()=>report,setReport:value=>{report=clone(value);h.bind();},setRule:value=>{ruleText=value;},setProject:value=>{projectId=value;},setDirty:value=>{dirty=value;},setBusy:value=>{globalBusy=value;},setHook:value=>{hook=value;},bind(){t.cleanAcceptance=clone(report);t.cleanAcceptanceKey=JSON.stringify(['clean-session',run.id]);},panel(){return context.subject.cleanAcceptancePanel(mod,t);}};h.bind();return h;
}
function noExecute(h){assert.ok(!h.calls.some(v=>/codex\/run|source\/start|code\/exec/.test(v.url)));}
const warning=()=>({id:'missing-policy',title:'缺失值需要确认',severity:'warning',decisionRequired:true,canAccept:true,impact:'原始第4行；体重为空',evidence:[{label:'原值与结果',detail:'原值空，结果待处理',artifact:{name:'run-one/verification/report-one/rows.jsonl',label:'定位'}}],attempts:['已按规则隔离，未猜测填补'],recommendation:'请决定是否保留缺失例外'});
async function main(){
 // Exercise the production completed-job path: discussing rules creates a
 // conversation job, never a frozen cleaning run or a failed legacy result.
 const discussionOnly=fixture(),discussionJob={id:'discussion-one',status:'completed',text:'候选清洗规则，尚未运行清洗。',files:[{group:'input',name:'current.csv',size:50}]};
 discussionOnly.t.cleanRuns=[];discussionOnly.saved.clean.jobId=discussionJob.id;
 discussionOnly.setHook(url=>url.startsWith('/api/codex/job?')?clone(discussionJob):undefined);
 await discussionOnly.subject.watch('clean',discussionJob.id);
 assert.equal(discussionOnly.subject.cleanAcceptanceScope(discussionOnly.mod),null);
 assert.equal(discussionOnly.saved.clean.cleanAcceptanceRunId,undefined);
 assert.equal(discussionOnly.t.cleanAcceptance,null,'A discussion clears an unrelated cached verification report');
 assert.deepEqual(discussionOnly.messages,[['clean',discussionJob.text,'assistant']],'The first discussion reply is preserved');
 assert.equal(discussionOnly.subject.basisForClean(discussionOnly.mod).text,discussionOnly.run.planText,'Discussion completion leaves the confirmed rules unchanged');
 assert.equal(button(discussionOnly.panel(),'核验已有清洗结果').disabled,true);
 assert.match(text(discussionOnly.panel()),/暂无清洗执行记录。先讨论并确认方案，执行后再核验/);
 assert.ok(discussionOnly.calls.every(call=>call.url.startsWith('/api/codex/job?') || call.url.startsWith('/api/codex/clean/runs?')),'Discussion completion never requests verification');noExecute(discussionOnly);
 // Old clients may have persisted a conversation id. It cannot form a scope
 // before refresh, and an authoritative empty run list removes only that id.
 const dangling=fixture();dangling.t.cleanRuns=[];dangling.t.cleanAcceptanceRunId='old-conversation';dangling.saved.clean.cleanAcceptanceRunId='old-conversation';dangling.saved.clean.inputBatch={names:['current.csv'],label:'原批次',text:'保留来源'};
 const originalBatch=clone(dangling.saved.clean.inputBatch);assert.equal(dangling.subject.cleanAcceptanceScope(dangling.mod),null);
 await dangling.subject.loadCleanAcceptanceRuns('clean',true);
 assert.equal(dangling.t.cleanAcceptanceRunId,null);assert.equal(dangling.saved.clean.cleanAcceptanceRunId,undefined);assert.equal(dangling.t.cleanAcceptance,null);
 assert.equal(dangling.saved.clean.sessionId,'clean-session');assert.deepEqual(dangling.saved.clean.inputBatch,originalBatch);assert.equal(dangling.subject.basisForClean(dangling.mod).text,dangling.run.planText);
 assert.ok(dangling.calls.every(call=>call.url.startsWith('/api/codex/clean/runs?')));noExecute(dangling);
 // An ordinary discussion must retain the selected real historical run,
 // including its report, even when a newer real run is also available.
 const historical=fixture(),newerRun={...clone(historical.run),id:'run-newer',createdAt:'2026-10-27T02:00:00Z'};
 historical.t.cleanRuns=[newerRun,historical.run];historical.t.cleanAcceptanceRunId=historical.run.id;historical.saved.clean.cleanAcceptanceRunId=historical.run.id;historical.saved.clean.jobId=discussionJob.id;
 historical.setHook(url=>url.startsWith('/api/codex/job?')?clone(discussionJob):undefined);
 await historical.subject.watch('clean',discussionJob.id);
 assert.equal(historical.subject.cleanAcceptanceScope(historical.mod).runId,historical.run.id);assert.equal(historical.saved.clean.cleanAcceptanceRunId,historical.run.id);assert.equal(historical.t.cleanRuns.length,2);
 assert.equal(historical.t.cleanAcceptance.id,'report-one');assert.deepEqual(historical.messages,[['clean',discussionJob.text,'assistant']]);
 assert.ok(!historical.calls.some(call=>call.url==='/api/codex/clean/verify'));noExecute(historical);
 // A just-completed real cleaning run is selected only after the backend
 // includes it in /clean/runs; an older selected run does not hide it.
 const completed=fixture(),cleanJob={...discussionJob,id:'run-completed',text:'清洗完成'},completedRun={...clone(completed.run),id:cleanJob.id};
 completed.t.cleanAcceptanceRunId=completed.run.id;completed.saved.clean.cleanAcceptanceRunId=completed.run.id;
 completed.setHook(url=>url.startsWith('/api/codex/job?')?clone(cleanJob):url.startsWith('/api/codex/clean/runs?')?{runs:[clone(completedRun),clone(completed.run)]}:url.startsWith('/api/codex/clean/verification?')?{...clone(completed.getReport()),runId:cleanJob.id}:undefined);
 await completed.subject.watch('clean',cleanJob.id);assert.equal(completed.subject.cleanAcceptanceScope(completed.mod).runId,cleanJob.id);assert.equal(completed.saved.clean.cleanAcceptanceRunId,cleanJob.id);assert.ok(!completed.calls.some(call=>call.url==='/api/codex/clean/verify'));noExecute(completed);
 const frozen=fixture();frozen.saved.clean.inputBatch={names:['current.csv'],label:'当前交接',text:'既有来源要求'};assert.equal(await frozen.subject.prepareConfirmedExecution('clean'),true);assert.deepEqual(Array.from(frozen.t.preparedCleanPlan.inputNames),['current.csv']);assert.equal(frozen.t.preparedCleanPlan.text,frozen.run.planText);frozen.setRule('changed after prepare');await assert.rejects(()=>frozen.subject.reply(frozen.mod,[]),/核对并确认/);assert.ok(!frozen.calls.some(v=>v.url==='/api/codex/run'));frozen.subject.cancelPreparedExecution('clean');assert.equal(frozen.t.preparedCleanPlan,null);noExecute(frozen);
 // An authoritative execution of the exact approved A plan can restore its
 // explicit input binding after refresh. This changes only file roles/batch,
 // never the approved text, discussions, signatures, or physical originals.
 const aSource=fs.readFileSync(path.join(__dirname,'fixtures/fbsh80-a-plan.md'),'utf8'),aPrepared=executionPlan.prepare(aSource);
 assert.ok(aPrepared);const aCsv=aPrepared.inputReferenceNames[0],aTxt=aPrepared.standardReferenceNames[0];
 function aFixture(){
  const a=fixture();a.context.root.CleanExecutionPlan=executionPlan;a.setRule(aSource);
  Object.assign(a.run,{planText:aSource,executionAdapter:aPrepared.adapter,inputFiles:[{name:aCsv,size:800,sha256:'a'.repeat(64)}],standardFiles:[{name:aTxt,group:'reference',sha256:'b'.repeat(64)}]});
  a.saved.clean.cleanStandardNames=[aCsv,aTxt];a.saved.clean.inputBatch={names:['historical.csv'],label:'原来源说明',text:'原批次文字',sourceJobId:'preserved-source'};
  a.mod.messages=[{role:'user',text:'只执行已确认A规则，不换算。'},{role:'assistant',text:'已有讨论和依据保留。'}];return a;
 }
 const aRestore=aFixture(),aDiscussion=clone(aRestore.mod.messages),aRunBefore=clone(aRestore.run);
 await aRestore.subject.loadCleanAcceptanceRuns('clean',true);
 assert.deepEqual(Array.from(aRestore.saved.clean.cleanStandardNames),[aTxt],'Remove only the original-data CSV role; keep the independent TXT standard');
 assert.deepEqual(Array.from(aRestore.saved.clean.inputBatch.names),[aCsv],'Restore the actual frozen input batch, not historical inputs');
 assert.equal(aRestore.saved.clean.inputBatch.sourceJobId,'preserved-source');
 assert.match(aRestore.saved.clean.inputBatch.text,/SHA-256/);
 assert.equal(aRestore.subject.basisForClean(aRestore.mod).text,aSource,'The original approved A text remains unchanged');
 assert.deepEqual(aRestore.mod.messages,aDiscussion,'Restoring the file binding never rewrites existing discussion');
 assert.deepEqual(aRestore.run,aRunBefore,'The authoritative frozen run metadata is read-only');
 assert.equal(aRestore.invalidations.length,0,'Role recovery does not invalidate the matching original approved plan');
 assert.ok(aRestore.calls.every(call=>call.url.startsWith('/api/codex/clean/runs?') || call.url.startsWith('/api/codex/clean/verification?')),'Refresh restores metadata with GET requests only');noExecute(aRestore);
 for(const [label,alter] of [
  ['different approved text',a=>a.setRule(aSource+'\n不得将另一份规则自动视为相同。')],
  ['different frozen text',a=>{a.run.planText=aSource+'\n不同版本';}],
  ['different adapter',a=>{a.run.executionAdapter='different-adapter';}],
  ['missing named original CSV',a=>{a.run.inputFiles=[{name:'another.csv'}];}],
  ['additional current standard',a=>{a.saved.clean.cleanStandardNames.push('unrelated-standard.txt');}],
  ['different frozen standard',a=>{a.run.standardFiles=[{name:'different-standard.txt',group:'reference'}];}]
 ]){
  const rejected=aFixture();alter(rejected);const beforeBatch=clone(rejected.saved.clean.inputBatch),beforeStandards=clone(rejected.saved.clean.cleanStandardNames),beforeDiscussion=clone(rejected.mod.messages),beforeText=rejected.subject.basisForClean(rejected.mod).text;
  await rejected.subject.loadCleanAcceptanceRuns('clean',true);
  assert.deepEqual(rejected.saved.clean.inputBatch,beforeBatch,'A mismatched '+label+' cannot replace the current batch');
  assert.deepEqual(rejected.saved.clean.cleanStandardNames,beforeStandards,'A mismatched '+label+' cannot silently remove an adopted standard');
  assert.deepEqual(rejected.mod.messages,beforeDiscussion);assert.equal(rejected.subject.basisForClean(rejected.mod).text,beforeText);
  assert.ok(rejected.calls.every(call=>call.url.startsWith('/api/codex/clean/runs?') || call.url.startsWith('/api/codex/clean/verification?')));noExecute(rejected);
 }
 // Preparing an execution binds only the data explicitly named in the approved
 // plan; no historical input or unrelated attachment is silently included.
 const aBind=aFixture(),aOriginalDiscussion=clone(aBind.mod.messages);
 const aReferences=[{group:'reference',name:aCsv,size:800},{group:'reference',name:aTxt,size:100},{group:'reference',name:'not-selected.csv',size:90}];
 const aBeforeFiles=[{group:'input',name:'historical.csv',size:50},...aReferences];
 const aAfterFiles=[...aBeforeFiles,{group:'input',name:aCsv,size:800}];
 aBind.setHook((url,body)=>{
  if(url.startsWith('/api/codex/files?'))return{files:clone(aBeforeFiles)};
  if(url==='/api/codex/clean/bind-input'){
   assert.deepEqual(body,{sessionId:'clean-session',names:[aCsv],confirm:true});
   return{sessionId:'clean-session',inputNames:[aCsv],boundSources:[aCsv],sourceToInput:{[aCsv]:aCsv},files:clone(aAfterFiles)};
  }
 });
 assert.equal(await aBind.subject.prepareConfirmedExecution('clean'),true);
 assert.equal(aBind.calls.filter(call=>call.url==='/api/codex/clean/bind-input').length,1);
 assert.deepEqual(Array.from(aBind.t.preparedCleanPlan.inputNames),[aCsv]);assert.deepEqual(Array.from(aBind.t.preparedCleanPlan.standardNames),[aTxt]);
 assert.equal(aBind.t.preparedCleanPlan.text,aSource,'Keep the approved source text in the actual prepared execution payload');
 assert.deepEqual(Array.from(aBind.saved.clean.inputBatch.names),[aCsv]);assert.equal(aBind.saved.clean.inputBatch.sourceJobId,'preserved-source');
 assert.deepEqual(Array.from(aBind.saved.clean.cleanStandardNames),[aTxt]);assert.deepEqual(aBind.mod.messages,aOriginalDiscussion);
 assert.ok(aBind.t.files.some(file=>file.group==='reference' && file.name===aCsv),'The raw reference original is retained');
 assert.ok(aBind.t.files.some(file=>file.group==='reference' && file.name===aTxt),'The TXT standard original is retained');
 assert.ok(!aBind.t.preparedCleanPlan.inputNames.includes('historical.csv'));assert.ok(!aBind.t.preparedCleanPlan.inputNames.includes('not-selected.csv'));
 assert.equal(aBind.t.executeOnce,true);noExecute(aBind);
 // A late binding response cannot apply the old plan's batch after a rule edit.
 const changedBinding=aFixture();changedBinding.setHook((url)=>{
  if(url.startsWith('/api/codex/files?'))return{files:clone(aBeforeFiles)};
  if(url==='/api/codex/clean/bind-input'){changedBinding.setRule(aSource+'\n用户刚修改的规则');return{inputNames:[aCsv],boundSources:[aCsv],files:clone(aAfterFiles)};}
 });
 const changedBatch=clone(changedBinding.saved.clean.inputBatch),changedStandards=clone(changedBinding.saved.clean.cleanStandardNames);
 await assert.rejects(()=>changedBinding.subject.prepareConfirmedExecution('clean'),/任务或规则已改变/);
 assert.deepEqual(changedBinding.saved.clean.inputBatch,changedBatch);assert.deepEqual(changedBinding.saved.clean.cleanStandardNames,changedStandards);
 assert.equal(changedBinding.t.preparedCleanPlan,undefined);noExecute(changedBinding);
 const raw=fixture();raw.t.execute=true;await assert.rejects(()=>raw.subject.reply(raw.mod,[]),/核对并确认/);noExecute(raw);
 const h=fixture(),panel=h.panel();assert.match(text(panel),/清洗核验与待处理问题/);assert.match(text(panel),/输入记录 10/);assert.equal(all(panel).find(v=>v.tag==='details').open,false);assert.equal(button(panel,'确认结果并交给计算').disabled,false);assert.equal(h.calls.length,0,'Rendering never starts verification or cleaning');
 const w=fixture({report:{status:'needs_decision',issues:[warning()]}}),wp=w.panel();assert.match(text(wp),/影响：原始第4行/);assert.match(text(wp),/已尝试：已按规则隔离/);assert.equal(button(wp,'确认结果并交给计算').disabled,true);
 assert.equal(await w.subject.decideCleanAcceptance(w.mod,'report-one','missing-policy','accept',''),false);assert.equal(w.calls.length,0,'A reason is required');
 assert.equal(await w.subject.decideCleanAcceptance(w.mod,'stale','missing-policy','accept','有依据'),false);assert.equal(w.calls.length,0);
 assert.equal(await w.subject.decideCleanAcceptance(w.mod,'report-one','missing-policy','accept','本批按方案保留缺失并列待处理'),true);assert.match(text(w.panel()),/已接受本次例外/);assert.equal(button(w.panel(),'接受本次例外'),undefined);noExecute(w);
 const blocked=fixture({report:{status:'blocked',issues:[{...warning(),id:'corrupt',title:'文件损坏',severity:'error',canAccept:true}]}});assert.equal(button(blocked.panel(),'接受本次例外'),undefined);assert.equal(await blocked.subject.decideCleanAcceptance(blocked.mod,'report-one','corrupt','accept','强行接受'),false);assert.equal(await blocked.subject.confirmCleanAcceptance('clean'),false);assert.ok(!blocked.actions.includes('create-target'));noExecute(blocked);
 const stale=fixture();stale.setRule('新规则');assert.equal(button(stale.panel(),'确认结果并交给计算').disabled,true);assert.equal(await stale.subject.confirmCleanAcceptance('clean'),false);assert.equal(stale.calls.length,0);stale.setRule(stale.run.planText);stale.setDirty(true);assert.equal(stale.subject.basisForClean(stale.mod),null);
 const valid=fixture();assert.equal(await valid.subject.confirmCleanAcceptance('clean'),true);assert.deepEqual(valid.actions,['verify','confirm','create-target','session:calculation','import','mark','confirm-run','approve','select:calculation']);assert.equal(valid.saved.calculation.inputBatch.cleanAcceptance.runId,'run-one');assert.equal(await valid.subject.confirmCleanAcceptance('clean'),true);assert.equal(valid.actions.filter(v=>v==='import').length,1,'Viewing delivered results never imports a second time');noExecute(valid);
 const switched=fixture();let finishVerify;switched.setHook(url=>url==='/api/codex/clean/verify'?new Promise(resolve=>{finishVerify=resolve;}):undefined);const attempted=switched.subject.confirmCleanAcceptance('clean');switched.mods.splice(0,switched.mods.length,{id:'other-clean',type:'clean-data'});finishVerify(switched.getReport());assert.equal(await attempted,false);assert.ok(!switched.actions.includes('create-target'));assert.ok(!switched.calls.some(call=>call.url==='/api/codex/clean/confirm'||call.url==='/api/codex/import-input'),'Switching workspace during verification blocks mutation');noExecute(switched);
 const mutation=fixture();mutation.setHook(async(url)=>{if(url==='/api/codex/clean/verify')mutation.setRule('changed while checking');});assert.equal(await mutation.subject.confirmCleanAcceptance('clean'),false);assert.ok(!mutation.actions.includes('create-target'));noExecute(mutation);
 const legacy=fixture();legacy.run.planText=null;legacy.run.status='legacy';assert.match(text(legacy.panel()),/缺少冻结记录/);assert.equal(button(legacy.panel(),'确认结果并交给计算').disabled,true);noExecute(legacy);
 const missing=fixture();const missingSid=missing.saved.clean.sessionId;missing.setHook(url=>{if(url.includes('/clean/runs?'))throw Object.assign(new Error('任务不存在，请重新创建'),{code:'SESSION_NOT_FOUND',sessionId:missingSid});});await missing.subject.loadCleanAcceptanceRuns('clean',true);assert.match(text(missing.panel()),/本机尚无可用的清洗执行记录/);assert.ok(!text(missing.panel()).includes('请重新创建'));assert.equal(missing.saved.clean.sessionId,missingSid,'Missing read never discards the old session reference');assert.equal(missing.subject.cleanAcceptanceScope(missing.mod),null);await missing.subject.loadCleanAcceptanceRuns('clean');assert.equal(missing.calls.length,1,'A failed list read never creates an automatic GET/render loop');assert.equal(button(missing.panel(),'核验已有清洗结果').disabled,true);await missing.subject.loadCleanAcceptanceRuns('clean',true);assert.equal(missing.calls.length,2,'Explicit refresh can retry');assert.ok(missing.calls.every(v=>v.url.includes('/clean/runs?')));missing.setHook(url=>url.includes('/clean/runs?')?{runs:[clone(missing.run)]}:undefined);await missing.subject.loadCleanAcceptanceRuns('clean',true);assert.equal(missing.t.cleanAcceptanceUnavailableSession,null,'A successful explicit retry reconnects the original session');assert.equal(missing.subject.cleanAcceptanceScope(missing.mod).runId,missing.run.id);noExecute(missing);
 const network=fixture();network.setHook(url=>{if(url.includes('/clean/runs?'))throw new Error('Temporary offline');});await network.subject.loadCleanAcceptanceRuns('clean',true);await network.subject.loadCleanAcceptanceRuns('clean');assert.equal(network.calls.length,1,'Network failures also wait for manual retry');assert.match(text(network.panel()),/刷新核验记录/);noExecute(network);
 const refreshed=fixture();refreshed.t.cleanAcceptance=null;refreshed.t.cleanAcceptanceKey=null;await refreshed.subject.loadCleanAcceptanceRuns('clean',true);assert.ok(refreshed.calls.some(v=>v.url.includes('/clean/verification?')));assert.ok(!refreshed.calls.some(v=>v.url==='/api/codex/clean/verify'),'Loading runs is read only');noExecute(refreshed);
 const polling=fixture({report:{status:'checking'}});polling.panel();assert.equal(polling.timers.size,1);polling.panel();assert.equal(polling.timers.size,1,'Only one checking GET timer');polling.t.busy=true;await polling.tick();assert.equal(polling.calls.length,0,'While executing do not poll');assert.equal(polling.timers.size,1);polling.t.busy=false;polling.setHook(url=>url.includes('/clean/verification?')?{...polling.getReport(),status:'ready'}:undefined);await polling.tick();assert.equal(polling.t.cleanAcceptance.status,'ready');assert.equal(polling.timers.size,0,'A terminal report ends polling');assert.ok(polling.calls.every(v=>v.url.includes('/clean/verification?')),'Polls use GET only');noExecute(polling);
 const changedPoll=fixture({report:{status:'checking'}});changedPoll.panel();changedPoll.t.cleanAcceptanceRunId='run-other';await changedPoll.tick();assert.equal(changedPoll.calls.length,0,'A changed selection stops the old poll');assert.equal(changedPoll.timers.size,0);noExecute(changedPoll);
 const late=fixture();let release;late.setHook(url=>url.includes('/clean/verification?')?new Promise(resolve=>{release=resolve;}):undefined);const pending=late.subject.loadCleanAcceptance(late.mod);late.t.cleanAcceptanceRunId='run-other';release(late.getReport());assert.equal(await pending,null);assert.equal(late.t.cleanAcceptanceLoading,false);noExecute(late);
 // Human standards remain distinct from automatic checks and exception acceptance.
 const manualRule={id:'H01',label:'两个来源的统计口径一致',method:'对照原始口径说明和处理结果',condition:'范围与定义均相同才允许合并',required:true,basis:'已确认业务规则第2条',sourceText:'人工规则H01',resolution:null,history:[]};
 const manual=fixture({report:{status:'needs_manual',manualChecks:[manualRule]}});assert.equal(button(manual.panel(),'确认结果并交给计算').disabled,true);assert.match(text(manual.panel()),/检查方法：对照原始口径说明/);assert.match(text(manual.panel()),/标准依据：已确认业务规则/);assert.equal(all(manual.panel()).find(value=>value['aria-label']==='人工核验 H01').open,true);
 assert.equal(await manual.subject.recordCleanManualCheck(manual.mod,'report-one','H01','passed','已核对','','张研究者'),false);assert.equal(manual.calls.length,0,'Passing requires actual evidence, not just the standard basis');
 assert.equal(await manual.subject.recordCleanManualCheck(manual.mod,'stale-report','H01','passed','核对一致','原表说明及结果第2—4行','张研究者'),false);assert.equal(manual.calls.length,0);
 manual.setBusy(true);assert.equal(await manual.subject.recordCleanManualCheck(manual.mod,'report-one','H01','needs_evidence','缺定义说明','','张研究者'),false);manual.setBusy(false);assert.equal(manual.calls.length,0);
 assert.equal(await manual.subject.recordCleanManualCheck(manual.mod,'report-one','H01','needs_evidence','缺少第二来源定义说明','','张研究者'),true);assert.equal(button(manual.panel(),'确认结果并交给计算').disabled,true);assert.equal(manual.t.cleanAcceptance.checks[0].status,'passed','Human recording does not rewrite automatic check results');
 assert.equal(await manual.subject.recordCleanManualCheck(manual.mod,'report-one','H01','passed','原件补齐，两来源定义与范围一致','原件说明第2页；结果第2—4行；未混入不同定义记录','张研究者'),true);const humanCall=manual.calls.findLast(call=>call.url==='/api/codex/clean/manual-check');assert.deepEqual(humanCall.body,{sessionId:'clean-session',runId:'run-one',reportId:'report-one',checkId:'H01',conclusion:'passed',note:'原件补齐，两来源定义与范围一致',evidence:'原件说明第2页；结果第2—4行；未混入不同定义记录',reviewer:'张研究者',rulesText:manual.run.planText,standardNames:[]});assert.equal(manual.invalidations.length,2,'Every manual change withdraws prior final confirmation');assert.equal(button(manual.panel(),'确认结果并交给计算').disabled,false);assert.match(text(manual.panel()),/历次人工核验记录/);assert.equal(all(manual.panel()).find(value=>value['aria-label']==='人工核验 H01').open,false,'Completed manual checks start collapsed');noExecute(manual);
 const unsignedReady=fixture({report:{status:'ready',manualChecks:[manualRule]}});assert.equal(unsignedReady.subject.cleanAcceptanceReady(unsignedReady.getReport()),false,'A misleading ready status cannot bypass unsigned required manual checks');assert.equal(await unsignedReady.subject.confirmCleanAcceptance('clean'),false);assert.ok(!unsignedReady.actions.includes('create-target'));noExecute(unsignedReady);
 const ambiguous=fixture({report:{status:'needs_manual',manualChecks:[{...manualRule,reason:'通过条件未确定'}]}});assert.equal(await ambiguous.subject.recordCleanManualCheck(ambiguous.mod,'report-one','H01','passed','直接通过','某原件','研究者'),false);assert.equal(button(ambiguous.panel(),'人工核验通过').disabled,true);assert.equal(ambiguous.calls.length,0);noExecute(ambiguous);
 const restored=fixture({report:{status:'ready',manualChecks:manual.t.cleanAcceptance.manualChecks}});restored.t.cleanAcceptance=null;restored.t.cleanAcceptanceKey=null;await restored.subject.loadCleanAcceptanceRuns('clean',true);assert.match(text(restored.panel()),/核验人：张研究者/);assert.match(text(restored.panel()),/原件说明第2页/);assert.ok(restored.calls.every(call=>call.url.includes('/clean/runs?') || call.url.includes('/clean/verification?')));noExecute(restored);
 const contextChanged=fixture({report:{status:'needs_manual',manualChecks:[manualRule]}});let finishManual;contextChanged.setHook(url=>url==='/api/codex/clean/manual-check'?new Promise(resolve=>{finishManual=resolve;}):undefined);const previousReport=contextChanged.t.cleanAcceptance;const saving=contextChanged.subject.recordCleanManualCheck(contextChanged.mod,'report-one','H01','passed','检查一致','原始表与结果第1行','研究者');contextChanged.setProject('another-project');finishManual({...contextChanged.getReport(),status:'ready'});assert.equal(await saving,false);assert.equal(contextChanged.t.cleanAcceptance,previousReport,'A late response cannot replace another project page');noExecute(contextChanged);
 // Reference standards have their own upload path and never enter the data batch.
 const standards=fixture();standards.saved.clean.inputBatch={names:['current.csv'],label:'本批',text:'来源说明'};standards.setHook(url=>url.includes('/api/codex/upload?')?{name:'abcd-标准.xlsx',files:[{group:'input',name:'current.csv',size:50},{group:'reference',name:'abcd-标准.xlsx',size:70}]}:undefined);assert.equal(await standards.subject.uploadCleanStandards(standards.mod,[]),false);assert.equal(standards.actions.length,0,'Read-only opening never creates a session');assert.equal(await standards.subject.uploadCleanStandards(standards.mod,[{name:'标准.xlsx',size:70}]),true);assert.ok(standards.calls[0].url.includes('group=reference'));assert.deepEqual(Array.from(standards.saved.clean.cleanStandardNames),['abcd-标准.xlsx']);assert.deepEqual(standards.saved.clean.inputBatch.names,['current.csv']);assert.match(standards.t.cleanStandardNotice,/尚未采纳/);assert.equal(button(standards.panel(),'确认结果并交给计算').disabled,true,'New standards prevent ignoring them through an old report');assert.equal(await standards.subject.confirmCleanAcceptance('clean'),false);noExecute(standards);
 const referencePlan='既定清洗规则。\n\n### 人工核验标准\n\n| 编号 | 核验内容 | 检查方法 | 通过条件 | 必需 | 依据 |\n|---|---|---|---|---|---|\n| H01 | 范围一致 | 对照定义 | 两来源定义与统计范围一致 | 是 | abcd-标准.xlsx 第1页及other.txt第2条 |';standards.setRule(referencePlan);standards.saved.clean.cleanStandardNames=['abcd-标准.xlsx','other.txt'];standards.run.planText=referencePlan;standards.run.standardFiles=[{name:'abcd-标准.xlsx',group:'reference'},{name:'other.txt',group:'reference'}];standards.setHook(url=>url.startsWith('/api/codex/files?')?{files:[{group:'input',name:'current.csv',size:50},{group:'input',name:'historical.csv',size:40},{group:'input',name:'other.txt',size:10},{group:'reference',name:'abcd-标准.xlsx',size:70},{group:'reference',name:'other.txt',size:10}]}:undefined);assert.equal(await standards.subject.prepareConfirmedExecution('clean'),true);assert.deepEqual(Array.from(standards.t.preparedCleanPlan.inputNames),['current.csv']);assert.deepEqual(Array.from(standards.t.preparedCleanPlan.standardNames),['abcd-标准.xlsx','other.txt']);standards.saved.clean.cleanStandardNames=[];await assert.rejects(()=>standards.subject.reply(standards.mod,[]),/标准原件/);assert.equal(button(standards.panel(),'确认结果并交给计算').disabled,true,'Removing a frozen standard also requires reconciliation');noExecute(standards);
 // Opening discussion stages the same plan only. It cannot confirm, save,
 // send an AI prompt, or execute. Existing unrelated composer text is kept.
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',showModal(){this.open=true;},dispatchEvent(){}});return elements.get(id);};
 get('composer-input').value='已有未发送意见';let prepared=0;const rules={draft:'既有清洗方案',confirmed:'既有清洗方案',versions:[{text:'既有清洗方案'}]},state={activeModuleId:'clean',modules:[{id:'clean',type:'clean-data'}]};
 const discussion=vm.createContext({root:{Store:{getState:()=>state},CleanVerificationRules:compiler},busy:()=>false,pendingRules:null,startingExecution:null,cleanVerificationStage:null,index:{activeTaskId:'fixture'},prepareDiscussion(){prepared++;},rulesFor:()=>rules,current:()=>({}),$:get,render(){},showMessage(){},Event:class{},Error});
 vm.runInContext(fn(tasksSource,'openCleanVerificationDraft')+'\nglobalThis.openDraft=openCleanVerificationDraft;',discussion);assert.equal(discussion.openDraft('clean',{standardNames:['abcd-人工标准.pdf']}),true);assert.equal(prepared,1);assert.equal(rules.confirmed,'既有清洗方案');assert.equal(rules.versions.length,1);assert.match(rules.draft,/### 清洗核验规则/);assert.match(rules.draft,/### 原值与结果核对/);assert.match(rules.draft,/### 人工核验标准/);assert.match(rules.draft,/abcd-人工标准.pdf/);assert.equal(get('composer-input').value,'已有未发送意见');const staged=rules.draft;discussion.openDraft('clean');assert.equal(rules.draft,staged,'No duplicate template');
 vm.runInContext(fn(tasksSource,'discardCleanVerificationStage')+'\nglobalThis.cancelDraft=discardCleanVerificationStage;',discussion);discussion.cancelDraft();assert.equal(rules.draft,'既有清洗方案','Cancelling only restores the uncommitted template draft');
 // Exercise the production close/cancel/input listeners, including the UI
 // refresh and automatically staged composer text. Never send a prompt.
 function discussionEvents(initialComposer='') {
  const eventElements=new Map(),rules={draft:'已确认清洗方案',confirmed:'已确认清洗方案',versions:[{text:'已确认清洗方案'}]};let saves=0,uiRenders=0,visibleManualCount=0;
  const get=id=>{if(!eventElements.has(id)){const handlers=new Map();eventElements.set(id,{value:'',textContent:'',open:false,handlers,showModal(){this.open=true;},close(){this.open=false;},addEventListener(type,handler){handlers.set(type,[...(handlers.get(type)||[]),handler]);},dispatchEvent(event){for(const handler of handlers.get(event.type)||[])handler.call(this,event);}});}return eventElements.get(id);};
  get('composer-input').value=initialComposer;
  const refreshUi=()=>{uiRenders++;visibleManualCount=compiler.compile(rules.draft).manualChecks.rules.length;};
  const ctx=vm.createContext({root:{Store:{getState:()=>({activeModuleId:'clean',modules:[{id:'clean',type:'clean-data'}]})},CleanVerificationRules:compiler,CodexUI:{render:refreshUi}},busy:()=>false,pendingRules:null,startingExecution:null,cleanVerificationStage:null,index:{activeTaskId:'fixture'},prepareDiscussion(){},rulesFor:()=>rules,current:()=>({}),$:get,render(){get('task-summary-draft').value=rules.draft;},refreshControls(){},saveIndex(){saves++;return true;},showMessage(value){get('task-summary-message').textContent=value;},Event:class{constructor(type){this.type=type;}},Error});
  const closeStart=tasksSource.indexOf("  $('rules-dialog-close').addEventListener"),closeEnd=tasksSource.indexOf("  $('task-summary-ai').addEventListener",closeStart);
  const inputStart=tasksSource.indexOf("  $('task-summary-draft').addEventListener('input'"),inputEnd=tasksSource.indexOf("  $('task-summary-history').addEventListener",inputStart);
  vm.runInContext(fn(tasksSource,'openCleanVerificationDraft')+'\n'+fn(tasksSource,'discardCleanVerificationStage')+'\n'+tasksSource.slice(closeStart,closeEnd)+tasksSource.slice(inputStart,inputEnd)+'\nglobalThis.openDraft=openCleanVerificationDraft;',ctx);
  return {rules,get,ctx,refreshUi,get saves(){return saves;},get uiRenders(){return uiRenders;},get visibleManualCount(){return visibleManualCount;},event(id,type){get(id).dispatchEvent({type});}};
 }
 for(const [element,event] of [['rules-dialog-close','click'],['rules-dialog','cancel']]){
  const opening=discussionEvents();assert.equal(opening.ctx.openDraft('clean'),true);opening.refreshUi();assert.equal(opening.visibleManualCount,1);assert.match(opening.get('composer-input').value,/人工标准/);const renders=opening.uiRenders;opening.event(element,event);assert.equal(opening.rules.draft,'已确认清洗方案');assert.equal(opening.rules.confirmed,'已确认清洗方案');assert.equal(opening.rules.versions.length,1);assert.equal(opening.get('composer-input').value,'','Untouched automatic prompt is cancelled through the real event path');assert.equal(opening.visibleManualCount,0,'The Codex summary refreshes after discarding a staged section');assert.ok(opening.uiRenders>renders);assert.match(opening.get('task-summary-message').textContent,/已取消/);assert.equal(opening.saves,0,'Cancelling does not save or confirm a staged template');
 }
 const edited=discussionEvents();edited.ctx.openDraft('clean');edited.get('task-summary-draft').value='用户自行编辑的清洗草稿';edited.event('task-summary-draft','input');edited.event('rules-dialog-close','click');assert.equal(edited.rules.draft,'用户自行编辑的清洗草稿','Do not discard a draft the user edited');assert.equal(edited.get('composer-input').value,'','The untouched automatic prompt can still be cancelled independently');assert.equal(edited.saves,1);assert.match(edited.get('task-summary-message').textContent,/草稿保留/);
 const userPrompt=discussionEvents();userPrompt.ctx.openDraft('clean');userPrompt.get('composer-input').value='用户改写的未发送提示';userPrompt.event('rules-dialog','cancel');assert.equal(userPrompt.get('composer-input').value,'用户改写的未发送提示');assert.equal(userPrompt.rules.draft,'已确认清洗方案');
 const preexisting=discussionEvents('原来已有的未发送内容');preexisting.ctx.openDraft('clean');preexisting.event('rules-dialog-close','click');assert.equal(preexisting.get('composer-input').value,'原来已有的未发送内容');assert.equal(preexisting.rules.draft,'已确认清洗方案');assert.equal(preexisting.saves,0);
 // Both old execution paths are closed for clean-data before any composer API.
 for(const name of ['composeCode','execCode']){let opened=0;const ctx=vm.createContext({root:{TaskManager:{openPlan(){opened++;}}}});vm.runInContext(fn(chatSource,name)+'\nglobalThis.run='+name+';',ctx);ctx.run({type:'clean-data'});assert.equal(opened,1);}
 // Status and document cards guide to the sole acceptance gate; they must
 // never display an enabled duplicate final-confirmation button.
 const chatNode=(tag,cls,value)=>{const n=node(tag,value,cls);n.appendChild=v=>{n.children.push(v);return v;};Object.defineProperty(n,'childNodes',{get:()=>n.children});return n;};
 for(const status of ['todo','doing','review']) {
  const cleanMod={id:'clean',type:'clean-data',status,doc:{status:'approved',content:'本批方案'}},chatState={modules:[cleanMod],activeModuleId:'clean'};
  const chatContext=vm.createContext({root:{},getStore:()=>({getState:()=>chatState,getUpstreamModules:()=>[]}),statusOf:m=>m.status,STATUS_META:{[status]:{glyph:'○',text:'状态'}},STATUS_HINT:{},el:chatNode,actionButton:(label)=>chatNode('button','',label),docButton:(label)=>chatNode('button','',label),formatDateTime:()=>'',isBusy:()=>false,buildDocHistory(){}});
  vm.runInContext(fn(chatSource,'buildStatusBar')+'\n'+fn(chatSource,'buildDocView')+'\nglobalThis.views={buildStatusBar,buildDocView};',chatContext);
  const statusView=chatContext.views.buildStatusBar(cleanMod,[cleanMod]),docView=chatNode('div');chatContext.views.buildDocView(docView,cleanMod,{},'approved');
  const confirmations=[...all(h.panel()),...all(statusView),...all(docView)].filter(v=>v.tag==='button'&&v.textContent==='确认结果并交给计算');assert.equal(confirmations.length,1,'Only the actual acceptance card owns final confirmation: '+status);
  assert.match(text(docView),/清洗核验与待处理问题/);
 }
 assert.match(fn(chatSource,'buildRunGate'),/清洗核验与待处理问题/);
 const reply=fn(source,'reply');assert.match(reply,/preparedCleanPlan/);assert.match(reply,/basis\.text !== cleanPlan\.text/);assert.match(reply,/cleanPlan \? \{cleanPlan\}/);
 const browser={localStorage:{getItem:()=>null,setItem(){}}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/store.js'),'utf8'),{window:browser});
 const real=browser.Store,realMod=real.addModule('数据清洗'),fixedPlan='已确认规则';browser.TaskManager={rulesForModule:()=>({text:fixedPlan})};
 const marker={runId:'11111111-1111-4111-8111-111111111111',reportId:'22222222-2222-4222-8222-222222222222',planSha256:'a'.repeat(64),planText:fixedPlan};
 real.markRun(realMod.id,{artifacts:[{name:'cleaned.csv',size:20}],cleanAcceptance:marker});assert.equal(real.confirmRun(realMod.id),true,'Actual Store accepts the backend-confirmed marker');
 console.log('CLEAN_ACCEPTANCE_UI_TESTS_PASS: automatic/manual gates, evidence/reviewer/history, reference standards, read-only restore, plan/file freeze, context and legacy execution guards');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
