import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import {mkdtemp,readFile,rm,stat,utimes,writeFile} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {childArgs,childEnv,defaultRunCheck,endStepDown,forwardControl,freeWorktree,readChildRecord,runParallel,spawnChildEngine,stopOrphanChildren,worktreeFor,writeChildRecord} from '../src/parallel-run.mjs';
import {deferTask} from '../src/defer-task.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';
import {STEP_DOWN,TUNING,loadStepDown,parseTuning,stepDown,useTuning} from '../src/engine-tuning.mjs';
import {RUN,useRunLimits,watchUsage} from '../src/run-budget.mjs';

async function repo(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'parallel-'));
 const ws=path.join(root,'proj'),stateDir=path.join(root,'state');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
 execFileSync('git',['init','-q',ws]);git(ws,'config','user.email','t@example.com');git(ws,'config','user.name','T');git(ws,'config','core.autocrlf','false');
 await writeFile(path.join(ws,'base.txt'),'base\n');await writeFile(path.join(ws,'.gitignore'),'node_modules\n');git(ws,'add','.');git(ws,'commit','-qm','base');
 return {ws,stateDir,git};
}
const task=(id,file,extra={})=>({id,name:'Task '+id,prompt:'Task skill: implement\n'+id,allowedPaths:[file],qaCommand:'npm test',...extra});
const commitIn=async(git,{task,worktree})=>{
 await writeFile(path.join(worktree,task.allowedPaths[0]),task.id+'\n');git(worktree,'add','.');git(worktree,'commit','-qm','QA: '+task.id);
 return{status:'passed',commit:git(worktree,'rev-parse','HEAD')};
};
const started=(events,id)=>events.find(e=>e.type==='parallel-task-started'&&e.taskId===id)?.worktree;
const readJson=file=>readFile(file,'utf8').then(JSON.parse,()=>({}));

test('child engines get the parent arguments for one task in its worktree, without step-down',()=>{
 const args=childArgs(['--workspace','C:/p','--objective','Build','--parallel','3','--auto-continue','false','--step-down','true','--task','old.json'],{worktree:'C:/p-parallel/A',stateDir:'C:/s/A',taskFile:'C:/s/A/task.json'});
 assert.deepEqual(args,['--objective','Build','--workspace','C:/p-parallel/A','--state-dir','C:/s/A','--task','C:/s/A/task.json','--single-task','true','--auto-continue','true','--step-down','false','--supervisor','off']);
 assert.equal(worktreeFor(path.join('C:','work','proj'),'T 1-2'),path.join('C:','work','proj-parallel','T_1-2'));
});

test('a round runs disjoint tasks side by side and merges each only when its check passes on the combined code',async t=>{
 const {ws,stateDir,git}=await repo(t);
 const A=task('A','a.txt',{planItems:['Add a']}),B=task('B','b.txt'),C=task('C','a.txt');
 const objectives=[];let assessments=0;const events=[];
 let running=0,peak=0;
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:3,pollMs:20,
  assess:async({objective})=>{objectives.push(objective);assessments++;
   // Round 1: A, B, then C overlaps A and closes the batch. Round 2: done.
   return assessments===1?{status:'task',task:A}:assessments===2?{status:'task',task:B}:assessments===3?{status:'task',task:C}:{status:'done'};},
  runChild:async run=>{
   // Wait (bounded) for the other task: git can be slow to add a worktree on a busy machine.
   running++;peak=Math.max(peak,running);for(let i=0;i<500&&peak<2;i++)await new Promise(r=>setTimeout(r,10));running--;
   return commitIn(git,run);
  },
  runCheck:async(command,cwd)=>({exitCode:existsSync(path.join(cwd,'b.txt'))&&!existsSync(path.join(cwd,'a.txt'))?1:0,output:'b needs a'}),
  onEvent:async e=>events.push(e),readControl:async()=>({})});
 assert.equal(result.status,'done');
 assert.equal(peak,2,'both tasks ran at the same time');
 assert.match(objectives[1],/Already running in parallel this round: A "Task A" \(files: a\.txt\)/);
 assert.deepEqual(git(ws,'log','--format=%s').split('\n'),['QA: B','QA: A','base'],'each approved commit lands on the branch with its own message');
 assert.equal(git(ws,'status','--porcelain'),'');
 assert.deepEqual(events.filter(e=>e.type==='qa-pass').map(e=>[e.taskId,e.planItems]),[['A',['Add a']],['B',undefined]]);
 assert.ok(started(events,'A')&&!existsSync(started(events,'A')),'merged worktrees are removed');
 assert.equal(git(ws,'branch','--list','agent-dock/*'),'','and their branches');
});

test('removing a merged worktree never deletes the project node_modules behind its link',async t=>{
 const {ws,stateDir,git}=await repo(t);
 mkdirSync(path.join(ws,'node_modules','dep'),{recursive:true});
 await writeFile(path.join(ws,'node_modules','dep','index.js'),'module.exports=1;\n');
 let assessments=0;const events=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  assess:async()=>(++assessments===1?{status:'task',task:task('A','a.txt')}:assessments===2?{status:'task',task:task('B','b.txt')}:{status:'done'}),
  runChild:async run=>{assert.ok(existsSync(path.join(run.worktree,'node_modules','dep','index.js')),'the worktree sees the dependencies');return commitIn(git,run);},
  runCheck:async()=>({exitCode:0,output:''}),onEvent:async e=>events.push(e),readControl:async()=>({})});
 assert.equal(result.status,'done');
 assert.ok(!existsSync(started(events,'A'))&&!existsSync(started(events,'B')),'the worktrees are gone');
 assert.equal(await readFile(path.join(ws,'node_modules','dep','index.js'),'utf8'),'module.exports=1;\n','the project node_modules is still there');
});

