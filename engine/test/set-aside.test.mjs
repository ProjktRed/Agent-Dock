import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {forgetDeferredStash,readDeferred,setAsideTask,undeferTasks} from '../src/defer-task.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';

// Found in a live run: a blocked task with no Retry QA, Resolver or Retry Assessment left nothing to press.
test('you can set a blocked task aside: work stashed, task deferred, state archived for a fresh Assessment',async t=>{
 const ws=await mkdtemp(path.join(os.tmpdir(),'aside-ws-')),stateDir=await mkdtemp(path.join(os.tmpdir(),'aside-state-'));
 t.after(()=>Promise.all([rm(ws,{recursive:true,force:true}),rm(stateDir,{recursive:true,force:true})]));
 const git=(...args)=>execFileSync('git',args,{cwd:ws,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','t@example.com');git('config','user.name','T');git('config','core.autocrlf','false');
 await writeFile(path.join(ws,'a.js'),'1\n');git('add','.');git('commit','-qm','base');const head=git('rev-parse','HEAD');
 const task={id:'title-case-tests',name:'Add titleCase tests',prompt:'p',allowedPaths:['test/t.js'],qaCommand:'node --test x'};
 await writeFile(path.join(stateDir,'current-task.json'),JSON.stringify({...task,automation:{recovery:{version:1,baselineSha:head,phase:'blocked'}}}));
 await writeFile(path.join(stateDir,'pending-codex.json'),'{}');
 await writeFile(path.join(ws,'new.test.js'),'work\n');
 const state=new DashboardState({stateDir});await state.initialize({task,workspace:ws});await state.record({type:'blocked',qa:'QA command is not an approved project check'});
 const entry=await setAsideTask({workspace:ws,stateDir,state});
 assert.equal(entry.id,'title-case-tests');assert.match(entry.stash.message,/Agent Dock: deferred title-case-tests - Set aside by you/);
 assert.equal(git('status','--porcelain'),'','the tree is clean again');
 git('stash','apply');assert.equal(await readFile(path.join(ws,'new.test.js'),'utf8'),'work\n','nothing was lost');
 await assert.rejects(access(path.join(stateDir,'current-task.json')));await assert.rejects(access(path.join(stateDir,'pending-codex.json')));
 assert.equal((await readdir(path.join(stateDir,'set-aside'))).length,1);
 assert.deepEqual(JSON.parse(await readFile(path.join(stateDir,'deferred-tasks.json'),'utf8')).map(d=>d.id),['title-case-tests']);
 const live=await state.readLive();assert.equal(live.stage,'waiting');assert.equal(live.blockedReason,null);
 await assert.rejects(setAsideTask({workspace:ws,stateDir}),/no current task/);
});

test('setting aside refuses when HEAD moved from the task baseline',async t=>{
 const ws=await mkdtemp(path.join(os.tmpdir(),'aside-ws-')),stateDir=await mkdtemp(path.join(os.tmpdir(),'aside-state-'));
 t.after(()=>Promise.all([rm(ws,{recursive:true,force:true}),rm(stateDir,{recursive:true,force:true})]));
 const git=(...args)=>execFileSync('git',args,{cwd:ws,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','t@example.com');git('config','user.name','T');
 await writeFile(path.join(ws,'a.js'),'1\n');git('add','.');git('commit','-qm','base');const head=git('rev-parse','HEAD');
 await writeFile(path.join(ws,'a.js'),'2\n');git('commit','-qam','moved');
 await writeFile(path.join(stateDir,'current-task.json'),JSON.stringify({id:'T',automation:{recovery:{baselineSha:head}}}));
 await assert.rejects(setAsideTask({workspace:ws,stateDir}),/HEAD moved/);
 await access(path.join(stateDir,'current-task.json'));
});

// 0.39: the Task board removes the deferred mark; Overview's Pop clears the stash a set-aside task pointed at.
test('removing the deferred mark keeps the stash; a popped stash is forgotten by its tasks',async t=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'undefer-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const list=[{id:'a',name:'A',stash:{ref:'111',message:'Agent Dock: deferred a'}},{id:'b',name:'B',stash:{ref:'222',message:'Agent Dock: deferred b'}},{id:'c',name:'C',stash:null}];
 await writeFile(path.join(stateDir,'deferred-tasks.json'),JSON.stringify(list));
 const removed=await undeferTasks(stateDir,['a','missing']);
 assert.deepEqual(removed.map(d=>d.id),['a']);
 assert.deepEqual((await readDeferred(stateDir)).map(d=>d.id),['b','c']);
 assert.deepEqual(await undeferTasks(stateDir,['a']),[],'nothing left to remove');
 await forgetDeferredStash(stateDir,'222');
 assert.deepEqual((await readDeferred(stateDir)).map(d=>d.stash),[null,null]);
 await forgetDeferredStash(stateDir,'999');
 assert.equal((await readDeferred(stateDir)).length,2);
});

// 0.39: a start given --task files what happens before the task loads (a dirty workspace) under that task.
test('showTask names the attached task in live state without an event',async t=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'show-task-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const state=new DashboardState({stateDir});await state.initialize({task:{id:'old',name:'Old',prompt:'p'},workspace:stateDir});
 const before=(await state.readEvents()).length;
 await state.showTask({id:'rust-again-x',name:'Rust (again)',prompt:'p'});
 assert.equal((await state.readLive()).task.id,'rust-again-x');
 assert.equal((await state.readEvents()).length,before,'no event');
 await state.record({type:'blocked',qa:'QA requires a clean git workspace before Cline starts.'});
 assert.equal((await state.readEvents()).at(-1).taskId,'rust-again-x');
});
