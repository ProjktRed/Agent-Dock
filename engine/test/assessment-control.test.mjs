import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,correction} from '../fixtures/recovery-harness.mjs';
import * as setup from '../src/engine-setup.mjs';
import {parseLoopOptions} from '../src/loop-options.mjs';
import {readPendingCodex} from '../src/node-loop.mjs';

for (const boundary of ['lock', 'baseline', 'dispatch', 'task-selection']) {
  for (const action of ['pause', 'stop']) test(`${action} at ${boundary} prevents the next Assessment/task launch`, async t => {
    const {options, state, startLoop} = await harness(t);
    let assessments = 0, workers = 0, selected = 0;
    const loop = startLoop({initialTask:null, objective:'bounded',
      baseline:async()=>{if(boundary==='baseline')await state.setControl(action);return {head:'base'};},
      worker:{withExclusive:async fn=>{if(boundary==='lock')await state.setControl(action);return fn();},run:async()=>{workers++;return {exitCode:0};}},
      onEvent:async event=>{await options.onEvent(event);if(boundary==='dispatch'&&event.type==='codex-assessing')await state.setControl(action);},
      assess:async()=>{assessments++;if(boundary==='task-selection'){await state.setControl(action);return {status:'task',task:{id:'next',prompt:'fix',qaCommand:'npm test',allowedPaths:['x']}};}return {status:'done'};},
      onTask:async()=>{selected++;},
    });
    if(action==='pause') {
      await loop.waitForEvent('paused');
      assert.equal(assessments,boundary==='task-selection'?1:0);
      assert.equal(selected,0);
      await loop.stop();
    } else assert.equal((await loop).status,'stopped');
    assert.equal(assessments,boundary==='task-selection'?1:0);
    assert.equal(workers,0);
    assert.equal(selected,0);
  });
}

for(const action of ['pause','stop'])test(`${action} at correction Assessment dispatch holds the saved operation`,async t=>{
  const {root,options,state,seed,startLoop}=await harness(t);await seed({phase:'correction-assessment'});
  let calls=0,held=false;
  const loop=startLoop({initialTask:null,
    onEvent:async e=>{await options.onEvent(e);if(e.type==='codex-assessing'&&!held){held=true;await state.setControl(action);}},
    assessCorrection:async()=>{calls++;return correction();},review:async()=>({status:'pass',output:'verified',commit:'x'}),
  });
  if(action==='pause'){
    await loop.waitForEvent('paused');assert.equal(calls,0);
    await state.setControl('resume');assert.equal((await loop).status,'passed');assert.equal(calls,1);
  }else {
    assert.equal((await loop).status,'stopped');assert.equal(calls,0);
    const pending=await readPendingCodex(root);assert.equal(pending.operation,'correction-assessment');
    await state.setControl('resume');
    const result=await startLoop({initialTask:null,pendingCodex:pending,
      assessCorrection:async input=>{assert.deepEqual(input,pending.inputs);calls++;return correction();},
      review:async()=>({status:'pass',output:'verified',commit:'x'}),
    });
    assert.equal(result.status,'passed');assert.equal(calls,1);
  }
});

test('auto-continue off records pause before QA PASS and holds until Resume without an app poll',async t=>{
  const {state,startLoop}=await harness(t);let assessments=0;
  const loop=startLoop({stopAfterTask:false,objective:'bounded',
    onEvent:e=>setup.recordLoopEvent(state,e,{autoContinue:false}),
    review:async()=>({status:'pass',output:'verified',commit:'x'}),
    assess:async()=>{assessments++;return {status:'done'};},
  });
  await loop.waitForEvent('paused');assert.equal(assessments,0);
  const events=await state.readEvents(100);
  assert.ok(events.findIndex(e=>e.type==='control-pause')<events.findIndex(e=>e.type==='qa-pass'));
  await state.setControl('resume');assert.equal((await loop).status,'done');assert.equal(assessments,1);
});

test('auto-continue CLI option defaults on and validates explicit choices',()=>{
  assert.equal(parseLoopOptions([]).autoContinue,true);
  assert.equal(parseLoopOptions(['--auto-continue','false']).autoContinue,false);
  assert.throws(()=>parseLoopOptions(['--auto-continue','yes']),/auto-continue/);
});
