'use strict';
// Cross-language sidecar -> real screening contract -> Python PDF gate.
// Local fixtures and a mock model only; no network/browser/research task.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const screening=require('./literature-screening');
const metadata=require('./literature-metadata');
const root=path.resolve(__dirname,'..');
const dir=fs.mkdtempSync(path.join(root,'metadata-test-'));
const python=fs.existsSync(path.join(root,'.venv/Scripts/python.exe'))?path.join(root,'.venv/Scripts/python.exe'):'python';
function py(script){
  const result=spawnSync(python,['-X','utf8','-c',script,__dirname,dir],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.stderr||String(result.error||''));
  return result.stdout;
}
const policy={id:'TEST',line:'production',text:'原始温度对照和生产终点；缺证据待定。'};
async function main(){
  py(`import sys,json;from pathlib import Path
sys.path.insert(0,sys.argv[1])
from literature_metadata import run
p=Path(sys.argv[2]);r={'candidate_id':'R1','source_key':'scopus','title':'Heat stress and broiler growth','doi':'10.1234/abc','result_url':'https://publisher.example/article/1','snippet':'Search preview only','evidence_level':'search_result_snippet'}
(p/'candidates.json').write_text(json.dumps({'records':[r]}),encoding='utf-8')
class Fetcher:
 def fetch(self,url,timeout_sec):return {'status':'ok','url':url,'snapshot':{'title':r['title'],'doi':r['doi'],'abstract':'Broilers were randomly allocated to thermoneutral and heat stress groups. Weight gain was measured.','abstract_method':'explicit_abstract_dom','abstract_selector':'#abstract','abstract_complete':True,'keywords':['growth']}}
run({},p,fetcher=Fetcher(),on_event=lambda *a,**k:None)
`);
  const original=fs.readFileSync(path.join(dir,'candidates.json'),'utf8');
  const stateFile=path.join(dir,'metadata/status.json');
  const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  const originalBundle=screening.loadInputs(dir)[0];
  assert.equal(originalBundle.documents[0].keywords[0],'growth');
  assert.match(originalBundle.documents[0].abstract,/thermoneutral/);
  const snapshots=new Map();
  const bridge={createSession:()=>({id:'fixture'}),async run(id,messages){
    const bundle=JSON.parse(messages[0].content.split('【本篇可用原始证据；全文尚未下载】\n')[1].split('\n只判断本篇')[0]);
    snapshots.set('one',{status:'completed',model:'fixture',text:JSON.stringify({paper_id:'R1',decision:'include',reason:'Temperature comparison and growth outcome.',exclusionRule:'',uncertainties:[],evidence:[{source_id:'R1',field:'abstract',quote:bundle.documents[0].abstract,criterion:'target'}]})});
    return {id:'one'};
  },snapshot:id=>snapshots.get(id)};
  await screening.runScreeningStage({root,bridge,jobDir:dir,config:{screeningPolicy:policy}});
  fs.writeFileSync(path.join(dir,'policy.json'),JSON.stringify(policy));
  const gate=()=>JSON.parse(py(`import sys,json;from pathlib import Path
sys.path.insert(0,sys.argv[1]);from literature_screening import gate_targets
p=Path(sys.argv[2]);print(json.dumps(gate_targets(p,[{'paper_id':'R1'}],json.loads((p/'policy.json').read_text(encoding='utf-8')))))`));
  assert.equal(gate().targets[0].extraction_allowed,true);
  assert.equal(fs.readFileSync(path.join(dir,'candidates.json'),'utf8'),original);
  const record=JSON.parse(original).records[0];
  assert.equal(metadata.validatedEvidence({...record,doi:'10.1234/other'},saved.items.R1),null);
  saved.items.R1.evidence.abstract='Tampered text';
  fs.writeFileSync(stateFile,JSON.stringify(saved));
  assert.equal(screening.loadInputs(dir)[0].documents[0].abstract,'');
  assert.deepEqual(gate().unscreened,['R1']);
  console.log('OK metadata sidecar -> JS screening -> Python download gate; stale/tampered evidence rejected');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  assert.equal(path.dirname(path.resolve(dir)),root);
  fs.rmSync(dir,{recursive:true,force:true});
});