test('a change whose check fails on the combined code is not committed and stays on its branch',async t=>{
 const {ws,stateDir,git}=await repo(t);
 let assessments=0;const events=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  assess:async()=>(++assessments===1?{status:'task',task:task('A','a.txt')}:assessments===2?{status:'task',task:task('B','b.txt')}:{status:'done'}),
  runChild:async run=>run.task.id==='B'?{status:'user-attention',output:'QA failed'}:commitIn(git,run),
  runCheck:async()=>({exitCode:1,output:'1 failing test'}),
  onEvent:async e=>events.push(e),readControl:async()=>({})});
 assert.equal(result.status,'user-attention');
 assert.match(result.output,/A its check failed on the combined code: 1 failing test; kept on branch agent-dock\/parallel-A-/);
 assert.match(result.output,/B: user-attention \(QA failed\); its worktree stays at/);
 assert.equal(git(ws,'log','--format=%s'),'base','nothing was committed');
 assert.equal(git(ws,'status','--porcelain'),'','and the tree is clean');
 assert.ok(existsSync(started(events,'B')),'an unfinished task keeps its worktree');
 assert.match(git(ws,'branch','--list','agent-dock/*'),/parallel-A-/);
 assert.ok(events.some(e=>e.type==='parallel-merge-failed'&&e.taskId==='A'));
});

test('a later run reusing a task id gets its own worktree; a task that cannot start stops the others',async t=>{
 const {ws,stateDir,git}=await repo(t);
 // The first run leaves A unfinished: its worktree is kept.
 let assessments=0;const events=[];
 await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,
  assess:async()=>(++assessments===1?{status:'task',task:task('A','a.txt')}:{status:'done'}),
  runChild:async()=>({status:'user-attention',output:'QA failed'}),onEvent:async e=>events.push(e),readControl:async()=>({})});
 const kept=started(events,'A');
 assert.ok(existsSync(kept));
 // The next run picks A again, and B..x, whose branch name git refuses, so it cannot start.
 assessments=0;events.length=0;const seen=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:10,
  assess:async()=>(++assessments===1?{status:'task',task:task('A','a.txt')}:assessments===2?{status:'task',task:task('B..x','b.txt')}:{status:'done'}),
  runChild:async({stateDir:childState})=>{
   for(let i=0;i<200;i++){if((await readJson(path.join(childState,'control.json'))).stopAfterSafePoint){seen.push('A stopped');break;}await new Promise(r=>setTimeout(r,10));}
   return{status:'stopped'};},
  onEvent:async e=>events.push(e),readControl:async()=>({})});
 assert.ok(started(events,'A')&&started(events,'A')!==kept,'a new worktree, not the kept one');
 assert.deepEqual(seen,['A stopped'],'the started task got Stop and was waited for');
 assert.equal(result.status,'blocked');
 assert.match(result.output,/B\.\.x could not start/);
 assert.match(result.output,/A: stopped/);
 assert.equal(git(ws,'status','--porcelain'),'');
});

test('Stop reaches the running task engines and ends the run',async t=>{
 const {ws,stateDir}=await repo(t);
 let stop=false;const seen=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:10,
  assess:async()=>({status:'task',task:task('A','a.txt')}),
  runChild:async({stateDir:childState})=>{stop=true;
   for(let i=0;i<100;i++){if((await readJson(path.join(childState,'control.json'))).stopAfterSafePoint){seen.push('child stopped');break;}await new Promise(r=>setTimeout(r,10));}
   return{status:'stopped'};},
  onEvent:async()=>{},readControl:async()=>({stopAfterSafePoint:stop})});
 assert.deepEqual(seen,['child stopped']);
 assert.equal(result.status,'stopped');
});

test('Pause reaches the running tasks, and the next round waits while paused (Automatic continuation off)',async t=>{
 const {ws,stateDir,git}=await repo(t);
 let pause=false,assessments=0;const order=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:10,
  assess:async()=>{order.push('assess');return ++assessments===1?{status:'task',task:task('A','a.txt')}:assessments===2?{status:'task',task:task('B','b.txt')}:{status:'done'};},
  runChild:async run=>{
   if(run.task.id==='A'){
    // Pause during the task reaches its engine; Resume clears it there too.
    pause=true;
    const control=()=>readJson(path.join(run.stateDir,'control.json'));
    for(let i=0;i<200&&!(await control()).pauseAfterCurrent;i++)await new Promise(r=>setTimeout(r,10));
    order.push('child paused');pause=false;
    for(let i=0;i<200&&(await control()).pauseAfterCurrent;i++)await new Promise(r=>setTimeout(r,10));
    order.push('child resumed');
   }
   return commitIn(git,run);
  },
  runCheck:async()=>({exitCode:0,output:''}),
  // As with Automatic continuation off: an approved task pauses the run; Resume comes a little later.
  onEvent:async e=>{order.push(e.type);if(e.type==='qa-pass'&&e.taskId==='A')pause=true;if(e.type==='paused')setTimeout(()=>{order.push('resume');pause=false;},50);},
  readControl:async()=>({pauseAfterCurrent:pause})});
 assert.equal(result.status,'done');
 const at=x=>order.indexOf(x);
 assert.ok(at('child paused')>=0&&at('child paused')<at('child resumed'));
 assert.ok(at('qa-pass')<at('paused')&&at('paused')<at('resume'),'the run paused after the approved task');
 assert.equal(order.slice(at('qa-pass'),at('resume')).filter(x=>x==='assess').length,0,'the next round waited for Resume');
 assert.equal(order.filter(x=>x==='assess').length,3);
});

test('each task engine\'s tokens and spend count toward the run and the day, once',async t=>{
 const {ws,stateDir,git}=await repo(t);
 t.after(()=>useRunLimits());
 useRunLimits();
 await watchUsage({setControl:async()=>{},record:async()=>{}},stateDir);
 let assessments=0;
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  assess:async()=>(++assessments===1?{status:'task',task:task('A','a.txt')}:assessments===2?{status:'task',task:task('B','b.txt')}:{status:'done'}),
  runChild:async run=>({...(await commitIn(git,run)),usage:{tokens:1100,input:1000,cached:200,output:300,costUsd:0.5,estimatedUsd:0.1,calls:4}}),
  runCheck:async()=>({exitCode:0,output:''}),onEvent:async()=>{},readControl:async()=>({})});
 assert.equal(result.status,'done');
 assert.deepEqual(RUN.usage,{input:2000,cached:400,output:600,costUsd:1,estimatedUsd:0.2,calls:8});
 assert.equal(RUN.day.tokens,2200);
 const day=await readJson(path.join(stateDir,'usage-day.json'));
 assert.equal(day.tokens,2200);
 assert.equal(day.costUsd,1);
});

