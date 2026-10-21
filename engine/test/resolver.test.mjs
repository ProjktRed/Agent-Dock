import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,copyFile,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as resolver from '../src/blocked-resolver.mjs';
import {atomicWriteJson,DashboardState} from '../src/dashboard-state.mjs';
import {CodexWorker,CodexUsageLimitError} from '../src/codex-worker.mjs';
import {runNodeLoop} from '../src/node-loop.mjs';

const task={id:'P1-004-fake',name:'Fake',prompt:'Task skill: implement\nFix test',allowedPaths:['test.txt'],qaCommand:'fake test'};
const advice={status:'correction',preserve:['valid test'],rootProblem:'scratch file outside scope',previousStrategyFailure:'workspace helper',newStrategy:'direct edits only',nextWorkerInstructions:'Fix only test.txt without repository helper files.',neededEvidence:[],failureReason:'scope violation'};
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'resolver-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=path.join(root,'repo'),stateDir=path.join(root,'state');await mkdir(workspace);await mkdir(stateDir);
 const git=(...args)=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init');git('config','user.name','Fake');git('config','user.email','fake@example.invalid');await writeFile(path.join(workspace,'test.txt'),'baseline');git('add','.');git('commit','-m','baseline');
 const baselineSha=git('rev-parse','HEAD');
 const state=new DashboardState({stateDir});await state.initialize({task,workspace});
 const baseline=await resolver.captureScratchBaseline(workspace);
 resolver.recordScratchEvent(baseline,{type:'cline-command',commands:['powershell -Command "Out-File -FilePath temp_test.txt"']});
 await writeFile(path.join(workspace,'temp_test.txt'),'owned scratch');await writeFile(path.join(workspace,'test.txt'),'valid implementation');
 const ownership=await resolver.finalizeScratchOwnership(workspace,baseline);
 const qaPacket={task,baselineSha,attempt:1,diff:{text:'scoped diff',bytes:11},changedFiles:['test.txt','temp_test.txt'],qaEvidence:{command:{command:'fake test',exitCode:0},scope:{status:'FAIL',unexpectedPaths:['temp_test.txt'],message:'Changes outside allowedPaths: temp_test.txt'},categories:{scopeCheck:'FAIL'}}};
 await atomicWriteJson(path.join(stateDir,'current-task.json'),{...task,automation:{recovery:{version:1,baselineSha,attempt:1,phase:'blocked',blockedReason:'Changes outside allowedPaths: temp_test.txt',scratchOwnership:ownership,workerResult:{exitCode:0},qaPacket,history:[],correctionHistory:[],correctionCount:0,elevations:[],lastElevationCount:0}}});
 await atomicWriteJson(path.join(stateDir,'qa-packet.json'),qaPacket);await state.record({type:'blocked',qa:'Changes outside allowedPaths: temp_test.txt'});
 return{root,workspace,stateDir,state,git};
}

