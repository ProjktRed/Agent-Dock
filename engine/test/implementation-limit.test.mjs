import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runNodeLoop } from '../src/node-loop.mjs';
import { DashboardState } from '../src/dashboard-state.mjs';
import { implementationLimit } from '../src/cloud-impl-worker.mjs';
import { limitRetryMs, useRunLimits, waitOutLimit } from '../src/run-budget.mjs';

const task = { id:'L', name:'Limit', prompt:'Task skill: implement\nFix x', allowedPaths:['x'], qaCommand:'fake test' };
const packet = ({attempt,workerResult}) => ({task,baselineSha:'base',attempt,diff:{text:'d',bytes:1},changedFiles:['x'],clineSummary:{exitCode:workerResult.exitCode,text:'changed x'},qaEvidence:{command:{command:'fake test',exitCode:0},categories:{tests:'PASS',scopeCheck:'PASS'}}});
async function setup(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'impl-limit-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const state=new DashboardState({stateDir:root}); await state.initialize({task,workspace:root});
  return {root,state};
}
const loop=(root,state,{run,control,events=[]})=>runNodeLoop({workspace:root,stateDir:root,initialTask:task,stopAfterTask:true,codex:{activeCount:0},
  worker:{withExclusive:fn=>fn(),run},baseline:async()=>({head:'base'}),verify:async()=>{},prepareQa:async input=>packet(input),
  review:async()=>({status:'pass',output:'verified',commit:'new'}),assessCorrection:()=>assert.fail('no correction'),elevate:()=>assert.fail('no elevation'),
  readControl:async()=>({...await state.readControl(),...control()}),onEvent:async e=>{events.push(e);await state.record(e);},pollMs:1});

test('a usage limit during implementation waits for Resume, then continues from the partial changes', async t=>{
  t.after(()=>useRunLimits());useRunLimits();
  const {root,state}=await setup(t);const prompts=[],events=[];let resume=0,waitingStage=null;
  // Resume is pressed once the engine reports the wait (not on a timer, so a busy machine cannot race it).
  const control=()=>{if(!resume&&events.some(e=>e.type==='waiting-for-codex'))resume=1;return{resumeGeneration:resume};};
  const record=state.record.bind(state);state.record=async e=>{await record(e);if(e.type==='waiting-for-codex')waitingStage=(await state.readLive()).stage;};
  const result=await loop(root,state,{events,control,run:async(prompt,hooks)=>{
    prompts.push(prompt);await hooks.onStart({pid:1});
    if(prompts.length===1){throw implementationLimit('Claude',{message:'usage limit reached · resets 3pm',retryAt:'resets 3pm'});}
    return{exitCode:0};
  }});
  assert.equal(result.status,'passed');assert.equal(prompts.length,2);
  assert.equal(waitingStage,'WAITING_FOR_LIMIT');
  assert.doesNotMatch(prompts[0],/stopped by a usage limit/);
  assert.match(prompts[1],/stopped by a usage limit before it finished\. Its partial changes are still in the working tree/);
  const waiting=events.find(e=>e.type==='waiting-for-codex');
  assert.equal(waiting.operation,'implementation');assert.equal(waiting.retryAt,'resets 3pm');
  assert.deepEqual(events.filter(e=>e.type==='implementation-limit-resumed').map(e=>e.automatic),[false]);
  const live=await state.readLive();assert.equal(live.codexLimitMessage,null,'the limit message clears once the worker starts again');
});

test('Stop during the wait keeps the task; the next run waits again and continues after Resume, never blocking', async t=>{
  t.after(()=>useRunLimits());useRunLimits();
  const {root,state}=await setup(t);let runs=0,stop=false,resume=0;
  const run=async(prompt,hooks)=>{runs++;await hooks.onStart({pid:runs});if(runs===1){setTimeout(()=>{stop=true;},20);throw implementationLimit('Codex',{message:'You have hit your usage limit'});}return{exitCode:0};};
  const first=await loop(root,state,{run,control:()=>({stopAfterSafePoint:stop,resumeGeneration:resume})});
  assert.equal(first.status,'stopped');assert.equal(runs,1);
  const saved=JSON.parse(await readFile(path.join(root,'current-task.json'),'utf8'));
  assert.equal(saved.automation.recovery.phase,'worker-limit');assert.match(saved.automation.recovery.workerLimit.message,/Codex usage limit/);
  stop=false;setTimeout(()=>{resume=1;},20);
  // A restart reconciles scope first (real git in production; the test has no repository).
  const second=runNodeLoop({workspace:root,stateDir:root,stopAfterTask:true,codex:{activeCount:0},worker:{withExclusive:fn=>fn(),run},reconcile:async()=>{},baseline:async()=>({head:'base'}),verify:async()=>{},
    prepareQa:async input=>packet(input),review:async()=>({status:'pass',output:'verified',commit:'new'}),assessCorrection:()=>assert.fail(),elevate:()=>assert.fail(),
    readControl:async()=>({...await state.readControl(),stopAfterSafePoint:stop,resumeGeneration:resume}),onEvent:e=>state.record(e),pollMs:1});
  const out=await second;assert.equal(out.status,'passed');assert.equal(runs,2);
});

test('other worker errors still block the task as before', async t=>{
  const {root,state}=await setup(t);
  const result=await loop(root,state,{control:()=>({}),run:async(p,hooks)=>{await hooks.onStart({pid:1});throw new Error('spawn failed');}});
  assert.equal(result.status,'blocked');assert.match((await state.readLive()).blockedReason,/spawn failed/);
});

test('limit waits retry by themselves only in Unattended mode (every 30 minutes unless set)', async t=>{
  t.after(()=>useRunLimits());
  const control=async()=>({});const minute=60_000;
  useRunLimits({unattended:false});assert.equal(limitRetryMs(),0);
  useRunLimits({unattended:true});assert.equal(limitRetryMs(),30*minute);
  let clock=0;const sleep=async()=>{clock+=10*minute;};
  assert.equal(await waitOutLimit({readControl:control,generation:0,since:0,now:()=>clock,sleep}),'retry');assert.equal(clock,30*minute);
  useRunLimits({unattended:true,limitRetryMinutes:0});assert.equal(limitRetryMs(),0);
  let polls=0;
  assert.equal(await waitOutLimit({readControl:async()=>(++polls>3?{resumeGeneration:2}:{resumeGeneration:1}),generation:1,now:()=>1e12,sleep:async()=>{}}),'resumed');
  assert.equal(await waitOutLimit({readControl:async()=>({stopAfterSafePoint:true,resumeGeneration:9}),generation:0,sleep:async()=>{}}),'stopped','Stop wins over Resume');
});

test('the implementation limit error carries its code and reset text', ()=>{
  const error=implementationLimit('Claude',{message:'limit reached',retryAt:'resets 3pm'});
  assert.equal(error.code,'IMPLEMENTATION_USAGE_LIMIT');assert.equal(error.retryAt,'resets 3pm');assert.match(error.message,/^Implementation stopped by the Claude usage limit: limit reached$/);
});