test('a merged task carries its attempts, and its engine\'s usage reaches the run per role',async t=>{
 const {ws,stateDir,git}=await repo(t);
 const when=new Date('2026-10-01T10:00:00Z');
 let assessments=0;const events=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  assess:async()=>(++assessments===1?{status:'task',task:task('A','a.txt')}:{status:'done'}),
  runChild:async run=>{
   // The task engine's QA call and its Implementation metrics: a partial sample, then the final one.
   const call=path.join(run.stateDir,'codex','qa-call');mkdirSync(call,{recursive:true});
   await writeFile(path.join(call,'prompt.txt'),'You are QA for task A.\n'+'x'.repeat(5000));
   await writeFile(path.join(call,'events.ndjson'),'{"type":"error","message":"usage limit reached"}\n{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":5}}\n');
   await utimes(path.join(call,'events.ndjson'),when,when);
   const metric=(extra)=>JSON.stringify({type:'cline-provider-metrics',timestamp:'2026-10-01T09:00:00.000Z',runStartedAt:'r1',promptTokens:10,generatedTokens:1,...extra});
   await writeFile(path.join(run.stateDir,'activity.ndjson'),[metric({partial:true}),metric({promptTokens:90,generatedTokens:9}),'{"type":"qa-pass"}'].join('\n')+'\n');
   return{...(await commitIn(git,run)),attempts:2};
  },
  runCheck:async()=>({exitCode:0,output:''}),onEvent:async e=>events.push(e),readControl:async()=>({})});
 assert.equal(result.status,'done');
 assert.equal(events.find(e=>e.type==='qa-pass').attempt,2);
 const metrics=events.filter(e=>e.type==='cline-provider-metrics');
 assert.deepEqual(metrics.map(e=>[e.taskId,e.promptTokens,e.timestamp]),[['A',90,'2026-10-01T09:00:00.000Z']],'the final sample of the attempt, once, at its own time');
 const copy=path.join(stateDir,'codex','qa-call');
 assert.equal(await readFile(path.join(copy,'events.ndjson'),'utf8'),'{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":5}}\n','only the usage lines');
 assert.match(await readFile(path.join(copy,'prompt.txt'),'utf8'),/^You are QA for task A\./);
 assert.equal((await stat(path.join(copy,'events.ndjson'))).mtimeMs,when.getTime(),'dated as the call was');
});

test('a task that fails to merge in two rounds stops for you',async t=>{
 const {ws,stateDir,git}=await repo(t);
 let assessments=0;
 const others=['B','C','D'];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  // Every round: A again, and a new task that merges.
  assess:async()=>{const n=assessments++,other=others[(n-1)/2];return n%2===0?{status:'task',task:task('A','a.txt')}:{status:'task',task:task(other,other.toLowerCase()+'.txt')};},
  runChild:async run=>commitIn(git,run),
  runCheck:async(command,cwd)=>({exitCode:existsSync(path.join(cwd,'a.txt'))?1:0,output:'a breaks it'}),
  onEvent:async()=>{},readControl:async()=>({})});
 assert.equal(result.status,'user-attention');
 assert.match(result.output,/^A failed to merge twice\. Parallel round 2:/);
 assert.equal(assessments,4,'no third round');
 assert.deepEqual(git(ws,'log','--format=%s').split('\n'),['QA: C','QA: B','base']);
});

test('an unapproved check command sends Assessment back once, as in the normal loop',async t=>{
 const {ws,stateDir,git}=await repo(t);
 const seen=[];const events=[];let assessments=0;
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,
  assess:async({previous})=>{seen.push(previous?.result??null);assessments++;
   return assessments===1?{status:'task',task:task('A','a.txt',{qaCommand:'node --test test/a.test.js'})}:assessments===2?{status:'task',task:task('A','a.txt')}:{status:'done'};},
  runChild:async({worktree})=>{await writeFile(path.join(worktree,'a.txt'),'A\n');git(worktree,'add','.');git(worktree,'commit','-qm','QA: A');return{status:'passed',commit:git(worktree,'rev-parse','HEAD')};},
  runCheck:async()=>({exitCode:0,output:''}),
  onEvent:async e=>events.push(e),readControl:async()=>({})});
 assert.equal(result.status,'done');
 assert.match(seen[1],/not an approved check/);
 assert.ok(events.some(e=>e.type==='assessment-rejected'));
 assert.equal(git(ws,'log','-1','--format=%s'),'QA: A');
});

test('a second unapproved check command in a row blocks the run',async t=>{
 const {ws,stateDir}=await repo(t);
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,
  assess:async()=>({status:'task',task:task('A','a.txt',{qaCommand:'node --test'})}),
  runChild:async()=>{throw new Error('must not run');},onEvent:async()=>{},readControl:async()=>({})});
 assert.equal(result.status,'blocked');
 assert.match(result.output,/not an approved project check: node --test/);
});

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('a merged task ends a saved step-down, and while it lasts task engines work at the stepped-down size',async t=>{
 const {ws,stateDir,git}=await repo(t);
 t.after(()=>useTuning());
 mkdirSync(stateDir,{recursive:true});
 useTuning(parseTuning({'task-mode':'standard'}));
 await loadStepDown(stateDir);
 stepDown({id:'Big',name:'Big',planItems:['Add a']});await STEP_DOWN.saving;
 await writeFile(path.join(stateDir,'deferred-tasks.json'),JSON.stringify([{id:'Big',name:'Big',reason:'Failed review twice',stash:null,stepDown:{from:'standard',to:'eco'}}]));
 const sizing=STEP_DOWN.active?TUNING:null;
 assert.deepEqual(childArgs(['--objective','B','--task-mode','standard','--task-max-files','12'],{worktree:'W',stateDir:'S',taskFile:'T',sizing}),
  ['--objective','B','--task-mode','eco','--task-max-files','1','--task-max-new-lines','200','--task-max-read-files','3','--workspace','W','--state-dir','S','--task','T','--single-task','true','--auto-continue','true','--step-down','false','--supervisor','off']);
 const objectives=[],events=[];let n=0;
 const onEvent=async e=>events.push(e);
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,
  assess:async({objective})=>{objectives.push(objective);return ++n===1?{status:'task',task:task('A','a.txt',{planItems:['Add a']})}:{status:'done'};},
  runChild:async run=>commitIn(git,run),runCheck:async()=>({exitCode:0,output:''}),onEvent,readControl:async()=>({}),onMerged:endStepDown(onEvent)});
 assert.equal(result.status,'done');
 assert.match(objectives[0],/Stepped down: Big/);
 assert.doesNotMatch(objectives[1],/Stepped down/,'the next round plans at the configured size again');
 assert.deepEqual(events.filter(e=>e.type==='task-mode-restored').map(({mode,from})=>({mode,from})),[{mode:'standard',from:'eco'}]);
 assert.equal(TUNING.taskMode,'standard');
 await STEP_DOWN.saving;
 assert.ok(!existsSync(path.join(stateDir,'step-down.json')));
});

