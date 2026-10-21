import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {childArgs,endStepDown,forwardControl,freeWorktree,runParallel,worktreeFor} from '../src/parallel-run.mjs';
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
 assert.deepEqual(args,['--objective','Build','--workspace','C:/p-parallel/A','--state-dir','C:/s/A','--task','C:/s/A/task.json','--single-task','true','--auto-continue','true','--step-down','false']);
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
  ['--objective','B','--task-mode','eco','--task-max-files','1','--task-max-new-lines','200','--task-max-read-files','3','--workspace','W','--state-dir','S','--task','T','--single-task','true','--auto-continue','true','--step-down','false']);
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
