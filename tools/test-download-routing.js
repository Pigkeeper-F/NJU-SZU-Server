'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../js/codex.js'),'utf8');
const literature=fs.readFileSync(path.join(__dirname,'../js/literature.js'),'utf8');
const {workflowPrompt}=require('../server');
function fn(text,name) {
  const start=text.indexOf('  function '+name+'(');
  assert.ok(start>=0,name);
  const end=text.indexOf('\n  }',start);
  return text.slice(start,end+4);
}
class Element {
  constructor(){this.value='';this.disabled=false;this.textContent='';this.open=false;this.children=[];}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  setAttribute(name,value){this[name]=value;}
  before(){}
  showModal(){this.open=true;}
  close(){this.open=false;}
}
async function main(){
  const data=new Map(), elements=new Map(), calls=[], saved={};
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const browser={localStorage:{getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/store.js'),'utf8'),{window:browser});
  const store=browser.Store, mod=store.addModule('下载数据');
  const task={busy:false}; const files=[{name:'fixture-TM_2024.csv',group:'input',size:42}];
  const context=vm.createContext({root:{TaskManager:{rulesForModule:()=>({text:'历史规则',version:1})}},Store:store,
    task:()=>task, saved,document:{getElementById:get},render(){},persist(){},ModuleSpace:{render(){}},
    session:async id=>{saved[id]=saved[id]||{};return 'fixture-session';},
    request:async(url,options)=>{calls.push({url,body:options?JSON.parse(options.body):null});return url.includes('fetch-source')
      ?{download:{storedName:'fixture-TM_2024.csv',name:'TM_2024.csv',size:42},files}:{files};}
  });
  const start=source.indexOf("  document.getElementById('download-start').onclick = async () => {");
  const end=source.indexOf('  async function handoffDownload(',start);
  vm.runInContext('let downloadModuleId=null,downloadBasis=null;\n'+fn(source,'basisForDownload')+'\n'+fn(source,'openDownload')+'\n'+source.slice(start,end)+'\nthis.subject={openDownload,basisForDownload};',context);
  store.saveDoc(mod.id,'FAOSTAT TM 2024；https://data.example.org/TM_2024.csv');
  assert.equal(context.subject.openDownload(store.getState().modules[0]),false,'未审核方案不能用旧规则授权');
  store.approveDoc(mod.id);
  assert.equal(context.subject.openDownload(store.getState().modules[0]),true);
  assert.equal(get('download-dialog').open,true);
  assert.match(get('download-basis').textContent,/TM 2024/);
  assert.equal(get('download-sources').value,'https://data.example.org/TM_2024.csv');
  // Freeze approval at actual execution too: editing while the dialog is open must block.
  store.saveDoc(mod.id,'修改后的下载范围');
  await get('download-start').onclick();
  assert.equal(calls.length,0);
  assert.match(get('download-status').textContent,/重新审核/);
  store.saveDoc(mod.id,'FAOSTAT TM 2024；https://data.example.org/TM_2024.csv');store.approveDoc(mod.id);
  context.subject.openDownload(store.getState().modules[0]);
  await get('download-start').onclick();
  assert.equal(calls[0].url,'/api/codex/fetch-source');
  assert.equal(calls[0].body.confirm,true);
  assert.match(calls[0].body.rules,/TM 2024/);
  assert.equal(calls.some(call=>call.url.includes('literature')),false);
  assert.equal(store.getState().modules[0].run.status,'ran');
  assert.equal(saved[mod.id].download.files.length,1);
  assert.equal(context.subject.openDownload({id:'literature',type:'literature-mining'}),false);
  const prompt=workflowPrompt({type:'download-data'},'codex');
  assert.match(prompt,/实际HTTP\(S\)文件地址/);
  assert.doesNotMatch(prompt,/网页文献执行面板支持|首批最多3篇/);
  assert.match(prompt,/当前没有数据库网页自动操作、按年查询或分页API连接器/);
  assert.match(workflowPrompt({type:'literature-mining'},'codex'),/网页文献执行面板支持/);
  // The obsolete executor must reject a download module before any network operation.
  const legacyContext=vm.createContext({});
  const startFn=literature.slice(literature.indexOf('  async function start(mod)'),literature.indexOf('  async function resume(mod)'));
  vm.runInContext(startFn+'\nthis.start=start;',legacyContext);
  assert.equal(await legacyContext.start({type:'download-data'}),false);
  // Reload an old misrouted batch: preserve storage/artifacts but keep questions out of the data conversation.
  const old={id:'old-batch',sessionId:'fixture-session',status:'waiting',stage:'plan',progress:'旧流程等待',updatedAt:'2026-10-20',
    questions:['请明确本次检索主题或检索式'],candidateCount:0,selected:[],rowCount:0,artifacts:[],files:[]};
  const oldStorage=new Map([['research_literature_runs_v1',JSON.stringify({[mod.id]:{id:old.id,sessionId:old.sessionId}})]]);
  const oldBytes=oldStorage.get('research_literature_runs_v1');
  const inserted=[],notifications=[];
  const historyBrowser={Store:store,CodexUI:{refresh:async()=>{}},ModuleSpace:{isBusy:()=>false}};
  const oldContext=vm.createContext({window:historyBrowser,Store:{getState:()=>store.getState(),subscribe(){},appendMessage:(...args)=>notifications.push(args)},
    localStorage:{getItem:key=>oldStorage.get(key)||null,setItem:(key,value)=>oldStorage.set(key,value)},
    document:{createElement:()=>{const el=new Element();inserted.push(el);return el;},getElementById:id=>({hidden:id==='records-view',before(){}})},
    fetch:async()=>({ok:true,json:async()=>old})});
  vm.runInContext(literature,oldContext);
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(historyBrowser.LiteratureUI.context(mod.id),'');
  assert.equal(oldStorage.get('research_literature_runs_v1'),oldBytes);
  assert.equal(notifications.length,0);
  const texts=inserted.map(el=>el.textContent);
  assert.ok(texts.includes('旧版文献批次记录（只读保留）'));
  assert.ok(!texts.includes('提交答复并继续执行'));
  assert.ok(!texts.includes('请明确本次检索主题或检索式'));
  console.log('DOWNLOAD_ROUTING_TESTS_PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