test('Resume reaches a task engine waiting out a usage limit, and the run says once which task waits',async t=>{
 const {ws,stateDir,git}=await repo(t);
 let resumes=0,n=0;const events=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:10,
  assess:async()=>(++n===1?{status:'task',task:task('A','a.txt')}:{status:'done'}),
  runChild:async run=>{
   // As node-loop: the wait ends only when this engine's own resumeGeneration goes up.
   const child=new DashboardState({stateDir:run.stateDir});
   await child.initialize({task:run.task,workspace:run.worktree});
   await child.record({type:'waiting-for-codex',operation:'implementation',message:'Usage limit reached'});
   for(let i=0;i<500&&!((await child.readControl()).resumeGeneration>0);i++)await sleep(10);
   if(!((await child.readControl()).resumeGeneration>0))return{status:'stopped',output:'Resume never arrived'};
   return commitIn(git,run);},
  runCheck:async()=>({exitCode:0,output:''}),
  onEvent:async e=>{events.push(e);if(e.type==='waiting-for-codex')setTimeout(()=>{resumes=1;},30);},
  readControl:async()=>({resumeGeneration:resumes})});
 assert.equal(result.status,'done');
 const waits=events.filter(e=>e.type==='waiting-for-codex');
 assert.equal(waits.length,1);
 assert.equal(waits[0].taskId,'A');assert.equal(waits[0].operation,'implementation');assert.equal(waits[0].message,'Usage limit reached');
 assert.equal(git(ws,'log','-1','--format=%s'),'QA: A');
});

test('task ids that clean up to the same name, or differ only in case, get their own worktrees in one round',async t=>{
 const {ws,stateDir,git}=await repo(t);
 const taken=new Set();
 const names=['a b','a/b','A_B'].map(id=>path.basename(freeWorktree(ws,id.replace(/[^\w.-]+/g,'_'),taken)));
 assert.deepEqual(names,['a_b','a_b-2','A_B-3']);
 let n=0;const events=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  assess:async()=>(++n===1?{status:'task',task:task('a b','a.txt')}:n===2?{status:'task',task:task('a/b','b.txt')}:{status:'done'}),
  runChild:async run=>commitIn(git,run),runCheck:async()=>({exitCode:0,output:''}),onEvent:async e=>events.push(e),readControl:async()=>({})});
 assert.equal(result.status,'done');
 assert.notEqual(started(events,'a b'),started(events,'a/b'));
 assert.deepEqual(git(ws,'log','--format=%s').split('\n'),['QA: a/b','QA: a b','base']);
});

test('a task its engine set aside is listed for the next round\'s Assessment, once',async t=>{
 const {ws,stateDir,git}=await repo(t);
 mkdirSync(stateDir,{recursive:true});
 await writeFile(path.join(stateDir,'deferred-tasks.json'),JSON.stringify([{id:'A',name:'Task A',reason:'Old reason',stash:null},{id:'C',name:'Task C',reason:'Earlier',stash:null}]));
 const objectives=[];let n=0;
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  assess:async({objective})=>{objectives.push(objective);return ++n===1?{status:'task',task:task('A','a.txt')}:n===2?{status:'task',task:task('B','b.txt')}:{status:'done'};},
  runChild:async run=>{
   if(run.task.id!=='A')return commitIn(git,run);
   await writeFile(path.join(run.stateDir,'deferred-tasks.json'),JSON.stringify([{id:'A',name:'Task A',reason:'Too big',stash:{ref:'abc123',message:'Agent Dock: deferred A - Too big'},at:'2026-01-01T00:00:00.000Z'}]));
   return{status:'deferred',output:'Deferred: Too big'};},
  runCheck:async()=>({exitCode:0,output:''}),onEvent:async()=>{},readControl:async()=>({})});
 assert.equal(result.status,'done');
 const list=JSON.parse(await readFile(path.join(stateDir,'deferred-tasks.json'),'utf8'));
 assert.deepEqual(list.map(d=>[d.id,d.reason,d.stash?.message??null]),[['C','Earlier',null],['A','Too big','Agent Dock: deferred A - Too big']]);
 assert.match(objectives[2],/Deferred tasks .*A "Task A" \(Too big\)/);
});

test('control forwarded to one task engine queues its writes, so none is lost',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'parallel-control-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const state=new DashboardState({stateDir:dir});
 await Promise.all([1,2,3,4,5].map(()=>forwardControl([state],'resume')));
 assert.equal((await state.readControl()).resumeGeneration,5);
});

// ---- Parallel-run fixes: endings recorded, usage-limit wait cleared, quiet children, safe merges, orphans.
const done=n=>async()=>(n-->0?{status:'task',task:task('A','a.txt')}:{status:'done'});
const parentState=async(stateDir)=>{const state=new DashboardState({stateDir});await state.initialize({task:{id:'assessment',name:'Assessing',prompt:'p'},workspace:'w'});return state;};

