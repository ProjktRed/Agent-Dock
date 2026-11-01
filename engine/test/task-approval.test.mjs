import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {runNodeLoop} from '../src/node-loop.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';

// Settings › Approve each task: a new task waits for you before Implementation starts.
async function setup(t){
 const ws=await mkdtemp(path.join(os.tmpdir(),'appr-ws-')),stateDir=await mkdtemp(path.join(os.tmpdir(),'appr-state-'));
 t.after(()=>Promise.all([rm(ws,{recursive:true,force:true}),rm(stateDir,{recursive:true,force:true})]));
 const git=(...args)=>execFileSync('git',args,{cwd:ws,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','t@example.com');git('config','user.name','T');
 await writeFile(path.join(ws,'a.js'),'1\n');git('add','.');git('commit','-qm','base');
 const state=new DashboardState({stateDir});await state.initialize({task:{id:'boot',prompt:'x'},workspace:ws});
 return {ws,stateDir,state,head:git('rev-parse','HEAD')};
}
const task={id:'T1',name:'Add a thing',prompt:'Task skill: implement\nAdd a thing',allowedPaths:['a.js'],qaCommand:'npm test'};

/** Answers the approval request once it appears, as the app's button would. */
function answer(state,action){
 const timer=setInterval(async()=>{
  const events=await state.readEvents(50);
  if(!events.some(e=>e.type==='task-approval-requested'))return;
  clearInterval(timer);await state.setControl(action,{source:'app',reason:'T1'});
 },5);
 return ()=>clearInterval(timer);
}

test('a set-aside task never reaches Implementation; Assessment chooses again',async t=>{
 const {ws,stateDir,state,head}=await setup(t);
 let assessed=0,worker=0;
 const stop=answer(state,'reject-task');t.after(stop);
 const result=await runNodeLoop({workspace:ws,stateDir,objective:'Build',approveTasks:true,codex:{activeCount:0,assertIdle:async()=>{}},
  assess:async()=>(++assessed===1?{status:'task',task}:{status:'done'}),
  worker:{withExclusive:fn=>fn(),run:async()=>{worker++;return{exitCode:0};}},
  baseline:async()=>({head}),readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:20});
 assert.equal(worker,0,'Implementation never ran');
 const events=await state.readEvents(80);
 const asked=events.find(e=>e.type==='task-approval-requested');
 assert.deepEqual({id:asked.taskId,paths:asked.allowedPaths,check:asked.qaCommand},{id:'T1',paths:['a.js'],check:'npm test'});
 assert.ok(events.some(e=>e.type==='task-deferred'&&e.taskId==='T1'));
 assert.ok(['deferred','done'].includes(result.status));
});

test('an approved task goes on to Implementation; without the setting nothing waits',async t=>{
 for(const approveTasks of [true,false]){
  const {ws,stateDir,state,head}=await setup(t);
  let worker=0;
  const stop=approveTasks?answer(state,'approve-task'):()=>{};t.after(stop);
  await runNodeLoop({workspace:ws,stateDir,objective:'Build',approveTasks,codex:{activeCount:0,assertIdle:async()=>{},resolveBlocked:async()=>({status:'blocked'})},
   assess:async()=>({status:'task',task}),
   worker:{withExclusive:fn=>fn(),run:async()=>{worker++;throw new Error('stop here');}},
   baseline:async()=>({head}),readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:20}).catch(()=>null);
  const events=await state.readEvents(80);
  assert.ok(worker>=1,`Implementation ran (approveTasks ${approveTasks})`);
  assert.equal(events.some(e=>e.type==='task-approval-requested'),approveTasks);
  if(approveTasks)assert.ok(events.some(e=>e.type==='task-approved'&&e.source==='app'));
 }
});

test('an answer for another task, or from before the request, does not count',async t=>{
 const {ws,stateDir,state,head}=await setup(t);
 // A failed assertion must not leave the loop polling forever (it held the whole test file on Windows CI).
 t.after(()=>state.setControl('stop',{source:'app'}).catch(()=>{}));
 await state.setControl('approve-task',{source:'app',reason:'T1'});
 await new Promise(r=>setTimeout(r,5));
 let worker=0;
 const run=runNodeLoop({workspace:ws,stateDir,objective:'Build',approveTasks:true,codex:{activeCount:0,assertIdle:async()=>{}},
  assess:async()=>({status:'task',task}),worker:{withExclusive:fn=>fn(),run:async()=>{worker++;throw new Error('x');}},
  baseline:async()=>({head}),readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:20}).catch(()=>null);
 await new Promise(r=>setTimeout(r,150));
 await state.setControl('approve-task',{source:'app',reason:'OTHER'});
 await new Promise(r=>setTimeout(r,100));
 assert.equal(worker,0,'still waiting');
 await state.setControl('stop',{source:'app'});
 await run;
 assert.equal(worker,0);
});
