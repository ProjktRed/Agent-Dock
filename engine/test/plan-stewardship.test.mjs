import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {applyApprovedPlanProposals,checkPlanEdits,decidePlanProposal,listPlanProposals,planExcerpt,proposePlanChange,readPlanProposals} from '../src/plan-stewardship.mjs';
import {buildReviewPrompt,parseReview} from '../src/supervisor-review.mjs';
import {awaitSupervisorReview,parseSupervisorOptions,startSupervisor,superviseEvent} from '../src/supervisor.mjs';

const PLAN=['# Plan','','## Phase 1 — Setup','- [x] Create repo','- [ ] Add login and signup and password reset','','## Phase 2 — Polish','- [ ] Old idea','- [ ] Docs','','## Phase 3 — Done','- [x] Shipped',''].join('\r\n');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
async function repo(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'plan-steward-')),ws=path.join(dir,'ws'),state=path.join(dir,'state');
 t.after(()=>rm(dir,{recursive:true,force:true}));
 execFileSync('git',['init','-q',ws]);
 for(const [k,v] of [['core.autocrlf','false'],['user.email','t@t'],['user.name','T'],['commit.gpgsign','false']])git(ws,'config',k,v);
 await writeFile(path.join(ws,'IMPLEMENTATION_PLAN.md'),PLAN);await writeFile(path.join(ws,'app.js'),'1');
 git(ws,'add','.');git(ws,'commit','-qm','init');
 await mkdir(state);
 return {ws,state};
}
const fakeState=()=>{const s={live:{task:{id:'T1',name:'Thing',allowedPaths:['a.js']}},events:[],setControl:async()=>{},record:async e=>{s.events.push(e);},readLive:async()=>s.live,readEvents:async()=>[]};return s;};

test('plan edits: split, add and remove open items; line endings kept; a preview shows the change',()=>{
 const r=checkPlanEdits(PLAN,[
  {op:'edit',line:'- [ ] Add login and signup and password reset',text:'- [ ] Add login'},
  {op:'add',line:'- [ ] Add login and signup and password reset',text:'- [ ] Add signup and password reset'},
  {op:'remove',line:'- [ ] Old idea  ',text:''}]);
 assert.equal(r.ok,true);
 assert.equal(r.text,PLAN.replace('- [ ] Add login and signup and password reset','- [ ] Add login\r\n- [ ] Add signup and password reset').replace('- [ ] Old idea\r\n',''));
 assert.match(r.preview,/@@ line 5\n- - \[ \] Add login and signup and password reset\n\+ - \[ \] Add login\n\+ - \[ \] Add signup/);
 assert.match(r.preview,/@@ line 8\n- - \[ \] Old idea/);
});

test('plan edits never check an item off, touch checked items or headings, or guess an ambiguous line',()=>{
 const refuse=(edits,re)=>{const r=checkPlanEdits(PLAN,edits);assert.equal(r.ok,false);assert.match(r.errors.join('\n'),re);};
 refuse([{op:'edit',line:'- [ ] Docs',text:'- [x] Docs'}],/cannot check off/);
 refuse([{op:'add',line:'- [ ] Docs',text:'- [X] Done thing'}],/cannot check off/);
 refuse([{op:'remove',line:'- [x] Create repo',text:''}],/checked items/);
 refuse([{op:'edit',line:'## Phase 2 — Polish',text:'## Phase 2 — Later'}],/headings/);
 refuse([{op:'edit',line:'- [ ] Missing',text:'x'}],/not in the plan/);
 refuse([{op:'edit',line:'',text:'x'}],/not in the plan/);
 refuse([{op:'edit',line:'- [ ] Docs',text:'a\nb'}],/one non-empty line/);
 refuse([{op:'edit',line:'- [ ] Docs',text:'- [ ] A'},{op:'remove',line:'- [ ] Docs',text:''}],/edited twice/);
 assert.match(checkPlanEdits('- [ ] A\n- [ ] A\n',[{op:'remove',line:'- [ ] A',text:''}]).errors[0],/more than once/);
 // The reviewer sees phases with open work, not finished ones.
 assert.match(planExcerpt(PLAN),/Phase 2 — Polish\n- \[ \] Old idea\n- \[ \] Docs/);
 assert.doesNotMatch(planExcerpt(PLAN),/Shipped/);
});