test('a parallel run that ends blocked or for your attention records it, as the normal loop does',async t=>{
 const {ws,stateDir,git}=await repo(t);
 // Blocked: the working tree is not clean.
 await writeFile(path.join(ws,'dirty.txt'),'x\n');
 let state=await parentState(stateDir);const events=[];
 let result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,assess:done(1),runChild:async()=>{throw new Error('must not run');},
  onEvent:async e=>{events.push(e);await state.record(e);},readControl:async()=>({})});
 assert.equal(result.status,'blocked');
 assert.deepEqual(events.filter(e=>e.type==='blocked').map(e=>e.qa),[result.output]);
 assert.equal((await state.readLive()).stage,'BLOCKED');
 await rm(path.join(ws,'dirty.txt'));
 // Blocked: Assessment found no safe task.
 events.length=0;
 result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,assess:async()=>({status:'blocked',output:'No safe task'}),runChild:async()=>{throw new Error('must not run');},
  onEvent:async e=>{events.push(e);await state.record(e);},readControl:async()=>({})});
 assert.equal(result.status,'blocked');assert.equal(events.at(-1).type,'blocked');assert.equal(events.at(-1).qa,'No safe task');
 // Attention: nothing merged.
 state=await parentState(stateDir);events.length=0;
 result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,assess:done(1),runChild:async()=>({status:'user-attention',output:'QA failed'}),
  onEvent:async e=>{events.push(e);await state.record(e);},readControl:async()=>({})});
 assert.equal(result.status,'user-attention');
 assert.equal(events.at(-1).type,'user-attention');assert.equal(events.at(-1).qa,result.output);
 const live=await state.readLive();
 assert.equal(live.stage,'USER_ATTENTION');assert.equal(live.userAttention,true);assert.equal(live.userAttentionReason,result.output);
 assert.equal(git(ws,'status','--porcelain'),'');
});

test('the run leaves the usage-limit wait once no task waits any more, and never ends in it',async t=>{
 const {ws,stateDir,git}=await repo(t);
 const state=await parentState(stateDir);
 let resumes=0;const events=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:10,assess:done(1),
  runChild:async run=>{
   const child=new DashboardState({stateDir:run.stateDir});
   await child.initialize({task:run.task,workspace:run.worktree});
   await child.record({type:'waiting-for-codex',operation:'implementation',message:'Usage limit reached'});
   for(let i=0;i<500&&!((await child.readControl()).resumeGeneration>0);i++)await sleep(10);
   await child.record({type:'cline-started'});
   // Still working after the wait: the run must say so before the task ends.
   for(let i=0;i<300&&!events.some(e=>e.type==='parallel-limit-cleared');i++)await sleep(10);
   return commitIn(git,run);},
  runCheck:async()=>({exitCode:0,output:''}),
  onEvent:async e=>{events.push(e);await state.record(e);if(e.type==='waiting-for-codex')setTimeout(()=>{resumes=1;},30);},
  readControl:async()=>({resumeGeneration:resumes})});
 assert.equal(result.status,'done');
 const at=type=>events.findIndex(e=>e.type===type);
 assert.ok(at('waiting-for-codex')>=0&&at('waiting-for-codex')<at('parallel-limit-cleared'),'the wait is cleared');
 assert.ok(at('parallel-limit-cleared')<at('parallel-task-finished'),'while the task still works');
 assert.equal((await state.readLive()).stage,'complete');
 // In the live state too: the clearing event takes the run out of WAITING_FOR_LIMIT and drops the limit message.
 const s2=await parentState(path.join(stateDir,'s2'));
 await s2.record({type:'waiting-for-codex',taskId:'A',parallel:true,message:'Usage limit reached'});
 assert.equal((await s2.readLive()).stage,'WAITING_FOR_LIMIT');
 await s2.record({type:'parallel-limit-cleared',parallel:true});
 const live=await s2.readLive();assert.equal(live.stage,'waiting');assert.equal(live.codexLimitMessage,null);
});

test('a run stopped while a task waits out a usage limit ends stopped, not waiting',async t=>{
 const {ws,stateDir}=await repo(t);
 const state=await parentState(stateDir);
 let stop=false;const events=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:10,assess:done(1),
  runChild:async run=>{
   const child=new DashboardState({stateDir:run.stateDir});
   await child.initialize({task:run.task,workspace:run.worktree});
   await child.record({type:'waiting-for-codex',operation:'qa',message:'Usage limit reached'});
   for(let i=0;i<300&&!events.some(e=>e.type==='waiting-for-codex');i++)await sleep(10);
   stop=true;
   for(let i=0;i<300&&!(await child.readControl()).stopAfterSafePoint;i++)await sleep(10);
   return{status:'stopped'};},
  onEvent:async e=>{events.push(e);await state.record(e);},readControl:async()=>({stopAfterSafePoint:stop})});
 assert.equal(result.status,'stopped');
 assert.ok(events.some(e=>e.type==='parallel-limit-cleared'));
 assert.equal((await state.readLive()).stage,'stopped');
});

test('task engines run without the Supervisor or the notification channels, and with protected paths in their worktree',()=>{
 const ws=path.resolve('C:/work/proj'),wt=path.resolve('C:/work/proj-parallel/A');
 const args=childArgs(['--workspace',ws,'--supervisor','pause','--supervisor-review','act','--supervisor-reviewer','claude','--supervisor-may-defer','true','--sv-digest-hours','2','--sv-stall-minutes','5','--objective','B',
  '--protected-paths',JSON.stringify([path.join(ws,'secrets'),path.resolve('C:/elsewhere/keys'),'.env',ws])],{worktree:wt,stateDir:'S',taskFile:'T'});
 assert.deepEqual(args.filter(a=>/^--(supervisor|sv-)/.test(a)),['--supervisor'],'only the Supervisor off flag');
 assert.equal(args[args.indexOf('--supervisor')+1],'off');
 assert.deepEqual(JSON.parse(args[args.indexOf('--protected-paths')+1]),[path.join(wt,'secrets'),path.resolve('C:/elsewhere/keys'),'.env',wt],'absolute paths in the project name the same path in the worktree');
 assert.deepEqual(childEnv({AGENT_DOCK_NOTIFY:'{"discord":"x"}',PATH:'p',AGENT_DOCK_PROVIDER_KEY:'k'}),{PATH:'p',AGENT_DOCK_PROVIDER_KEY:'k'});
});

test('a task engine gets no notification settings and records its pid',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'parallel-spawn-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const cli=path.join(dir,'fake-cli.mjs'),childState=path.join(dir,'child');mkdirSync(childState);
 // A stand-in engine: reports what it inherited and its own pid as its loop result.
 await writeFile(cli,"import {writeFileSync} from 'node:fs';import path from 'node:path';const dir=process.argv[process.argv.indexOf('--state-dir')+1];writeFileSync(path.join(dir,'loop-result.json'),JSON.stringify({status:'passed',notify:process.env.AGENT_DOCK_NOTIFY??null,pid:process.pid}));\n");
 const result=await spawnChildEngine({cliPath:cli,args:['--state-dir',childState],stateDir:childState,env:{...process.env,AGENT_DOCK_NOTIFY:'{"discord":"https://discord.com/api/webhooks/1/x"}'}});
 assert.equal(result.notify,null,'AGENT_DOCK_NOTIFY is not passed on');
 const record=readChildRecord(childState);
 assert.equal(record.pid,result.pid);assert.equal(record.parentPid,process.pid);assert.ok(record.startedAt&&record.exitedAt);
});

