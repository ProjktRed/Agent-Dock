import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {DashboardState,atomicWriteJson} from '../src/dashboard-state.mjs';
import {startTestLoop} from './test-loop.mjs';
export const task={id:'recovery',name:'Recovery',prompt:'Task skill: diagnose\nDiagnose x',qaCommand:'fake test',allowedPaths:['x']};
export const correction=(status='correction')=>({status,preserve:['correct parsing'],rootProblem:'owner not released',previousStrategyFailure:'wrong owner',newStrategy:'repair owning resource',nextWorkerInstructions:'Task skill: diagnose\nCollect owner evidence in x',neededEvidence:[],failureReason:'required lifecycle incomplete'});
export const packet=({attempt=1,workerResult={exitCode:0}}={})=>({task,attempt,baselineSha:'base',acceptanceCriteria:['natural exit'],changedFiles:['x'],diff:{patch:'diff x',bytes:6},clineSummary:{exitCode:workerResult.exitCode,text:'worker summary'},qaEvidence:{command:{command:'fake test',exitCode:0},categories:{tests:'PASS',scopeCheck:'PASS'}}});
export async function harness(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'recovery-fixture-')),loops=[];
 t.after(async()=>{for(const loop of loops)await loop.stop();await rm(root,{recursive:true,force:true});});
 const state=new DashboardState({stateDir:root});await state.initialize({task,workspace:root});
 // The 2ms fixture poll must not hold a Windows read handle across a control
 // replacement. Serialize fixture reads/writes, retaining real persisted state.
 const readControl=state.readControl.bind(state),setControl=state.setControl.bind(state);
 let controlIo=Promise.resolve();
 const controlOperation=fn=>{const operation=controlIo.then(fn,fn);controlIo=operation.catch(()=>{});return operation;};
 state.setControl=action=>controlOperation(()=>setControl(action));
 const options={workspace:root,stateDir:root,initialTask:task,stopAfterTask:true,codex:{activeCount:0,assertIdle:async()=>{}},baseline:async()=>({head:'base'}),reconcile:async()=>{},verify:async()=>{},prepareQa:async input=>packet(input),assessCorrection:async()=>correction(),
 worker:{withExclusive:fn=>fn(),run:async(_p,h)=>{await h.onStart({pid:12345});return{exitCode:0};}},readControl:()=>controlOperation(readControl),onEvent:e=>state.record(e),pollMs:2};
 return{root,state,options,startLoop:overrides=>{const loop=startTestLoop({...options,...overrides});loops.push(loop);return loop;},seed:async(extra={})=>{
  const recovery={version:1,baselineSha:'base',attempt:4,phase:'decision',correctionCount:3,correctionHistory:[1,2,3].map(n=>({id:String(n),source:'assessment',prompt:'correction '+n,attempted:true})),history:[],elevations:[],lastElevationCount:0,userAttention:true,
    qaPacket:packet({attempt:4}),workerResult:{exitCode:0},failure:{status:'fail',output:'owner still alive'},...extra};
  await atomicWriteJson(path.join(root,'current-task.json'),{...task,automation:{recovery}});await atomicWriteJson(path.join(root,'qa-packet.json'),recovery.qaPacket);
  await atomicWriteJson(path.join(root,'last-result.json'),{task,result:{qa:recovery.failure,history:[]}});await state.record({type:'user-attention',qa:recovery.failure.output});return recovery;
 }};
}
export async function until(check){for(let i=0;i<500;i++){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,5));}throw new Error('Timed out waiting for fake state');}
