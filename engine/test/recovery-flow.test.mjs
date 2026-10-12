import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runNodeLoop } from '../src/node-loop.mjs';
import { CodexWorker, CodexUsageLimitError } from '../src/codex-worker.mjs';
import { DashboardState } from '../src/dashboard-state.mjs';

const task = { id:'R', name:'Recovery', prompt:'Task skill: implement\nFix x', allowedPaths:['x'], qaCommand:'fake test' };
const correction = (n=1) => ({status:'correction', preserve:['working parsing'], rootProblem:`wrong ownership ${n}`, previousStrategyFailure:'missed owner', newStrategy:'repair owner', nextWorkerInstructions:`Fix x owner ${n}`, neededEvidence:[], failureReason:'failed criterion'});
const packet = ({attempt,workerResult}) => ({task,baselineSha:'base',attempt,diff:{text:'scoped diff',bytes:11},changedFiles:['x'],clineSummary:{exitCode:workerResult.exitCode,text:'changed x'},qaEvidence:{command:{command:'fake test',exitCode:1},categories:{tests:'FAIL',scopeCheck:'PASS'}}});
async function setup(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'recovery-flow-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const state=new DashboardState({stateDir:root}); await state.initialize({task,workspace:root});
  return {root,state};
}
test('recoverable QA failures use Assessment and elevate after three attempted corrections without losing history', async t=>{
  const {root,state}=await setup(t); let runs=0,qa=0,assessments=0; const elevations=[],prompts=[]; let active=false;
  const result=await runNodeLoop({workspace:root,stateDir:root,initialTask:task,stopAfterTask:true,
    codex:{activeCount:0,assertIdle:async()=>assert.equal(active,false)},
    worker:{withExclusive:fn=>fn(),run:async(prompt,hooks)=>{assert.equal(active,false);prompts.push(prompt);runs++;await hooks.onStart({pid:100+runs});return{exitCode:0};}},
    baseline:async()=>({head:'base'}),verify:async()=>{},prepareQa:async input=>packet(input),
    review:async()=>++qa===6?{status:'pass',output:'verified',commit:'new'}:{status:'fail',output:'ownership still wrong',correction:'QA MUST NOT AUTHOR CORRECTIONS'},
    assessCorrection:async input=>{active=true;assert.equal(input.qaPacket.diff.text,'scoped diff');assert.equal(input.task.id,'R'); assessments++;active=false;return correction(assessments);},
    elevate:async input=>{active=true;elevations.push(input);active=false;return{...correction(9),status:'strategy-revised'};},
    readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:1});
  assert.equal(result.status,'passed');assert.equal(runs,6);assert.equal(assessments,4);assert.equal(elevations.length,1);
  assert.equal(elevations[0].correctionCount,3);assert.equal(elevations[0].correctionHistory.length,3);
  assert.match(prompts[1],/PRESERVE:[\s\S]*working parsing/);assert.doesNotMatch(prompts[1],/QA MUST NOT/);
  assert.match(prompts[4],/Fix x owner 9/);
  const live=await state.readLive();assert.equal(live.correctionCount,4);
});
test('Assessment and QA use 6.1 Sol Medium; Elevation remains Astra Medium',async()=>{
  const worker=Object.create(CodexWorker.prototype),calls=[];
  worker.invoke=async(...args)=>{calls.push(args);return{status:'done'};};
  await worker.assess({objective:'bounded'});await worker.review(packet({attempt:1,workerResult:{exitCode:0}}));
  assert.equal(typeof worker.assessCorrection,'function');await worker.assessCorrection({task});await worker.reassessManualReview({task});
  assert.deepEqual(calls.map(c=>c[2].model),['gpt-6.1-sol','gpt-6.1-sol','gpt-6.1-sol','gpt-6-astra']);
  assert.ok(calls.every(c=>c[2].reasoningEffort==='medium'));
});
test('unsafe QA is BLOCKED without Assessment or Elevation',async t=>{
  const {root,state}=await setup(t);
  const result=await runNodeLoop({workspace:root,stateDir:root,initialTask:task,codex:{activeCount:0},
    worker:{withExclusive:fn=>fn(),run:async()=>({exitCode:0})},baseline:async()=>({head:'base'}),verify:async()=>{},prepareQa:async input=>packet(input),
    review:async()=>({status:'manual-review',manualReviewCause:'missing-permissions',output:'permission denied'}),
    assessCorrection:()=>assert.fail('Unsafe recovery'),elevate:()=>assert.fail('Unsafe elevation'),readControl:async()=>({}),onEvent:e=>state.record(e)});
  assert.equal(result.status,'blocked');assert.equal((await state.readLive()).stage,'BLOCKED');
});
