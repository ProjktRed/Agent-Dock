import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {queuePlanTick,applyPlanTicksBetweenTasks} from '../src/plan-stewardship.mjs';

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

test('an approved task checks off its plan item between tasks, as its own commit; unknown items are reported',async t=>{
 const {ws,state}=await repo(t),events=fakeState();
 await queuePlanTick({stateDir:state,taskId:'T7',item:'Docs'});
 await queuePlanTick({stateDir:state,taskId:'T8',item:'- [ ] Something   not in the plan'});
 await writeFile(path.join(ws,'app.js'),'dirty');
 assert.match((await applyPlanTicksBetweenTasks({stateDir:state,workspace:ws})).waiting,/uncommitted/,'waits for a clean tree');
 git(ws,'checkout','--','app.js');
 const head=git(ws,'rev-parse','HEAD');
 assert.deepEqual(await applyPlanTicksBetweenTasks({stateDir:state,workspace:ws,state:events}),{ticked:1});
 assert.equal(git(ws,'rev-parse','HEAD~1'),head);
 assert.equal(git(ws,'show','--name-only','--format=%s','HEAD'),'Plan: check off Docs\n\nIMPLEMENTATION_PLAN.md');
 assert.equal(await readFile(path.join(ws,'IMPLEMENTATION_PLAN.md'),'utf8'),PLAN.replace('- [ ] Docs','- [x] Docs'),'only that box changes; line endings kept');
 assert.deepEqual(events.events.map(e=>e.type),['plan-item-done','plan-tick-skipped']);
 assert.match(events.events[1].message,/No unchecked plan item reads "Something not in the plan"/);
 assert.deepEqual(await applyPlanTicksBetweenTasks({stateDir:state,workspace:ws}),{ticked:0},'the queue is consumed');
});

test('an item copied with its Task priority key or phase label is still checked off',async t=>{
 const {ws,state}=await repo(t);const events=fakeState();
 await queuePlanTick({stateDir:state,taskId:'T1',item:'Phase 2: Docs'});
 await queuePlanTick({stateDir:state,taskId:'T2',item:'[0123456789ab] Old idea'});
 assert.deepEqual(await applyPlanTicksBetweenTasks({stateDir:state,workspace:ws,state:events}),{ticked:2});
 const plan=await readFile(path.join(ws,'IMPLEMENTATION_PLAN.md'),'utf8');
 assert.ok(plan.includes('- [x] Docs'));assert.ok(plan.includes('- [x] Old idea'));
 assert.deepEqual(events.events.map(e=>e.type),['plan-item-done','plan-item-done']);
});