test('the parent\'s Supervisor hears of the task engines\' activity during a round',async t=>{
 const {ws,stateDir,git}=await repo(t);
 let beats=0;
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:10,assess:done(1),
  runChild:async run=>{
   const child=new DashboardState({stateDir:run.stateDir});
   await child.initialize({task:run.task,workspace:run.worktree});
   for(let i=0;i<5;i++){await child.record({type:'cline-running'});await sleep(40);}
   return commitIn(git,run);},
  runCheck:async()=>({exitCode:0,output:''}),onEvent:async()=>{},readControl:async()=>({}),onChildActivity:async()=>{beats++;}});
 assert.equal(result.status,'done');
 assert.ok(beats>=2,`activity reported (${beats})`);
});

test('a merge commit that fails (a refusing pre-commit hook) is rolled back, and the other tasks still merge',async t=>{
 const {ws,stateDir,git}=await repo(t);
 const hook=path.join(ws,'.git','hooks','pre-commit');
 let checks=0,n=0;const events=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  assess:async()=>(++n===1?{status:'task',task:task('A','a.txt')}:n===2?{status:'task',task:task('B','b.txt')}:{status:'done'}),
  runChild:async run=>commitIn(git,run),
  // A's check passes, then a hook refuses its commit; by B's check the hook is gone.
  runCheck:async()=>{if(++checks===1){mkdirSync(path.dirname(hook),{recursive:true});await writeFile(hook,'#!/bin/sh\necho refused by hook >&2\nexit 1\n',{mode:0o755});}else await rm(hook,{force:true});return{exitCode:0,output:''};},
  onEvent:async e=>events.push(e),readControl:async()=>({})});
 assert.equal(result.status,'done');
 assert.deepEqual(git(ws,'log','--format=%s').split('\n'),['QA: B','base']);
 assert.equal(git(ws,'status','--porcelain'),'','nothing of A stays staged');
 const failed=events.find(e=>e.type==='parallel-merge-failed');
 assert.equal(failed.taskId,'A');assert.match(failed.message,/could not be committed/);
 assert.match(git(ws,'branch','--list','agent-dock/*'),/parallel-A-/,'A is kept on its branch');
});

test('when the rollback after a failed check leaves the change, only its own files are restored',async t=>{
 const {ws,stateDir,git}=await repo(t);
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,assess:done(1),
  runChild:async run=>commitIn(git,run),
  // The check edits the file the change added and fails: git reset --merge refuses to drop that edit.
  runCheck:async(command,cwd)=>{await writeFile(path.join(cwd,'a.txt'),'edited by the check\n');await writeFile(path.join(cwd,'base.txt'),'changed by the check\n');await writeFile(path.join(cwd,'report.txt'),'r\n');return{exitCode:1,output:'1 failing test'};},
  onEvent:async()=>{},readControl:async()=>({})});
 assert.equal(result.status,'user-attention');
 assert.match(result.output,/A its check failed/);
 assert.equal(git(ws,'status','--porcelain','--untracked-files=all'),'M base.txt\n?? report.txt','other files are left alone');
 assert.ok(!existsSync(path.join(ws,'a.txt')),'the change itself is gone');
 assert.equal(await readFile(path.join(ws,'base.txt'),'utf8'),'changed by the check\n');
 assert.match(result.output,/base\.txt, report\.txt/);
 assert.equal(git(ws,'log','--format=%s'),'base');
});

test('files a passing check creates or changes are left alone and stop the round',async t=>{
 const {ws,stateDir,git}=await repo(t);
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,assess:done(1),
  runChild:async run=>commitIn(git,run),
  runCheck:async(command,cwd)=>{await writeFile(path.join(cwd,'base.txt'),'changed by the check\n');mkdirSync(path.join(cwd,'coverage'));await writeFile(path.join(cwd,'coverage','lcov.info'),'x\n');return{exitCode:0,output:''};},
  onEvent:async()=>{},readControl:async()=>({})});
 assert.equal(result.status,'user-attention');
 assert.equal(git(ws,'log','-1','--format=%s'),'QA: A');
 assert.match(result.output,/base\.txt/);
 assert.equal(await readFile(path.join(ws,'base.txt'),'utf8'),'changed by the check\n','a file that may be yours is never restored');
 assert.ok(existsSync(path.join(ws,'coverage','lcov.info')),'nor deleted');
 assert.equal(await readFile(path.join(ws,'a.txt'),'utf8'),'A\n','the merged change stays');
});

test('a working tree that cannot be restored after a merge stops for you and merges nothing more',async t=>{
 const {ws,stateDir,git}=await repo(t);
 let n=0;
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  assess:async()=>(++n===1?{status:'task',task:task('A','a.txt')}:n===2?{status:'task',task:task('B','b.txt')}:{status:'done'}),
  runChild:async run=>commitIn(git,run),
  // The check leaves a folder git cannot restore file by file (a nested repository).
  runCheck:async(command,cwd)=>{execFileSync('git',['init','-q',path.join(cwd,'nested')]);await writeFile(path.join(cwd,'nested','x.txt'),'x\n');return{exitCode:0,output:''};},
  onEvent:async()=>{},readControl:async()=>({})});
 assert.equal(result.status,'user-attention');
 assert.match(result.output,/after merging A, the working tree still differs from HEAD in nested\//);
 assert.match(result.output,/Not merged yet: B \(branch agent-dock\/parallel-B-/);
 assert.deepEqual(git(ws,'log','--format=%s').split('\n'),['QA: A','base']);
});

