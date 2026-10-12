import test from 'node:test';import assert from 'node:assert/strict';
import * as ui from '../ui/phase-progress.js';
import {dashboardView} from '../ui/view-model.js';
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.style={};this.attributes={};this.open=false;this.textContent='';}
 append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}setAttribute(k,v){this.attributes[k]=String(v);}querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tagName===tag?[c]:[]),...c.querySelectorAll(tag)]);}
}
const document={createElement:tag=>new Element(tag)};
const plan={source:'IMPLEMENTATION_PLAN.md',completed:2,total:4,percent:50,currentPhase:1,activeTask:{id:'P1-test',name:'Current real task'},phases:[{number:0,title:'Foundation',completed:1,total:1,percent:100,tasks:[{title:'Setup',completed:true,depth:0}]},{number:1,title:'Companion',completed:1,total:2,percent:50,tasks:[{title:'Registry',completed:true,depth:0},{title:'Manual import',completed:false,depth:0}]},{number:2,title:'Intelligence',completed:0,total:1,percent:0,tasks:[{title:'Builds',completed:false,depth:0}]}]};
test('left progress renders real phases, current subtasks, counts and active task without inventing completion',()=>{
 assert.equal(typeof ui.createPhaseProgress,'function');const root=new Element('section');const view=ui.createPhaseProgress(root,document);view.render(plan);
 const phases=root.querySelectorAll('details');assert.equal(phases.length,3);assert.equal(phases[1].open,true);assert.equal(phases[0].open,false);assert.match(phases[1].querySelectorAll('summary')[0].textContent,/Phase 1.*Companion.*1 \/ 2/);
 assert.equal(phases[1].querySelectorAll('li')[1].textContent,'○ Manual import');assert.equal(root.querySelectorAll('progress')[0].attributes.value,'2');
 assert.match(root.querySelectorAll('p').at(-1).textContent,/P1-test.*Current real task/);
});
test('phase expansion survives polling, including a deliberately collapsed current phase',()=>{
 assert.equal(typeof ui.createPhaseProgress,'function');const root=new Element('section');const view=ui.createPhaseProgress(root,document);view.render(plan);root.querySelectorAll('details')[1].open=false;root.querySelectorAll('details')[2].open=true;view.render(plan);assert.equal(root.querySelectorAll('details')[1].open,false);assert.equal(root.querySelectorAll('details')[2].open,true);
});
test('Resolver running and blocked results are distinct from QA acceptance',()=>{
 const view=dashboardView({stage:'resolving',resolverRunning:true,resolverAvailable:false,resolverResult:{status:'blocked',failureReason:'Needs approval'}});assert.equal(view.primaryLabel,'Resolving');assert.equal(view.resolver.running,true);assert.match(view.resolver.result,/Needs approval/);assert.equal(view.qaChecks.tests,'NOT RUN');
});
