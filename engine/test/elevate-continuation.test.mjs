import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import path from 'node:path';
import {runNodeLoop,readPendingCodex} from '../src/node-loop.mjs';
import {CodexUsageLimitError} from '../src/codex-worker.mjs';
import {harness,correction,until} from '../fixtures/recovery-harness.mjs';
for(const phase of ['qa','correction-assessment','elevation']) {
 test(phase+' usage limit survives restart with identical input, count, task and no worker relaunch',async t=>{
  const {root,options,state,seed,startLoop}=await harness(t);await seed({phase,correctionCount:3});
  let calls=0,received;
  const operation=async input=>{calls++;received??=structuredClone(input);assert.deepEqual(input,received);throw new CodexUsageLimitError({message:'usage limit',retryAt:'try again at 10:07 PM'});};
  const first=startLoop({initialTask:null,review:operation,assessCorrection:operation,elevate:operation});
  await first.waitForEvent('waiting-for-codex');
  assert.equal((await state.readLive()).stage,'WAITING_FOR_LIMIT');
  assert.equal((await state.readLive()).correctionCount,3);await state.setControl('pause');await state.setControl('stop');assert.equal((await first).status,'stopped');
  const pending=await readPendingCodex(root);assert.deepEqual(pending.inputs,received);
  await state.setControl('resume');let runs=0;
  const resumed=async input=>{assert.deepEqual(input,received);return phase==='qa'?{status:'pass',output:'verified',commit:'x'}:correction(phase==='elevation'?'strategy-revised':'correction');};
  const result=await startLoop({initialTask:null,pendingCodex:pending,
    review:phase==='qa'?resumed:async()=>({status:'pass',output:'verified',commit:'x'}),
    assessCorrection:phase==='correction-assessment'?resumed:options.assessCorrection,elevate:phase==='elevation'?resumed:()=>assert.fail(),
    worker:{withExclusive:fn=>fn(),run:async(p,h)=>{runs++;await h.onStart({pid:12});return{exitCode:0};}}
  });
  assert.equal(result.status,'passed');assert.equal(runs,phase==='qa'?0:1);assert.equal(calls,1);
  assert.equal((await state.readLive()).correctionCount,phase==='correction-assessment'?4:3);
 });
}
test('restart at an unresolved worker launch blocks replay and preserves correction count',async t=>{
 const {options,seed,state}=await harness(t);await seed({phase:'worker-launching',correctionCount:2});
 const result=await runNodeLoop({...options,initialTask:null,worker:{withExclusive:()=>assert.fail(),run:()=>assert.fail()}});
 assert.equal(result.status,'blocked');assert.equal((await state.readLive()).correctionCount,2);
});
for(const failure of ['scope violation','unexpected HEAD','persisted model PID alive'])test(failure+' prevents resumed Cline launch',async t=>{
 const {options,seed}=await harness(t);await seed({phase:'worker'});
 const result=await runNodeLoop({...options,initialTask:null,reconcile:async()=>{if(!failure.includes('PID'))throw new Error(failure);},
 codex:{activeCount:0,assertIdle:async()=>{throw new Error(failure);}},worker:{withExclusive:fn=>fn(),run:()=>assert.fail()}});
 assert.equal(result.status,'blocked');assert.match(result.output,new RegExp(failure));
});
test('failed worker preflight does not consume an Assessment correction',async t=>{
 const {options,seed,root}=await harness(t);await seed({phase:'worker',correctionCount:2,currentCorrection:{id:'new',source:'assessment',attempted:false,prompt:'bounded'}});
 const result=await runNodeLoop({...options,initialTask:null,worker:{withExclusive:fn=>fn(),run:async()=>{throw new Error('preflight unavailable');}}});
 assert.equal(result.status,'blocked');const saved=JSON.parse(await readFile(path.join(root,'current-task.json'),'utf8'));assert.equal(saved.automation.recovery.correctionCount,2);
});
test('Stop after Elevation exits does not launch its saved correction',async t=>{
 const {options,seed,state}=await harness(t);await seed();
 const result=await runNodeLoop({...options,initialTask:null,elevate:async()=>{await state.setControl('stop');return correction('strategy-revised');},worker:{withExclusive:fn=>fn(),run:()=>assert.fail()}});
 assert.equal(result.status,'stopped');assert.equal((await state.readLive()).correctionCount,3);
});
