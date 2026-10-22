'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {buildComposePrompt}=require('../server');
const chat=fs.readFileSync(path.join(__dirname,'../js/chat.js'),'utf8');
const storeSource=fs.readFileSync(path.join(__dirname,'../js/store.js'),'utf8');
function fn(name){const start=chat.indexOf('  function '+name+'(');assert.ok(start>=0,name);return chat.slice(start,chat.indexOf('\n  }',start)+4);}
function boot(data,deny){const browser={localStorage:{getItem:key=>data.get(key)||null,setItem:(key,value)=>{if(deny()&&key==='fa_doc_history_v1')throw new Error('quota');data.set(key,String(value));}}};vm.runInNewContext(storeSource,{window:browser});return browser.Store;}
async function main(){
  const data=new Map();let failHistory=false;const store=boot(data,()=>failHistory);
  const mod=store.addModule('下载数据');
  const original='已确认方案：FAOSTAT TM 2024；进出口数量和金额；保留代码与单位。\n'+'保留既定验收要求。'.repeat(550)+'\n完整基线末尾';
  store.saveDoc(mod.id,original);store.approveDoc(mod.id);
  const approved=JSON.stringify(store.getState().modules[0].doc);
  const requests=[];let resolve,reject;
  const root={CodexUI:{useCodex:()=>true,getModel:()=> 'gpt-6.1-sol',busy:()=>false}};
  const context=vm.createContext({root,docUi:{},pendingModules:{},inputEl:{value:''},MAX_DOC_CHARS:20000,
    getStore:()=>store,findModule:(items,id)=>items.find(item=>item.id===id),templateOf:()=> 'standard',render(){},
    messagesFor:()=>[{role:'user',text:'最新确认：只保留进出口数量，金额取消，其他规则不变。'}],
    readLlmSettings:()=>null,errorText:(prefix,error)=>prefix+'：'+error.message,
    postCompose:(mode,module,template,extra)=>{requests.push(context.subject.composeBody(mode,module,template,extra));return new Promise((yes,no)=>{resolve=value=>yes(typeof value==='string'?{text:value}:value);reject=no;});}});
  vm.runInContext(['uiOf','composeBody','isBusy','generateDoc'].map(fn).join('\n')+'\nthis.subject={generateDoc,composeBody,isBusy,uiOf};',context);
  const revision=context.subject.generateDoc(store.getState().modules[0],true);
  assert.equal(context.subject.isBusy(),true);
  assert.equal(JSON.stringify(store.getState().modules[0].doc),approved,'AI返回前不改已审核方案');
  assert.equal(requests[0].revision.baseDoc.content,original,'完整基线不能被普通对话长度截断');
  assert.equal(requests[0].codexModel,'gpt-6.1-sol');
  const prompt=buildComposePrompt(requests[0]);
  assert.ok(prompt.includes(original));
  assert.match(prompt,/完整修订草稿|完整修订/);
  assert.match(prompt,/金额取消/);
  assert.match(prompt,/不执行任务/);
  resolve('修订草稿：TM 2024，仅进出口数量；保留原有代码、单位和验收规则。');await revision;
  assert.equal(context.subject.isBusy(),false);
  assert.equal(store.getState().modules[0].doc.status,'draft');
  const history=store.getDocHistory(mod.id);
  assert.equal(history.length,1);assert.equal(history[0].content,original);assert.equal(history[0].status,'approved');
  history[0].content='外部改动';assert.equal(store.getDocHistory(mod.id)[0].content,original);
  const reloaded=boot(data,()=>false);
  assert.equal(reloaded.getDocHistory(mod.id)[0].content,original);
  assert.equal(reloaded.getState().modules[0].doc.status,'draft');
  // Restore must create a draft and archive the displaced revision, never auto-approve.
  store.saveDoc(mod.id,store.getDocHistory(mod.id)[0].content);
  assert.equal(store.getState().modules[0].doc.status,'draft');
  assert.equal(store.getDocHistory(mod.id).length,2);
  store.approveDoc(mod.id);
  const beforeFailure=JSON.stringify(store.getState().modules[0].doc);
  const failed=context.subject.generateDoc(store.getState().modules[0],true);reject(new Error('fixture network failure'));await failed;
  assert.equal(JSON.stringify(store.getState().modules[0].doc),beforeFailure);
  assert.match(context.subject.uiOf(mod.id).genErr,/fixture network failure/);
  // A late AI result cannot overwrite manual changes made after its frozen baseline.
  const late=context.subject.generateDoc(store.getState().modules[0],true);
  store.saveDoc(mod.id,'人工修改后的新方案');
  const manual=JSON.stringify(store.getState().modules[0].doc);
  resolve('已过时的AI结果');await late;
  assert.equal(JSON.stringify(store.getState().modules[0].doc),manual);
  assert.match(context.subject.uiOf(mod.id).genErr,/未覆盖/);
  const newDiscussion=context.subject.generateDoc(store.getState().modules[0],true);
  store.appendMessage(mod.id,'期间新增的确定要求','user');
  const beforeDiscussion=JSON.stringify(store.getState().modules[0].doc);
  resolve('遗漏新增讨论的结果');await newDiscussion;
  assert.equal(JSON.stringify(store.getState().modules[0].doc),beforeDiscussion);
  assert.match(context.subject.uiOf(mod.id).genErr,/最新讨论/);
  // Failed archival must retain the current plan and status.
  store.approveDoc(mod.id);const locked=JSON.stringify(store.getState().modules[0].doc);
  failHistory=true;
  assert.equal(store.saveDoc(mod.id,'不得覆盖'),null);
  assert.equal(store.rejectDoc(mod.id,'不得丢失已审核版本'),false);
  assert.equal(JSON.stringify(store.getState().modules[0].doc),locked);
  failHistory=false;
  const requestCount=requests.length;context.inputEl.value='尚未发送的修改意见';
  context.subject.generateDoc(store.getState().modules[0],true);
  assert.equal(requests.length,requestCount);assert.equal(context.inputEl.value,'尚未发送的修改意见');
  assert.match(context.subject.uiOf(mod.id).genErr,/请先发送/);
  assert.throws(()=>buildComposePrompt({mode:'doc',module:{type:'download-data'},revision:{baseDoc:{content:'x'.repeat(20001)}}}),/最长20000/);
  console.log('PLAN_REVISION_TESTS_PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