test('the review carries plan edits; malformed ones become none; the prompt shows the plan only when on',()=>{
 const r=parseReview(JSON.stringify({summary:'s',actions:[],plan:{reason:'split',edits:[{op:'edit',line:'- [ ] Docs\nextra',text:'- [ ] Write docs'},{op:'rewrite',line:'x',text:'y'}]}}));
 assert.deepEqual(r.plan,{reason:'split',edits:[{op:'edit',line:'- [ ] Docs',text:'- [ ] Write docs'}]});
 assert.deepEqual(parseReview('{"summary":"s","actions":[],"plan":"nope"}').plan,{reason:'',edits:[]});
 const base={alert:{monitor:'plan drift',message:'m'},task:null,events:[],plan:null,deferred:[],mayDefer:false};
 assert.match(buildReviewPrompt({...base,planText:PLAN,planProposals:true}),/exact lines\):\n[\s\S]*- \[ \] Docs/);
 assert.match(buildReviewPrompt({...base,planText:PLAN,planProposals:false}),/Plan edits are off/);
 assert.equal(parseSupervisorOptions({'sv-plan-proposals':'false'}).planProposals,false);
 assert.equal(parseSupervisorOptions({}).planProposals,true);
 assert.throws(()=>parseSupervisorOptions({'sv-plan-proposals':'yes'}),/true or false/);
});

test('a proposal changes nothing until approved; approval commits only the plan, and waits for a clean tree',async t=>{
 const {ws,state}=await repo(t),events=fakeState();
 const head=git(ws,'rev-parse','HEAD');
 assert.equal((await proposePlanChange({stateDir:state,workspace:ws,reason:'x',edits:[{op:'remove',line:'- [x] Create repo',text:''}]})).errors.length,1);
 const p=await proposePlanChange({stateDir:state,workspace:ws,reason:'Drop the old idea',edits:[{op:'remove',line:'- [ ] Old idea',text:''}],state:events});
 assert.equal(p.status,'pending');assert.equal(await readFile(path.join(ws,'IMPLEMENTATION_PLAN.md'),'utf8'),PLAN);
 assert.equal(events.events[0].type,'plan-proposal');
 assert.deepEqual(await applyApprovedPlanProposals({stateDir:state,workspace:ws}),{applied:0});
 await decidePlanProposal({stateDir:state,id:p.id,decision:'approve',state:events});
 await writeFile(path.join(ws,'app.js'),'dirty');
 assert.match((await applyApprovedPlanProposals({stateDir:state,workspace:ws})).waiting,/uncommitted/);
 assert.equal(git(ws,'rev-parse','HEAD'),head);
 git(ws,'checkout','--','app.js');
 assert.deepEqual(await applyApprovedPlanProposals({stateDir:state,workspace:ws,state:events}),{applied:1});
 assert.equal(git(ws,'rev-parse','HEAD~1'),head);
 assert.equal(git(ws,'show','--name-only','--format=%s','HEAD'),'Plan: Drop the old idea\n\nIMPLEMENTATION_PLAN.md');
 assert.equal(git(ws,'status','--porcelain'),'');
 assert.doesNotMatch(await readFile(path.join(ws,'IMPLEMENTATION_PLAN.md'),'utf8'),/Old idea/);
 const [stored]=await readPlanProposals(state);
 assert.equal(stored.status,'applied');assert.equal(stored.commit,git(ws,'rev-parse','HEAD'));
 await assert.rejects(decidePlanProposal({stateDir:state,id:p.id,decision:'dismiss'}),/already applied/);
 // A proposal the plan has outgrown is flagged, and fails instead of guessing when applied.
 const q=await proposePlanChange({stateDir:state,workspace:ws,reason:'Docs',edits:[{op:'edit',line:'- [ ] Docs',text:'- [ ] Write docs'}]});
 await writeFile(path.join(ws,'IMPLEMENTATION_PLAN.md'),(await readFile(path.join(ws,'IMPLEMENTATION_PLAN.md'),'utf8')).replace('- [ ] Docs','- [x] Docs'));git(ws,'commit','-qam','qa');
 assert.equal((await listPlanProposals({stateDir:state,workspace:ws})).find(x=>x.id===q.id).applies,false);
 await decidePlanProposal({stateDir:state,id:q.id,decision:'approve'});
 assert.deepEqual(await applyApprovedPlanProposals({stateDir:state,workspace:ws}),{applied:0});
 assert.equal((await readPlanProposals(state)).find(x=>x.id===q.id).status,'failed');
});

test('a Supervisor review with plan edits stores a pending proposal and never edits the plan',async t=>{
 const {ws,state}=await repo(t),events=fakeState();
 const reviewer=async()=>({summary:'Plan item too big',actions:[],plan:{reason:'Split login work',edits:[{op:'edit',line:'- [ ] Add login and signup and password reset',text:'- [ ] Add login'}]}});
 const stop=startSupervisor(events,{workspace:ws,stateDir:state,config:{mode:'alert',repeatFailures:2,review:'propose',reviewMax:3},reviewer});
 await superviseEvent({type:'retry',qa:'Lint failed'});await superviseEvent({type:'retry',qa:'Lint failed'});
 await awaitSupervisorReview();stop();
 const [p]=await readPlanProposals(state);
 assert.equal(p.status,'pending');assert.equal(p.reason,'Split login work');
 assert.ok(events.events.some(e=>e.type==='plan-proposal'));
 assert.equal(await readFile(path.join(ws,'IMPLEMENTATION_PLAN.md'),'utf8'),PLAN);
});
