import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {runNodeLoop} from '../src/node-loop.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';

// Found in a live run: Assessment chose `node --test test/x.test.js`; the command was only refused
// at QA, after Implementation had done the work. It is now checked right after Assessment.
async function setup(t){
 const ws=await mkdtemp(path.join(os.tmpdir(),'aqc-ws-')),stateDir=await mkdtemp(path.join(os.tmpdir(),'aqc-state-'));
 t.after(()=>Promise.all([rm(ws,{recursive:true,force:true}),rm(stateDir,{recursive:true,force:true})]));
 const git=(...args)=>execFileSync('git',args,{cwd:ws,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','t@example.com');git('config','user.name','T');
 await writeFile(path.join(ws,'a.js'),'1\n');git('add','.');git('commit','-qm','base');
 const state=new DashboardState({stateDir});await state.initialize({task:{id:'boot',prompt:'x'},workspace:ws});
 return {ws,stateDir,state,head:git('rev-parse','HEAD')};
}
const bad={id:'T',name:'T',prompt:'Task skill: implement\nT',allowedPaths:['a.js'],qaCommand:'node --test test/a.test.js'};

test('an unapproved check command sends Assessment back once, with the reason, before any implementation',async t=>{
 const {ws,stateDir,state,head}=await setup(t);
 const seen=[];let worker=0;
 const result=await runNodeLoop({workspace:ws,stateDir,objective:'Build',codex:{activeCount:0,assertIdle:async()=>{}},
  assess:async input=>{seen.push(input.previous?.result??null);return seen.length===1?{status:'task',task:bad}:{status:'done'};},
  worker:{withExclusive:fn=>fn(),run:async()=>{worker++;return{exitCode:0};}},
  baseline:async()=>({head}),readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:1});
 assert.equal(result.status,'done');
 assert.equal(worker,0,'Implementation never ran');
 assert.match(seen[1],/Rejected before implementation: qaCommand "node --test test\/a.test.js" is not an approved check/);
 assert.ok((await state.readEvents(50)).some(e=>e.type==='assessment-rejected'));
});

test('two unapproved check commands in a row block the run',async t=>{
 const {ws,stateDir,state,head}=await setup(t);
 const result=await runNodeLoop({workspace:ws,stateDir,objective:'Build',codex:{activeCount:0,assertIdle:async()=>{},resolveBlocked:async()=>({status:'blocked'})},
  assess:async()=>({status:'task',task:bad}),worker:{withExclusive:fn=>fn(),run:async()=>assert.fail('no implementation')},
  baseline:async()=>({head}),readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:1});
 assert.equal(result.status,'blocked');
 assert.match(result.output,/not an approved project check: node --test/);
});
