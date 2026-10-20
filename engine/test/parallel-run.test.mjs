import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {childArgs,runParallel,worktreeFor} from '../src/parallel-run.mjs';

async function repo(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'parallel-'));
 const ws=path.join(root,'proj'),stateDir=path.join(root,'state');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
 execFileSync('git',['init','-q',ws]);git(ws,'config','user.email','t@example.com');git(ws,'config','user.name','T');git(ws,'config','core.autocrlf','false');
 await writeFile(path.join(ws,'base.txt'),'base\n');git(ws,'add','.');git(ws,'commit','-qm','base');
 return {ws,stateDir,git};
}
const task=(id,file,extra={})=>({id,name:'Task '+id,prompt:'Task skill: implement\n'+id,allowedPaths:[file],qaCommand:'npm test',...extra});

test('child engines get the parent arguments for one task in its worktree',()=>{
 const args=childArgs(['--workspace','C:/p','--objective','Build','--parallel','3','--auto-continue','false','--task','old.json'],{worktree:'C:/p-parallel/A',stateDir:'C:/s/A',taskFile:'C:/s/A/task.json'});
 assert.deepEqual(args,['--objective','Build','--workspace','C:/p-parallel/A','--state-dir','C:/s/A','--task','C:/s/A/task.json','--single-task','true','--auto-continue','true']);
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
  runChild:async({task,worktree})=>{
   running++;peak=Math.max(peak,running);await new Promise(r=>setTimeout(r,50));running--;
   await writeFile(path.join(worktree,task.allowedPaths[0]),task.id+'\n');
   git(worktree,'add','.');git(worktree,'commit','-qm','QA: '+task.id);
   return{status:'passed',commit:git(worktree,'rev-parse','HEAD')};
  },
  runCheck:async(command,cwd)=>({exitCode:existsSync(path.join(cwd,'b.txt'))&&!existsSync(path.join(cwd,'a.txt'))?1:0,output:'b needs a'}),
  onEvent:async e=>events.push(e),readControl:async()=>({})});
 assert.equal(result.status,'done');
 assert.equal(peak,2,'both tasks ran at the same time');
 assert.match(objectives[1],/Already running in parallel this round: A "Task A" \(files: a\.txt\)/);
 assert.deepEqual(git(ws,'log','--format=%s').split('\n'),['QA: B','QA: A','base'],'each approved commit lands on the branch with its own message');
 assert.equal(git(ws,'status','--porcelain'),'');
 assert.deepEqual(events.filter(e=>e.type==='qa-pass').map(e=>[e.taskId,e.planItems]),[['A',['Add a']],['B',undefined]]);
 assert.ok(!existsSync(worktreeFor(ws,'A-1')),'merged worktrees are removed');
 assert.equal(git(ws,'branch','--list','agent-dock/*'),'','and their branches');
});

test('a change whose check fails on the combined code is not committed and stays on its branch',async t=>{
 const {ws,stateDir,git}=await repo(t);
 let assessments=0;const events=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:2,pollMs:20,
  assess:async()=>(++assessments===1?{status:'task',task:task('A','a.txt')}:assessments===2?{status:'task',task:task('B','b.txt')}:{status:'done'}),
  runChild:async({task,worktree})=>{
   if(task.id==='B')return{status:'user-attention',output:'QA failed'};
   await writeFile(path.join(worktree,'a.txt'),'A\n');git(worktree,'add','.');git(worktree,'commit','-qm','QA: A');
   return{status:'passed',commit:git(worktree,'rev-parse','HEAD')};
  },
  runCheck:async()=>({exitCode:1,output:'1 failing test'}),
  onEvent:async e=>events.push(e),readControl:async()=>({})});
 assert.equal(result.status,'user-attention');
 assert.match(result.output,/A its check failed on the combined code: 1 failing test; kept on branch agent-dock\/parallel-A-/);
 assert.match(result.output,/B: user-attention \(QA failed\); its worktree stays at/);
 assert.equal(git(ws,'log','--format=%s'),'base','nothing was committed');
 assert.equal(git(ws,'status','--porcelain'),'','and the tree is clean');
 assert.ok(existsSync(worktreeFor(ws,'B-1')),'an unfinished task keeps its worktree');
 assert.match(git(ws,'branch','--list','agent-dock/*'),/parallel-A-/);
 assert.ok(events.some(e=>e.type==='parallel-merge-failed'&&e.taskId==='A'));
});

test('Stop reaches the running task engines and ends the run',async t=>{
 const {ws,stateDir}=await repo(t);
 let stop=false;const seen=[];
 const result=await runParallel({workspace:ws,stateDir,objective:'Build it',lanes:1,pollMs:10,
  assess:async()=>({status:'task',task:task('A','a.txt')}),
  runChild:async({stateDir:childState})=>{stop=true;
   for(let i=0;i<100;i++){const control=JSON.parse(await readFile(path.join(childState,'control.json'),'utf8').catch(()=>'{}'));if(control.stopAfterSafePoint){seen.push('child stopped');break;}await new Promise(r=>setTimeout(r,10));}
   return{status:'stopped'};},
  onEvent:async()=>{},readControl:async()=>({stopAfterSafePoint:stop})});
 assert.deepEqual(seen,['child stopped']);
 assert.equal(result.status,'stopped');
});