async function operational(f){
 await unlink(path.join(f.workspace,'temp_test.txt'));
 const file=path.join(f.stateDir,'current-task.json'),current=JSON.parse(await readFile(file,'utf8'));
 current.automation.recovery.blockedReason='Cline editing guard stopped attempt: command is not approved validation/read-only inspection; use native editing tools, not shell writes';
 await atomicWriteJson(file,current);await f.state.record({type:'blocked',qa:current.automation.recovery.blockedReason});
}
test('automatic Resolver recovers guard rejection through Assessment without mutating implementation',async t=>{
 const f=await fixture(t);await operational(f);let calls=0;
 const result=await resolver.runBlockedResolver({...f,automatic:true,codex:{assertIdle:async()=>{},resolveBlocked:async input=>{calls++;assert.match(input.failure.reason,/editing guard/);return {...advice,newStrategy:'Use native read_files instead of PowerShell inspection.'};}},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)});
 assert.equal(result.status,'ready');assert.equal(calls,1);assert.equal(result.recovery.phase,'correction-assessment');assert.match(result.recovery.failure.output,/native read_files/);assert.equal(await readFile(path.join(f.workspace,'test.txt'),'utf8'),'valid implementation');
});
test('automatic Resolver diagnoses unsafe scope once but never unblocks it',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.workspace,'temp_test.txt'),'no longer matches proof');let calls=0;
 const options={...f,automatic:true,codex:{assertIdle:async()=>{},resolveBlocked:async()=>{calls++;return advice;}},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)};
 assert.equal((await resolver.runBlockedResolver(options)).status,'blocked');assert.equal(calls,1);assert.equal((await resolver.runBlockedResolver(options)).status,'blocked');assert.equal(calls,1);assert.equal(await readFile(path.join(f.workspace,'temp_test.txt'),'utf8'),'no longer matches proof');
});
test('automatic Resolver respects Pause at a blocked safe point',async t=>{
 const f=await fixture(t);await operational(f);await f.state.setControl('pause');let calls=0;
 const result=await resolver.runBlockedResolver({...f,automatic:true,codex:{assertIdle:async()=>{},resolveBlocked:async()=>{calls++;return advice;}},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)});
 assert.equal(result.status,'paused');assert.equal(calls,0);
});
test('automatic Resolver has a durable three-recovery budget',async t=>{
 const f=await fixture(t);await operational(f);const file=path.join(f.stateDir,'current-task.json'),current=JSON.parse(await readFile(file,'utf8'));current.automation.recovery.resolverRecoveries=[{strategy:'a'},{strategy:'b'},{strategy:'c'}];await atomicWriteJson(file,current);let calls=0;
 const result=await resolver.runBlockedResolver({...f,automatic:true,codex:{assertIdle:async()=>{},resolveBlocked:async()=>{calls++;return advice;}},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)});
 assert.equal(result.status,'blocked');assert.equal(calls,0);
});
test('saved operational block automatically reaches Resolver, Assessment, fake Cline and QA',async t=>{
 const f=await fixture(t);await operational(f);const order=[];
 const result=await runNodeLoop({workspace:f.workspace,stateDir:f.stateDir,codex:{activeCount:0,assertIdle:async()=>{},resolveBlocked:async()=>{order.push('resolver');return advice;}},worker:{withExclusive:fn=>fn(),run:async()=>{order.push('cline');return{exitCode:0};}},assessCorrection:async()=>{order.push('assessment');return advice;},review:async()=>{order.push('qa');return{status:'pass',output:'verified'};},verify:async()=>{},prepareQa:async()=>({task,diff:{text:'diff',bytes:4},changedFiles:['test.txt'],qaEvidence:{command:{exitCode:0},scope:{status:'PASS'},categories:{scopeCheck:'PASS'}}}),stopAfterTask:true,readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e),pollMs:1});
 assert.equal(result.status,'passed');assert.deepEqual(order,['resolver','assessment','cline','qa']);
});
test('new worker guard failure releases exclusivity before automatic Resolver and continues loop',async t=>{
 const f=await fixture(t);await operational(f);const file=path.join(f.stateDir,'current-task.json'),current=JSON.parse(await readFile(file,'utf8'));current.automation.recovery.phase='worker';current.automation.recovery.prompt='Task skill: implement\nOne bounded edit';await atomicWriteJson(file,current);let held=false,workers=0,calls=0;
 const result=await runNodeLoop({workspace:f.workspace,stateDir:f.stateDir,codex:{activeCount:0,assertIdle:async()=>{},resolveBlocked:async()=>{assert.equal(held,true);assert.equal(workers,1);calls++;return advice;}},worker:{withExclusive:async fn=>{assert.equal(held,false);held=true;try{return await fn();}finally{held=false;}},run:async()=>{if(++workers===1)throw Error('Cline editing guard stopped attempt: unknown or unapproved tool: shell');return{exitCode:0};}},assessCorrection:async()=>advice,review:async()=>({status:'pass',output:'verified'}),verify:async()=>{},prepareQa:async()=>({task,diff:{text:'diff',bytes:4},changedFiles:['test.txt'],qaEvidence:{command:{exitCode:0},scope:{status:'PASS'},categories:{scopeCheck:'PASS'}}}),stopAfterTask:true,readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e),pollMs:1});
 assert.equal(result.status,'passed');assert.equal(workers,2);assert.equal(calls,1);
});
test('Resolver cannot repeatedly apply identical recovery strategy under a changed fingerprint',async t=>{
 const f=await fixture(t);await operational(f);const options={...f,automatic:true,codex:{assertIdle:async()=>{},resolveBlocked:async()=>advice},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)};
 assert.equal((await resolver.runBlockedResolver(options)).status,'ready');
 const file=path.join(f.stateDir,'current-task.json'),current=JSON.parse(await readFile(file,'utf8'));current.automation.recovery.phase='blocked';current.automation.recovery.blockedReason='Cline editing guard stopped attempt: unknown or unapproved tool: another';await atomicWriteJson(file,current);await f.state.record({type:'blocked',qa:current.automation.recovery.blockedReason});
 assert.equal((await resolver.runBlockedResolver(options)).status,'blocked');assert.equal(JSON.parse(await readFile(file,'utf8')).automation.recovery.resolverRecoveries.length,1);
});
test('Resolver module exposes bounded recovery rather than an unconditional unblock',()=>assert.equal(typeof resolver.runBlockedResolver,'function'));