test('tasks set aside at the same time in parallel worktrees each get their own stash entry',async t=>{
 const {ws,stateDir,git}=await repo(t);
 const trees=['A','B','C'].map(id=>{const wt=path.join(path.dirname(ws),'wt-'+id);git(ws,'worktree','add','-q','-b','b-'+id,wt);return{id,wt};});
 for(const {id,wt} of trees){await writeFile(path.join(wt,'base.txt'),'edit '+id+'\n');await writeFile(path.join(wt,'new-'+id+'.txt'),'new '+id+'\n');}
 const entries=await Promise.all(trees.map(({id,wt})=>deferTask({workspace:wt,stateDir:path.join(stateDir,id),task:{id,name:id},reason:'Parallel '+id}).then(r=>r.entry)));
 assert.equal(new Set(entries.map(e=>e.stash.ref)).size,3,'three distinct stash commits');
 for(const [i,{id,wt}] of trees.entries()){
  assert.equal(git(wt,'status','--porcelain','--untracked-files=all'),'',`${id}'s worktree is clean`);
  const ref=entries[i].stash.ref;
  assert.equal(git(ws,'show',`${ref}:base.txt`),'edit '+id,'its own tracked change');
  assert.equal(git(ws,'show',`${ref}^3:new-${id}.txt`),'new '+id,'and its own untracked file');
 }
 const list=git(ws,'stash','list','--format=%H %gs');
 for(const e of entries)assert.ok(list.includes(e.stash.ref),'each is in the stash list');
 // A stash built this way applies as one from git stash push.
 const a=trees[0];git(a.wt,'stash','apply',entries[0].stash.ref);
 assert.equal(await readFile(path.join(a.wt,'new-A.txt'),'utf8'),'new A\n');
 assert.equal(await readFile(path.join(a.wt,'base.txt'),'utf8'),'edit A\n');
});

test('usage a crashed run never counted is counted once at the next round start',async t=>{
 const {ws,stateDir}=await repo(t);
 const left=path.join(stateDir,'parallel','A-old');mkdirSync(left,{recursive:true});
 await writeFile(path.join(left,'child.json'),JSON.stringify({pid:999999,parentPid:1,startedAt:new Date().toISOString(),exitedAt:new Date().toISOString()}));
 await writeFile(path.join(left,'task.json'),JSON.stringify(task('A','a.txt')));
 await writeFile(path.join(left,'run-report.json'),JSON.stringify({usage:{input:10,output:2,calls:1}}));
 // An earlier run's folder without a record is never counted (its usage was counted then).
 const old=path.join(stateDir,'parallel','B-older');mkdirSync(old,{recursive:true});
 await writeFile(path.join(old,'run-report.json'),JSON.stringify({usage:{input:99,output:9,calls:1}}));
 const added=[];
 const run=()=>runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,assess:done(0),runChild:async()=>{throw new Error('must not run');},
  onEvent:async()=>{},readControl:async()=>({}),addUsage:async u=>added.push(u)});
 assert.equal((await run()).status,'done');
 assert.deepEqual(added,[{input:10,cached:0,output:2,costUsd:0,estimatedUsd:0,calls:1}]);
 assert.equal(readChildRecord(left).usageImported,true);
 await run();
 assert.equal(added.length,1,'once');
});

test('a task engine that returns without a result still counts its usage, and only once',async t=>{
 const {ws,stateDir}=await repo(t);
 const added=[];
 await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,assess:done(1),
  runChild:async run=>{writeChildRecord(run.stateDir,{pid:999999,parentPid:process.pid,startedAt:new Date().toISOString(),exitedAt:new Date().toISOString()});return{status:'blocked',output:'The task\'s engine ended without a result.',usage:{input:5,output:1,calls:1}};},
  onEvent:async()=>{},readControl:async()=>({}),addUsage:async u=>added.push(u)});
 assert.deepEqual(added,[{input:5,cached:0,output:1,costUsd:0,estimatedUsd:0,calls:1}]);
 await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,assess:done(0),runChild:async()=>({}),onEvent:async()=>{},readControl:async()=>({}),addUsage:async u=>added.push(u)});
 assert.equal(added.length,1,'not again at the next run');
});

test('task engines a crashed run left at work are stopped before a new round starts',async t=>{
 const {ws,stateDir,git}=await repo(t);
 // Two stand-in engines of a crashed parent: one stops at Stop, one ignores it and is ended.
 const script=path.join(path.dirname(ws),'fake-child.mjs');
 await writeFile(script,"import {readFileSync} from 'node:fs';import path from 'node:path';const [dir,obey]=process.argv.slice(2);setInterval(()=>{let c={};try{c=JSON.parse(readFileSync(path.join(dir,'control.json'),'utf8'));}catch{}if(obey==='1'&&c.stopAfterSafePoint)process.exit(0);},20);\n");
 const kids=[];
 for(const [name,obey] of [['A-old','1'],['B-old','0']]){
  const dir=path.join(stateDir,'parallel',name);mkdirSync(dir,{recursive:true});
  const child=spawn(process.execPath,[script,dir,obey],{stdio:'ignore',windowsHide:true});
  t.after(()=>{try{process.kill(child.pid);}catch{}});
  await writeFile(path.join(dir,'child.json'),JSON.stringify({pid:child.pid,parentPid:999999,startedAt:new Date().toISOString(),exitedAt:null}));
  kids.push({name,dir,child,exited:new Promise(r=>child.on('exit',r))});
 }
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 const order=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,
  assess:async()=>{order.push(kids.map(k=>alive(k.child.pid)));return order.length===1?{status:'task',task:task('C','c.txt')}:{status:'done'};},
  runChild:async run=>commitIn(git,run),runCheck:async()=>({exitCode:0,output:''}),
  onEvent:async e=>order.push(e.type==='parallel-orphans-stopped'?[e.type,e.count,e.folders.sort()]:e.type),readControl:async()=>({}),
  stopOrphans:o=>stopOrphanChildren({...o,waitMs:1500,pollMs:50})});
 assert.equal(result.status,'done');
 assert.deepEqual(order[0],['parallel-orphans-stopped',2,['A-old','B-old']],'found before anything else');
 assert.deepEqual(order[1],[false,false],'both ended before Assessment ran');
 await Promise.all(kids.map(k=>k.exited));
 assert.ok(kids.every(k=>readChildRecord(k.dir).exitedAt),'recorded as ended');
 assert.equal((await readJson(path.join(kids[0].dir,'control.json'))).stopAfterSafePoint,true,'they got Stop first');
 assert.equal(order.filter(e=>Array.isArray(e)&&e[0]==='parallel-orphans-stopped').length,1,'the next round finds none');
});

// ---- One budget for the whole run (Unattended mode too), the combined check through the QA runner, the round's live view.

