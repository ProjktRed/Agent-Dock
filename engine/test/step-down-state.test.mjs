import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MODE_SIZING,STEP_DOWN,TUNING,loadStepDown,noteStepDownApproval,parseTuning,stepDown,useTuning} from '../src/engine-tuning.mjs';

const exists=file=>readFile(file,'utf8').then(()=>true,()=>false);
const tempState=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'stepdown-saved-'));t.after(()=>{useTuning();return rm(dir,{recursive:true,force:true});});return dir;};

test('a step-down is saved in the state folder, survives an engine restart and is cleared when the size comes back',async t=>{
 const stateDir=await tempState(t),file=path.join(stateDir,'step-down.json');
 useTuning(parseTuning({'task-mode':'max'}));
 assert.equal(await loadStepDown(stateDir,'max'),null);
 stepDown({id:'A',name:'Big',planItems:['One','Two']});await STEP_DOWN.saving;
 const saved=JSON.parse(await readFile(file,'utf8'));
 assert.equal(saved.to,'standard');assert.equal(saved.configured.taskMode,'max');
 assert.equal(noteStepDownApproval({planItems:['One']}),null);await STEP_DOWN.saving;
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')).items,['Two']);
 // Restart: a new engine starts at the configured size, then loads the saved step-down.
 useTuning(parseTuning({'task-mode':'max'}));
 assert.equal(TUNING.taskMode,'max');
 const restored=await loadStepDown(stateDir,'max');
 assert.equal(restored.taskId,'A');
 assert.equal(TUNING.taskMode,'standard');assert.equal(TUNING.taskMaxFiles,MODE_SIZING.standard.taskMaxFiles);
 assert.deepEqual(noteStepDownApproval({planItems:['Two']}),{mode:'max',from:'standard'});await STEP_DOWN.saving;
 assert.equal(TUNING.taskMode,'max');assert.equal(STEP_DOWN.active,null);
 assert.equal(await exists(file),false,'cleared once the configured size is back');
});

test('a saved step-down is discarded when --task-mode, the sizing flags or step-down changed',async t=>{
 const stateDir=await tempState(t),file=path.join(stateDir,'step-down.json');
 const save=async options=>{useTuning(parseTuning(options));await loadStepDown(stateDir,TUNING.taskMode);stepDown({id:'A',planItems:['One']});await STEP_DOWN.saving;assert.ok(await exists(file));};
 await save({'task-mode':'standard'});
 useTuning(parseTuning({'task-mode':'max'}));
 assert.equal(await loadStepDown(stateDir,'max'),null);
 assert.equal(TUNING.taskMode,'max');assert.equal(await exists(file),false);
 await save({'task-mode':'max'});
 useTuning(parseTuning({'task-mode':'max','task-max-files':'20'}));
 assert.equal(await loadStepDown(stateDir,'max'),null);assert.equal(TUNING.taskMaxFiles,20);
 await save({'task-mode':'standard'});
 useTuning(parseTuning({'task-mode':'standard','step-down':'false'}));
 assert.equal(await loadStepDown(stateDir,'standard'),null);assert.equal(TUNING.taskMode,'standard');assert.equal(await exists(file),false);
 await writeFile(file,'not json');
 useTuning(parseTuning({'task-mode':'standard'}));
 assert.equal(await loadStepDown(stateDir,'standard'),null);assert.equal(await exists(file),false,'a damaged file is removed');
});

test('without loadStepDown nothing is written (tests and older callers keep the in-memory step-down)',async t=>{
 const stateDir=await tempState(t);
 useTuning(parseTuning({'task-mode':'standard'}));
 assert.deepEqual(stepDown({id:'A',planItems:['One']}),{from:'standard',to:'eco'});await STEP_DOWN.saving;
 assert.equal(await exists(path.join(stateDir,'step-down.json')),false);
 assert.deepEqual(noteStepDownApproval({planItems:['One']}),{mode:'standard',from:'eco'});
});