test('operational recovery refuses truncated diff evidence',()=>{
 assert.equal(resolver.canRecoverOperational({headMatches:true,unexpectedPaths:[],currentDiff:{truncated:true},failure:{reason:'Cline editing guard stopped attempt: unknown or unapproved tool: shell'}}),false);
});

test('Resolver receives actual guard capabilities and bounded rejected command metadata',async t=>{
 const f=await fixture(t);await operational(f);await mkdir(path.join(f.stateDir,'cline-guard'));
 const capabilities={allowedPaths:task.allowedPaths,approvedCommands:[task.qaCommand],nativeTools:['read_files','editor','run_commands'],editFailures:[{tool:'editor',input:{old_text:'missing'},error:'text not found'}],lastRejection:{tool:'run_commands',path:null,commands:'{"commands":["Get-Content test.txt | Format-Hex"]}'}};
 await atomicWriteJson(path.join(f.stateDir,'cline-guard','policy.json'),capabilities);
 const input=await resolver.loadResolverCase(f.stateDir);assert.deepEqual(input.workerCapabilities,capabilities);
});

test('manual invocation cannot bypass the per-task recovery budget',async t=>{
 const f=await fixture(t);await operational(f);const file=path.join(f.stateDir,'current-task.json'),current=JSON.parse(await readFile(file,'utf8'));current.automation.recovery.resolverRecoveries=[{strategy:'a'},{strategy:'b'},{strategy:'c'}];await atomicWriteJson(file,current);
 assert.equal((await resolver.runBlockedResolver({...f,codex:{resolveBlocked:()=>assert.fail('budget bypass')},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)})).status,'blocked');
});

test('Pause during Resolver defers application and Resume consumes the same completed result',async t=>{
 const f=await fixture(t);await operational(f);let calls=0;const options={...f,automatic:true,codex:{assertIdle:async()=>{},resolveBlocked:async()=>{calls++;await f.state.setControl('pause');return advice;}},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)};
 assert.equal((await resolver.runBlockedResolver(options)).status,'paused');assert.equal(JSON.parse(await readFile(path.join(f.stateDir,'current-task.json'),'utf8')).automation.recovery.phase,'blocked');
 await f.state.setControl('resume');assert.equal((await resolver.runBlockedResolver(options)).status,'ready');assert.equal(calls,1);
});

test('saved BLOCKED Resolver requires shared worker exclusivity before invoking Sol',async t=>{
 const f=await fixture(t);await operational(f);let locked=false;
 const result=await runNodeLoop({...f,codex:{activeCount:0,assertIdle:async()=>{},resolveBlocked:()=>assert.fail('busy worker must block Resolver')},worker:{withExclusive:async()=>{locked=true;return null;}},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)});
 assert.equal(result.status,'blocked');assert.equal(locked,true);
});

test('new scratch recovery does not reuse a completed preservation journal',async t=>{
 const f=await fixture(t);const file=path.join(f.stateDir,'current-task.json'),current=JSON.parse(await readFile(file,'utf8'));current.automation.recovery.resolverJournal={status:'completed',entries:[{path:'old.tmp',destination:'old'}]};await atomicWriteJson(file,current);
 assert.equal((await resolver.runBlockedResolver({...f,codex:{assertIdle:async()=>{},resolveBlocked:async()=>advice},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)})).status,'ready');
});

test('scope text cannot override an explicitly unsafe cause',()=>{
 assert.equal(resolver.canArchiveScratch({reason:'Changes outside allowedPaths: temp_test.txt',cause:'missing-permissions',headMatches:true,unexpectedPaths:['temp_test.txt'],verifiedScratch:[{path:'temp_test.txt'}]}),false);
});

test('malformed Resolver correction cannot preserve or remove scratch',async t=>{
 const f=await fixture(t);
 await assert.rejects(resolver.runBlockedResolver({...f,codex:{assertIdle:async()=>{},resolveBlocked:async()=>({status:'correction'})},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e),pollMs:1}),/Malformed|missing/i);
 assert.equal(await readFile(path.join(f.workspace,'temp_test.txt'),'utf8'),'owned scratch');
});

