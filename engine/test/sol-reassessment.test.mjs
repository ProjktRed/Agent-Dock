import test from 'node:test';import assert from 'node:assert/strict';
import {runNodeLoop} from '../src/node-loop.mjs';
import {harness,correction} from '../fixtures/recovery-harness.mjs';
for(const cause of ['out-of-scope','unexpected-head','malformed-state','unsafe-commit','missing-permissions','security-policy','destructive-action']){
 test('unsafe '+cause+' never invokes Assessment or Astra',async t=>{
  const {options}=await harness(t);
  const result=await runNodeLoop({...options,review:async()=>({status:'manual-review',manualReviewCause:cause,output:cause}),assessCorrection:()=>assert.fail(),elevate:()=>assert.fail()});
  assert.equal(result.status,'blocked');
 });
}
test('Astra triggers after three failed corrections, exits before worker, then Assessment continues',async t=>{
 const {options,seed,state}=await harness(t);await seed();let astra=0,runs=0,active=false,assessment=0;
 const result=await runNodeLoop({...options,initialTask:null,
  elevate:async input=>{active=true;assert.equal(input.correctionCount,3);astra++;active=false;return correction('strategy-revised');},
  assessCorrection:async()=>{assessment++;return correction();},
  worker:{withExclusive:fn=>fn(),run:async(p,h)=>{assert.equal(active,false);assert.match(p,/PRESERVE:/);await h.onStart({pid:123});runs++;if(runs===1)assert.equal((await state.readLive()).elevateResult.kind,'strategy-revised');return{exitCode:0};}},
  review:async()=>runs===1?{status:'fail',output:'new evidence'}:{status:'pass',output:'verified',commit:'x'}
 });
 assert.equal(result.status,'passed');assert.equal(astra,1);assert.equal(runs,2);assert.equal(assessment,1);assert.equal((await state.readLive()).correctionCount,4);
});
test('automatic elevation opt-out continues Assessment without a fixed attempt limit',async t=>{
 const {options,seed}=await harness(t);await seed();let runs=0;
 const result=await runNodeLoop({...options,initialTask:null,solReassessmentEnabled:false,elevate:()=>assert.fail(),review:async()=>++runs<5?{status:'fail',output:'wrong'}:{status:'pass',output:'verified',commit:'x'}});
 assert.equal(result.status,'passed');assert.equal(runs,5);
});
test('insufficient evidence becomes bounded diagnostic work, not repeated Astra calls',async t=>{
 const {options,seed}=await harness(t);await seed();let calls=0;
 const result=await runNodeLoop({...options,initialTask:null,elevate:async()=>{calls++;return{...correction('insufficient-evidence'),nextWorkerInstructions:'',neededEvidence:['Trace only x owner close event']};},
 worker:{withExclusive:fn=>fn(),run:async(p,h)=>{assert.match(p,/Trace only x owner close event/);await h.onStart({pid:1});return{exitCode:0};}},
 review:async()=>({status:'pass',output:'verified diagnosis',commit:'x'})});
 assert.equal(result.status,'passed');assert.equal(calls,1);
});