test('task engines run without budget limits of their own; the run keeps its limits and pricing',()=>{
 const args=childArgs(['--workspace','C:/p','--objective','Build','--parallel','2','--max-rounds','3','--unattended','true','--max-tokens','1000','--max-cost','2','--max-tokens-day','5000','--max-cost-day','9','--max-tasks','4','--max-hours','2','--prices','[]','--limit-retry-minutes','15','--max-elevations','1'],{worktree:'C:/p-parallel/A',stateDir:'C:/s/A',taskFile:'C:/s/A/task.json'});
 for(const flag of ['--max-rounds','--max-tokens','--max-cost','--max-tokens-day','--max-cost-day','--max-tasks','--max-hours','--parallel'])assert.ok(!args.includes(flag),flag+' is the run\'s own');
 const at=flag=>args[args.indexOf(flag)+1];
 assert.equal(at('--unattended'),'true');assert.equal(at('--prices'),'[]');assert.equal(at('--limit-retry-minutes'),'15');assert.equal(at('--max-elevations'),'1');
});

test('a run budget reached mid-round stops every task engine, and each task\'s usage counts once',async t=>{
 const {ws,stateDir}=await repo(t);
 t.after(()=>useRunLimits());
 useRunLimits({unattended:true,maxTokens:1000});
 let stop=false;
 await watchUsage({setControl:async action=>{if(action==='stop')stop=true;},record:async()=>{}},stateDir);
 let assessments=0;const seen=[];
 const usage=(input,output,calls)=>({input,cached:0,output,costUsd:0.25*calls,estimatedUsd:0,calls});
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:10,
  assess:async()=>(++assessments===1?{status:'task',task:task('A','a.txt')}:assessments===2?{status:'task',task:task('B','b.txt')}:{status:'done'}),
  runChild:async({task:{id},stateDir:childState})=>{
   // Each engine records its usage as it works: 600 counted tokens each crosses the run's 1000.
   await writeFile(path.join(childState,'run-usage.json'),JSON.stringify(usage(500,100,2)));
   for(let i=0;i<300;i++){if((await readJson(path.join(childState,'control.json'))).stopAfterSafePoint){seen.push(id);break;}await new Promise(r=>setTimeout(r,10));}
   // Its final report: what it had recorded plus the call that finished after Stop.
   return{status:'stopped',usage:{tokens:700,...usage(580,120,3)}};},
  onEvent:async()=>{},readControl:async()=>({stopAfterSafePoint:stop})});
 assert.equal(result.status,'stopped');
 assert.deepEqual(seen.sort(),['A','B'],'both task engines got Stop');
 assert.equal(RUN.limit?.limit,'tokens');
 assert.deepEqual({...RUN.usage,costUsd:Math.round(RUN.usage.costUsd*100)/100},{input:1160,cached:0,output:240,costUsd:1.5,estimatedUsd:0,calls:6},'live and final usage counted once');
 assert.equal(RUN.day.tokens,1400);
 assert.equal((await readJson(path.join(stateDir,'usage-day.json'))).tokens,1400,'the day total lives in the run\'s state folder only');
});

test('a round limit ends the run between rounds',async t=>{
 const {ws,stateDir,git}=await repo(t);
 let assessments=0;
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:20,maxRounds:1,
  assess:async()=>({status:'task',task:task(`T${++assessments}`,`t${assessments}.txt`)}),
  runChild:async run=>commitIn(git,run),runCheck:async()=>({exitCode:0,output:''}),onEvent:async()=>{},readControl:async()=>({})});
 assert.equal(result.status,'stopped');
 assert.match(result.output,/^Round limit reached: 1 parallel round\./);
 assert.equal(assessments,1);
});

test('the combined check runs through the QA runner: an unapproved command never runs, an approved one gets no secrets',async t=>{
 const {ws,stateDir}=await repo(t);
 const marker=path.join(ws,'ran.txt');
 const refused=await defaultRunCheck(`node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'x')"`,ws,{stateDir});
 assert.equal(refused.exitCode,1);
 assert.match(refused.output,/not an approved project check/);
 assert.equal(existsSync(marker),false);
 await writeFile(path.join(ws,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(process.env.CODEX_QA===\'1\'&&!process.env.AGENT_DOCK_PROVIDER_KEY?0:7)"'}}));
 const before=process.env.AGENT_DOCK_PROVIDER_KEY;process.env.AGENT_DOCK_PROVIDER_KEY='sk-test';
 t.after(()=>{if(before===undefined)delete process.env.AGENT_DOCK_PROVIDER_KEY;else process.env.AGENT_DOCK_PROVIDER_KEY=before;});
 const passed=await defaultRunCheck('npm test',ws,{stateDir});
 assert.equal(passed.exitCode,0,passed.output);
 assert.equal(typeof passed.output,'string');
});

test('parallel-round.json follows the round: each task, its folder and branch, and how it ended',async t=>{
 const {ws,stateDir,git}=await repo(t);
 let assessments=0;const during=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  assess:async()=>(++assessments===1?{status:'task',task:task('A','a.txt')}:assessments===2?{status:'task',task:task('B','b.txt')}:{status:'done'}),
  runChild:async run=>{
   if(run.task.id==='B'){for(let i=0;i<300;i++){const r=await readJson(path.join(stateDir,'parallel-round.json'));if(r.tasks?.every(x=>x.status==='running')){during.push(r);break;}await new Promise(r=>setTimeout(r,10));}return{status:'user-attention',output:'QA failed'};}
   for(let i=0;i<300&&!during.length;i++)await new Promise(r=>setTimeout(r,10));
   return commitIn(git,run);},
  runCheck:async()=>({exitCode:0,output:''}),onEvent:async()=>{},readControl:async()=>({})});
 assert.equal(result.status,'done');
 assert.equal(during.length,1,'both tasks showed as running at once');
 assert.equal(during[0].round,1);assert.equal(during[0].endedAt,null);
 for(const t of during[0].tasks){assert.ok(existsSync(path.join(stateDir,'parallel',t.folder)),'its state folder');assert.match(t.branch,/^agent-dock\/parallel-/);assert.ok(t.startedAt);}
 const last=await readJson(path.join(stateDir,'parallel-round.json'));
 assert.ok(last.endedAt,'the round is marked ended');
 assert.deepEqual(last.tasks.map(x=>[x.id,x.status]),[['A','merged'],['B','failed']]);
});