test('concurrent Resolve clicks enqueue once and Pause/Stop keep existing control state',async t=>{
 const f=await fixture(t);
 const clicks=await Promise.allSettled([f.state.setControl('resolve'),f.state.setControl('resolve')]);
 assert.equal(clicks.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await f.state.readLive()).resolverRequested,true);
 await f.state.setControl('pause');assert.equal((await f.state.readControl()).pauseAfterCurrent,true);
 await f.state.setControl('stop');assert.equal((await f.state.readControl()).stopAfterSafePoint,true);
});

test('restart reconciles already preserved scratch without repeating Sol',async t=>{
 const f=await fixture(t),input=await resolver.loadResolverCase(f.stateDir);
 const file=path.join(f.stateDir,'current-task.json'),current=JSON.parse(await readFile(file,'utf8'));
 const operationId='fake-operation',entry={...input.verifiedScratch[0],destination:path.join(f.stateDir,'resolver-archive',operationId,'temp_test.txt')};
 current.automation.recovery.resolverJournal={status:'applying',input,result:advice,operationId,entries:[entry]};
 await atomicWriteJson(file,current);await mkdir(path.dirname(entry.destination),{recursive:true});await copyFile(path.join(f.workspace,entry.path),entry.destination);await unlink(path.join(f.workspace,entry.path));
 const result=await resolver.runBlockedResolver({...f,codex:{assertIdle:async()=>{},resolveBlocked:()=>assert.fail('Sol must not repeat')},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)});
 assert.equal(result.status,'ready');assert.equal(await readFile(entry.destination,'utf8'),'owned scratch');
});

