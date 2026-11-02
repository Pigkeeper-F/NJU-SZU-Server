'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
function fn(source, name) { const at=source.indexOf('  function '+name+'(');assert.ok(at>=0,name);return source.slice(at,source.indexOf('\n  }',at)+4); }
class Event { constructor(type, options={}) { Object.assign(this, options, {type, defaultPrevented:false}); } preventDefault() { if(this.cancelable)this.defaultPrevented=true; } }
const chat=read('chat.js'), tasks=read('tasks.js');
const events=[], input={value:'unsent discussion',addEventListener(type,listener){this[type]=listener;}};
const c=vm.createContext({root:{CustomEvent:Event},document:{dispatchEvent(e){events.push({type:e.type,moduleId:e.detail.moduleId,composer:input.value});return true;}},inputEl:input,activeModuleId:()=> 'literature-fixture',autoGrow(){}});
vm.runInContext(fn(chat,'notifyDiscussionDraftChanged'),c);
const at=chat.indexOf("    inputEl.addEventListener('input', function () {");assert.ok(at>=0);
vm.runInContext(chat.slice(at,chat.indexOf('\n    });',at)+8),c);
input.input(); assert.deepEqual(events,[{type:'discussion-draft-change',moduleId:'literature-fixture',composer:'unsent discussion'}]);
Object.assign(c,{pendingModules:{},docUi:{},MAX_INPUT_CHARS:20000,getStore:()=>({appendMessage:()=>({id:'explicit-user-message'})}),render(){},requestReply(){c.replies=(c.replies||0)+1;}});
vm.runInContext(fn(chat,'send'),c);c.send();assert.equal(events.at(-1).composer,'','Snapshot event observes cleared composer after a successful explicit send');assert.equal(c.replies,1);

function projectFixture({cancel=false,save=true,restore=true}={}) {
  const log=[], index={activeTaskId:'project-a',tasks:[{id:'project-a'},{id:'project-b'}]}, messages=[];
  const context=vm.createContext({root:{CustomEvent:Event,Store:{restoreState(){log.push('restore');if(restore==='throw')throw new Error('fixture restore failure');return restore;}},CodexUI:{render(){}}},document:{dispatchEvent(e){log.push([e.type,e.detail.projectId,e.detail.targetProjectId]);if(cancel)e.preventDefault();return !e.defaultPrevented;}},index,switching:false,pendingRules:null,startingExecution:null,busy:()=>false,readState:()=>({modules:[]}),saveState(){log.push('save');return save;},saveIndex(){log.push('index');},showMessage:s=>messages.push(s),render(){}});
  vm.runInContext(fn(tasks,'discussionProjectEvent')+'\n'+fn(tasks,'switchTask'),context);
  return {context,log,index,messages};
}
let h=projectFixture({cancel:true});assert.equal(h.context.switchTask('project-b'),false);assert.equal(h.index.activeTaskId,'project-a');assert.ok(!h.log.includes('restore'));assert.match(h.messages.at(-1),/尚未保存/);
assert.deepEqual(h.log.at(-1),['discussion-project-switch-cancelled','project-a','project-b']);
h=projectFixture({save:false});assert.equal(h.context.switchTask('project-b'),false);assert.ok(!h.log.includes('restore'));assert.equal(h.index.activeTaskId,'project-a');
assert.deepEqual(h.log.at(-1),['discussion-project-switch-cancelled','project-a','project-b']);
for(const restore of [false,'throw']) {h=projectFixture({restore});assert.equal(h.context.switchTask('project-b'),false);assert.equal(h.index.activeTaskId,'project-a');assert.equal(h.context.switching,false);assert.deepEqual(h.log.at(-1),['discussion-project-switch-cancelled','project-a','project-b']);}
h=projectFixture();assert.equal(h.context.switchTask('project-b'),true);assert.deepEqual(h.log[0],['discussion-project-before-switch','project-a','project-b']);assert.deepEqual(h.log.at(-1),['discussion-project-after-switch','project-b','project-b']);assert.equal(h.index.activeTaskId,'project-b');
console.log('DISCUSSION_DRAFT_EVENTS_UI_TESTS_PASS');
