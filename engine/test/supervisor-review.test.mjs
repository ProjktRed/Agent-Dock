import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {runNodeLoop} from '../src/node-loop.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';
import {applyReviewAction,buildReviewPrompt,createReviewer,parseReview} from '../src/supervisor-review.mjs';
import {awaitSupervisorReview,parseSupervisorOptions,startSupervisor,superviseEvent} from '../src/supervisor.mjs';
import {RUN,useRunLimits} from '../src/run-budget.mjs';
import {TUNING,useTuning} from '../src/engine-tuning.mjs';

const fakeState=()=>{const s={live:{task:{id:'T1',name:'Thing',allowedPaths:['a.js']}},controls:[],events:[],setControl:async(a,o)=>{s.controls.push([a,o?.source,o?.reason].filter(Boolean));},record:async e=>{s.events.push(e);},readLive:async()=>s.live,readEvents:async()=>[{type:'retry',qa:'Lint failed'}]};return s;};

test('reviews parse strictly: unknown actions dropped, at most three, fenced JSON accepted',()=>{
 const text='```json\n'+JSON.stringify({summary:'Stuck on lint',actions:[{action:'pause',reason:'r',cap:'none',value:0},{action:'rewrite-code',reason:'x',cap:'none',value:0},{action:'none',reason:'',cap:'none',value:0},{action:'tighten-cap',reason:'t',cap:'corrections',value:2}]})+'\n```';
 assert.deepEqual(parseReview(text),{summary:'Stuck on lint',actions:[{action:'pause',reason:'r',cap:'none',value:0},{action:'tighten-cap',reason:'t',cap:'corrections',value:2}]});
 assert.throws(()=>parseReview('{"actions":[]}'),/summary/);
 assert.match(buildReviewPrompt({alert:{monitor:'stall',message:'quiet'},task:null,events:[],plan:null,deferred:[],mayDefer:false}),/defer-task: NOT allowed/);
});

test('acting only ever lowers limits, defers only when allowed, and leaves CLI switches to you',async t=>{
 t.after(()=>{useRunLimits();useTuning();});
 useRunLimits({maxTasks:10});useTuning({maxCorrections:6});
 const state=fakeState();
 assert.equal(await applyReviewAction(state,{action:'tighten-cap',cap:'corrections',value:2},{}),'corrections limit lowered to 2 (was 6)');
 assert.equal(TUNING.maxCorrections,2);
 assert.match(await applyReviewAction(state,{action:'tighten-cap',cap:'corrections',value:9},{}),/not lower/);
 assert.equal(TUNING.maxCorrections,2);
 assert.equal(await applyReviewAction(state,{action:'tighten-cap',cap:'tokens',value:500000},{}),'tokens limit lowered to 500000');
 assert.equal(RUN.maxTokens,500000);
 assert.match(await applyReviewAction(state,{action:'tighten-cap',cap:'tasks',value:0},{}),/no valid/);
 assert.match(await applyReviewAction(state,{action:'defer-task',reason:'stuck'},{mayDefer:false}),/off for this project/);
 assert.equal(await applyReviewAction(state,{action:'defer-task',reason:'stuck'},{mayDefer:true}),'deferring at the next safe point');
 assert.equal(await applyReviewAction(state,{action:'switch-backup-cli',reason:'x'},{mayDefer:true}),'proposal for you');
 assert.deepEqual(state.controls,[['defer','supervisor-review','stuck']]);
});

test('an alert triggers one model review; propose mode records, act mode carries out',async t=>{
 for(const mode of ['propose','act']){
  const state=fakeState(),prompts=[];
  const reviewer=async prompt=>{prompts.push(prompt);return{summary:'Same lint failure; pause.',actions:[{action:'pause',reason:'loop',cap:'none',value:0}]};};
  const stop=startSupervisor(state,{config:{mode:'alert',repeatFailures:2,review:mode,reviewMax:3},reviewer});
  await superviseEvent({type:'retry',qa:'Lint failed'});await superviseEvent({type:'retry',qa:'Lint failed'});
  await awaitSupervisorReview();stop();
  assert.equal(prompts.length,1);assert.match(prompts[0],/Alert: repeat failure/);assert.match(prompts[0],/Current task: T1/);
  const review=state.events.find(e=>e.type==='supervisor-review');
  assert.equal(review.message,'Same lint failure; pause.');
  assert.equal(review.actions[0].result,mode==='act'?'asked to pause at the next safe point':'proposed');
  assert.deepEqual(state.controls,mode==='act'?[['pause','supervisor-review']]:[]);
 }
 assert.deepEqual((({review,mayDefer})=>({review,mayDefer}))(parseSupervisorOptions({'supervisor-review':'act','supervisor-may-defer':'true'})),{review:'act',mayDefer:true});
 assert.throws(()=>parseSupervisorOptions({'supervisor-review':'always'}),/off, propose or act/);
});