test('corrupt preservation journal cannot redirect archive writes',async t=>{
 const f=await fixture(t),input=await resolver.loadResolverCase(f.stateDir);
 const file=path.join(f.stateDir,'current-task.json'),current=JSON.parse(await readFile(file,'utf8'));
 current.automation.recovery.resolverJournal={status:'applying',input,result:advice,operationId:'fake-operation',entries:[{...input.verifiedScratch[0],destination:path.join(f.workspace,'unapproved.txt')}]};
 await atomicWriteJson(file,current);
 await assert.rejects(resolver.runBlockedResolver({...f,codex:{assertIdle:async()=>{}},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)}),/Malformed.*journal/);
 assert.equal(await readFile(path.join(f.workspace,'temp_test.txt'),'utf8'),'owned scratch');
});
test('Resolver and both Assessment operations use 6.1 Sol Medium with read-only resolver',async()=>{
 const c=Object.create(CodexWorker.prototype),calls=[];c.invoke=async(...args)=>{calls.push(args);return{status:'done'};};
 await c.assess({objective:'one'});await c.assessCorrection({task});assert.equal(typeof c.resolveBlocked,'function');await c.resolveBlocked({task});
 assert.deepEqual(calls.map(c=>c[2].model),['gpt-6.1-sol','gpt-6.1-sol','gpt-6.1-sol']);assert.ok(calls.every(c=>c[2].reasoningEffort==='medium'));assert.equal(calls[2][1],'read-only');
});
test('verified scratch is preserved outside repo; correction goes to Assessment, not directly Cline',async t=>{
 const f=await fixture(t);let calls=0;
 const result=await resolver.runBlockedResolver({...f,codex:{assertIdle:async()=>{},resolveBlocked:async input=>{calls++;assert.equal(input.task.id,task.id);assert.equal(input.qaPacket.attempt,1);assert.match(input.currentDiff.text,/valid implementation/);return advice;}},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e),pollMs:1});
 assert.equal(result.status,'ready');assert.equal(calls,1);assert.equal(f.git('status','--porcelain'),'M test.txt');
 assert.equal(await readFile(result.archived[0].destination,'utf8'),'owned scratch');
 const current=JSON.parse(await readFile(path.join(f.stateDir,'current-task.json'),'utf8'));assert.equal(current.automation.recovery.phase,'correction-assessment');assert.equal(current.automation.recovery.attempt,1);
 assert.equal(current.automation.recovery.resolverResult.status,'correction');
 const again=await resolver.runBlockedResolver({...f,codex:{resolveBlocked:()=>assert.fail('duplicate')},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e)});assert.equal(again.status,'blocked');
});
test('unknown, changed, tracked and pre-existing scratch files are never archived',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.workspace,'temp_test.txt'),'changed after proof');
 const input=await resolver.loadResolverCase(f.stateDir);assert.equal(input.verifiedScratch.length,0);
 const result=await resolver.runBlockedResolver({...f,codex:{assertIdle:async()=>{},resolveBlocked:async()=>advice},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e),pollMs:1});
 assert.equal(result.status,'blocked');assert.equal(await readFile(path.join(f.workspace,'temp_test.txt'),'utf8'),'changed after proof');
 const baseline=await resolver.captureScratchBaseline(f.workspace);resolver.recordScratchEvent(baseline,{type:'cline-file-modified',path:'temp_test.txt'});assert.deepEqual((await resolver.finalizeScratchOwnership(f.workspace,baseline)).files,[]);
 resolver.recordScratchEvent(baseline,{type:'cline-file-modified',path:'test.txt'});assert.deepEqual((await resolver.finalizeScratchOwnership(f.workspace,baseline)).files,[]);
});
test('unexpected HEAD and security/permission/state blocks remain blocked despite model correction',async t=>{
 const f=await fixture(t);f.git('add','test.txt');f.git('commit','-m','unexpected');
 const result=await resolver.runBlockedResolver({...f,codex:{assertIdle:async()=>{},resolveBlocked:async()=>advice},readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e),pollMs:1});assert.equal(result.status,'blocked');
 assert.equal(await readFile(path.join(f.workspace,'temp_test.txt'),'utf8'),'owned scratch');
 for(const reason of ['permission denied','security policy failure','corrupted state','unsafe commit','unexpected HEAD']){
  assert.equal(resolver.canArchiveScratch({reason,headMatches:true,unexpectedPaths:['temp_test.txt'],verifiedScratch:[{path:'temp_test.txt'}]}),false);
 }
});
test('Resolver usage limit stores identical input and Resume retries only Resolver',async t=>{
 const f=await fixture(t);let calls=0,first;
 const loop=resolver.runBlockedResolver({...f,codex:{assertIdle:async()=>{},resolveBlocked:async input=>{calls++;if(calls===1){first=JSON.stringify(input);throw new CodexUsageLimitError({message:"You've hit your usage limit; try again at 10:07 PM",retryAt:'try again at 10:07 PM'});}assert.equal(JSON.stringify(input),first);return advice;}},readControl:()=>f.state.readControl(),onEvent:async e=>{await f.state.record(e);if(e.type==='waiting-for-codex'){const pending=JSON.parse(await readFile(path.join(f.stateDir,'pending-codex.json'),'utf8'));assert.equal(pending.operation,'resolver');assert.equal((await f.state.readLive()).stage,'WAITING_FOR_LIMIT');await f.state.setControl('resume');}},pollMs:1});
 assert.equal((await loop).status,'ready');assert.equal(calls,2);
});
test('Resolver is unavailable while a worker runs or identical fingerprint was used',async t=>{
 const f=await fixture(t);const input=await resolver.loadResolverCase(f.stateDir),live=await f.state.readLive();
 assert.equal(resolver.resolverAvailability({live,input}).available,true);
 assert.equal(resolver.resolverAvailability({live:{...live,clineStatus:'running'},input}).available,false);
 assert.equal(resolver.resolverAvailability({live:{...live,resolverUsedForFingerprint:input.fingerprint},input}).available,false);
 const changed={...input,fingerprint:'different'};assert.equal(resolver.resolverAvailability({live:{...live,resolverUsedForFingerprint:input.fingerprint},input:changed}).available,true);
});
test('automatic block recovery uses real provenance; Sol closes before correction worker starts',async t=>{
 const f=await fixture(t);let active=false,workers=0,assessments=0;
 const result=await runNodeLoop({workspace:f.workspace,stateDir:f.stateDir,codex:{activeCount:0,assertIdle:async()=>assert.equal(active,false),resolveBlocked:async()=>{active=true;await Promise.resolve();active=false;return advice;}},manualResolver:true,
 worker:{withExclusive:fn=>fn(),run:async(prompt,hooks)=>{assert.equal(active,false);assert.match(prompt,/direct edits/);workers++;await hooks.onStart({pid:123});return{exitCode:0};}},
 assessCorrection:async input=>{assert.equal(input.resolverResult.newStrategy,'direct edits only');assessments++;return advice;},
 review:async()=>({status:'pass',output:'verified',commit:'fake'}),verify:async()=>{},prepareQa:async()=>({task,diff:{text:'diff',bytes:4},changedFiles:['test.txt'],attempt:2,qaEvidence:{command:{command:'fake test',exitCode:0},scope:{status:'PASS'},categories:{scopeCheck:'PASS'}}}),stopAfterTask:true,
 readControl:()=>f.state.readControl(),onEvent:e=>f.state.record(e),pollMs:1});
 assert.equal(result.status,'passed');assert.equal(workers,1);assert.equal(assessments,1);
});
