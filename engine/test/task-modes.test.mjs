import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {runNodeLoop} from '../src/node-loop.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';
import {MODE_SIZING,STEP_DOWN,TUNING,parseTuning,readFilesText,stepDown,noteStepDownApproval,taskScopeText,taskSizingText,useTuning,workerSizingText} from '../src/engine-tuning.mjs';

test('task modes: eco is the default; standard and max size tasks for capable models',()=>{
 assert.equal(parseTuning({}).taskMode,'eco');
 const standard=parseTuning({'task-mode':'standard'});
 assert.deepEqual([standard.taskMaxFiles,standard.taskMaxNewLines,standard.taskMaxReadFiles],[10,800,10]);
 assert.match(taskSizingText(standard),/one task per unchecked plan item, its code and tests together.*at most 10 files per task.*about 800 lines/);
 assert.match(taskScopeText(standard),/a whole unchecked plan item/);
 assert.match(workerSizingText(standard),/^Worker sizing \(standard mode/);
 const max=parseTuning({'task-mode':'max'});
 assert.deepEqual([max.taskMaxFiles,max.taskMaxNewLines,max.taskMaxReadFiles],[0,0,0]);
 assert.doesNotMatch(taskSizingText(max),/at most|under about/,'max has no limits by default');
 assert.equal(readFilesText(max),'Name the files to read (with line ranges for large files).');
 const limited=parseTuning({'task-mode':'max','task-max-files':'20','task-max-read-files':'15'});
 assert.match(taskSizingText(limited),/at most 20 files per task/);
 assert.match(readFilesText(limited),/at most 15/);
 const eco=parseTuning({});
 assert.match(taskScopeText(eco),/small bounded/);
 assert.match(workerSizingText(eco),/^Local worker sizing \(98K context/);
 assert.throws(()=>parseTuning({'task-mode':'huge'}),/eco, standard or max/);
 assert.equal(parseTuning({'step-down':'false'}).stepDown,false);
 assert.throws(()=>parseTuning({'step-down':'yes'}),/true or false/);
});

test('step-down goes one size smaller and back once the set-aside plan items are done',t=>{
 t.after(()=>useTuning());
 useTuning({...MODE_SIZING.max,taskMode:'max',taskMaxFiles:30});
 assert.deepEqual(stepDown({id:'A',planItems:['One','Two']}),{from:'max',to:'standard'});
 assert.equal(TUNING.taskMaxFiles,10);
 assert.deepEqual(stepDown({id:'A2',planItems:['One']}),{from:'standard',to:'eco'});
 assert.equal(TUNING.taskMaxFiles,1);
 assert.equal(stepDown({id:'A3'}),null,'eco is the smallest size');
 assert.equal(noteStepDownApproval({planItems:['Other']}),null);
 assert.deepEqual(noteStepDownApproval({planItems:['One']}),{mode:'max',from:'eco'});
 assert.equal(TUNING.taskMaxFiles,30,'the configured max limits come back');
 assert.equal(STEP_DOWN.active,null);
});

test('a standard task that fails review twice is stashed and redone eco-sized, then the mode comes back',async t=>{
 const ws=await mkdtemp(path.join(os.tmpdir(),'stepdown-ws-')),stateDir=await mkdtemp(path.join(os.tmpdir(),'stepdown-state-'));
 t.after(()=>{useTuning();return Promise.all([rm(ws,{recursive:true,force:true}),rm(stateDir,{recursive:true,force:true})]);});
 useTuning({...MODE_SIZING.standard,taskMode:'standard'});
 const git=(...args)=>execFileSync('git',args,{cwd:ws,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','t@example.com');git('config','user.name','T');git('config','core.autocrlf','false');
 await writeFile(path.join(ws,'a.js'),'1\n');git('add','.');git('commit','-qm','base');
 const head=git('rev-parse','HEAD');
 const A={id:'A',name:'Whole item',prompt:'Task skill: implement\nA',allowedPaths:['a.js'],qaCommand:'npm test',planItems:['Build the thing']};
 const B={id:'B',name:'First part',prompt:'Task skill: implement\nB',allowedPaths:['b.js'],qaCommand:'npm test',planItems:['Build the thing']};
 const state=new DashboardState({stateDir});await state.initialize({task:A,workspace:ws});
 const seen=[];let assessments=0,corrections=0;
 const packet=({task,attempt,workerResult})=>({task,baselineSha:head,attempt,diff:{text:'d',bytes:1},changedFiles:task.allowedPaths,clineSummary:{exitCode:workerResult.exitCode,text:'x'},qaEvidence:{command:{command:'t',exitCode:1},categories:{tests:'FAIL',scopeCheck:'PASS'}}});
 const result=await runNodeLoop({workspace:ws,stateDir,objective:'Build it',
  codex:{activeCount:0,assertIdle:async()=>{}},
  assess:async input=>{seen.push({objective:input.objective,mode:TUNING.taskMode});assessments++;return assessments===1?{status:'task',task:A}:assessments===2?{status:'task',task:B}:{status:'done'};},
  worker:{withExclusive:fn=>fn(),run:async(prompt,hooks)=>{await hooks.onStart({pid:1});if(hooks.task?.id==='A')await writeFile(path.join(ws,'a.js'),'too big\n');return{exitCode:0};}},
  baseline:async()=>({head}),verify:async()=>{},prepareQa:async input=>packet({...input,task:input.task??A}),
  review:async input=>input.task?.id==='B'?{status:'pass',output:'ok',commit:'c'}:{status:'fail',output:'still failing'},
  assessCorrection:async()=>{corrections++;return{status:'correction',preserve:[],rootProblem:'r',previousStrategyFailure:'p',newStrategy:'n',nextWorkerInstructions:'again',neededEvidence:[],failureReason:'f'};},
  elevate:async()=>assert.fail('no elevation'),
  readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:1});
 assert.equal(result.status,'done');
 assert.equal(corrections,1,'one correction, then the second failed review steps down');
 assert.deepEqual(seen.map(s=>s.mode),['standard','eco','standard']);
 assert.match(seen[1].objective,/Stepped down: A "Whole item" failed review twice at standard size\. Redo its work now as eco-sized tasks/);
 assert.doesNotMatch(seen[1].objective,/Deferred tasks/,'a stepped-down task is redone now, not avoided');
 assert.doesNotMatch(seen[2].objective,/Stepped down|Deferred tasks/);
 assert.match(git('stash','list'),/Agent Dock: deferred A - Stepped down from standard to eco size/);
 assert.equal(await readFile(path.join(ws,'a.js'),'utf8'),'1\n','the oversized attempt is stashed');
 const events=await state.readEvents(200);
 assert.ok(events.some(e=>e.type==='task-stepped-down'&&e.from==='standard'&&e.to==='eco'));
 assert.ok(events.some(e=>e.type==='task-mode-restored'&&e.mode==='standard'));
});


test('one task engine of a parallel run (stopAfterTask) ends on a step-down instead of asking Assessment for more',async t=>{
 const ws=await mkdtemp(path.join(os.tmpdir(),'stepdown-ws-')),stateDir=await mkdtemp(path.join(os.tmpdir(),'stepdown-state-'));
 t.after(()=>{useTuning();return Promise.all([rm(ws,{recursive:true,force:true}),rm(stateDir,{recursive:true,force:true})]);});
 useTuning({...MODE_SIZING.standard,taskMode:'standard'});
 const git=(...args)=>execFileSync('git',args,{cwd:ws,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','t@example.com');git('config','user.name','T');git('config','core.autocrlf','false');
 await writeFile(path.join(ws,'a.js'),'1\n');git('add','.');git('commit','-qm','base');
 const head=git('rev-parse','HEAD');
 const A={id:'A',name:'Whole item',prompt:'Task skill: implement\nA',allowedPaths:['a.js'],qaCommand:'npm test'};
 const state=new DashboardState({stateDir});await state.initialize({task:A,workspace:ws});
 const packet=({task,attempt,workerResult})=>({task,baselineSha:head,attempt,diff:{text:'d',bytes:1},changedFiles:task.allowedPaths,clineSummary:{exitCode:workerResult.exitCode,text:'x'},qaEvidence:{command:{command:'t',exitCode:1},categories:{tests:'FAIL',scopeCheck:'PASS'}}});
 const result=await runNodeLoop({workspace:ws,stateDir,objective:'Build it',initialTask:A,stopAfterTask:true,
  codex:{activeCount:0,assertIdle:async()=>{}},
  assess:async()=>assert.fail('the parent plans the next round'),
  worker:{withExclusive:fn=>fn(),run:async(prompt,hooks)=>{await hooks.onStart({pid:1});await writeFile(path.join(ws,'a.js'),'too big\n');return{exitCode:0};}},
  baseline:async()=>({head}),verify:async()=>{},prepareQa:async input=>packet({...input,task:input.task??A}),
  review:async()=>({status:'fail',output:'still failing'}),
  assessCorrection:async()=>({status:'correction',preserve:[],rootProblem:'r',previousStrategyFailure:'p',newStrategy:'n',nextWorkerInstructions:'again',neededEvidence:[],failureReason:'f'}),
  elevate:async()=>assert.fail('no elevation'),
  readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:1});
 assert.equal(result.status,'stepped-down');
 assert.match(result.output,/Stepped down from standard to eco/);
});