test('the local reviewer calls an OpenAI-compatible server and parses its JSON',async()=>{
 let body;
 const review=await createReviewer({kind:'local',model:'qwen',baseUrl:'http://127.0.0.1:8080/v1',fetchImpl:async(url,init)=>{body=[String(url),JSON.parse(init.body)];return{ok:true,json:async()=>({choices:[{message:{content:'{"summary":"fine","actions":[]}'}}]})};}});
 assert.deepEqual(await review('p'),{summary:'fine',actions:[]});
 assert.equal(body[0],'http://127.0.0.1:8080/v1/chat/completions');
 assert.equal(body[1].model,'qwen');assert.deepEqual(body[1].response_format,{type:'json_object'});
 await assert.rejects(createReviewer({kind:'gpt'}),/codex, claude or local/);
});

test('defer at a loop boundary stashes the work, records it, and Assessment moves on to another task',async t=>{
 const ws=await mkdtemp(path.join(os.tmpdir(),'defer-ws-')),stateDir=await mkdtemp(path.join(os.tmpdir(),'defer-state-'));
 t.after(()=>Promise.all([rm(ws,{recursive:true,force:true}),rm(stateDir,{recursive:true,force:true})]));
 const git=(...args)=>execFileSync('git',args,{cwd:ws,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','t@example.com');git('config','user.name','T');git('config','core.autocrlf','false');
 await writeFile(path.join(ws,'a.js'),'1\n');git('add','.');git('commit','-qm','base');
 const head=git('rev-parse','HEAD');
 const A={id:'A',name:'Stuck task',prompt:'Task skill: implement\nA',allowedPaths:['a.js'],qaCommand:'t'};
 const B={id:'B',name:'Other task',prompt:'Task skill: implement\nB',allowedPaths:['b.js'],qaCommand:'t'};
 const state=new DashboardState({stateDir});await state.initialize({task:A,workspace:ws});
 const objectives=[];let assessments=0;
 const packet=({task,attempt,workerResult})=>({task,baselineSha:head,attempt,diff:{text:'d',bytes:1},changedFiles:task.allowedPaths,clineSummary:{exitCode:workerResult.exitCode,text:'x'},qaEvidence:{command:{command:'t',exitCode:1},categories:{tests:'FAIL',scopeCheck:'PASS'}}});
 const result=await runNodeLoop({workspace:ws,stateDir,objective:'Build it',
  codex:{activeCount:0,assertIdle:async()=>{}},
  assess:async input=>{objectives.push(input.objective);assessments++;return assessments===1?{status:'task',task:A}:assessments===2?{status:'task',task:B}:{status:'done'};},
  worker:{withExclusive:fn=>fn(),run:async(prompt,hooks)=>{await hooks.onStart({pid:1});if(hooks.task?.id==='A')await writeFile(path.join(ws,'a.js'),'work in progress\n');return{exitCode:0};}},
  baseline:async()=>({head}),verify:async()=>{},prepareQa:async input=>packet({...input,task:input.task??A}),
  review:async input=>input.task?.id==='B'?{status:'pass',output:'ok',commit:'c'}:{status:'fail',output:'still failing'},
  assessCorrection:async()=>{await state.setControl('defer',{source:'supervisor-review',reason:'Stuck on the same failure'});return{status:'correction',preserve:[],rootProblem:'r',previousStrategyFailure:'p',newStrategy:'n',nextWorkerInstructions:'again',neededEvidence:[],failureReason:'f'};},
  elevate:async()=>assert.fail('no elevation'),
  readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:1});
 assert.equal(result.status,'done');
 assert.match(objectives[1],/Deferred tasks .*A "Stuck task" \(Stuck on the same failure\)/);
 const deferred=JSON.parse(await readFile(path.join(stateDir,'deferred-tasks.json'),'utf8'));
 assert.deepEqual(deferred.map(d=>[d.id,d.reason]),[['A','Stuck on the same failure']]);
 assert.match(git('stash','list'),/Agent Dock: deferred A - Stuck on the same failure/);
 assert.equal(await readFile(path.join(ws,'a.js'),'utf8'),'1\n','work is stashed, the tree is back at the baseline');
 git('stash','apply');assert.equal(await readFile(path.join(ws,'a.js'),'utf8'),'work in progress\n','and nothing was lost');
 const events=await state.readEvents(200);
 assert.ok(events.some(e=>e.type==='task-deferred'&&e.taskId==='A'));
});
