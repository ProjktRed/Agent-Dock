import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {interruptedQaCommit} from '../src/interrupted-qa.mjs';
import {runCheckCommand} from '../src/qa-runner.mjs';
import {runNodeLoop} from '../src/node-loop.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';

async function repo(t){
 const ws=await mkdtemp(path.join(os.tmpdir(),'iqa-ws-'));t.after(()=>rm(ws,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:ws,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','t@example.com');git('config','user.name','T');git('config','core.autocrlf','false');git('config','commit.gpgsign','false');
 await writeFile(path.join(ws,'a.js'),'1\n');await writeFile(path.join(ws,'b.js'),'1\n');git('add','.');git('commit','-qm','base');
 return {ws,git,base:git('rev-parse','HEAD')};
}
const task={id:'T',name:'T',prompt:'Task skill: implement\nT',allowedPaths:['a.js'],qaCommand:'node --version'};

test('a commit QA made before it was killed is accepted only if the engine can verify it',async t=>{
 const {ws,git,base}=await repo(t);
 assert.equal(await interruptedQaCommit({workspace:ws,task,baselineSha:base}),null,'no new commit');
 await writeFile(path.join(ws,'a.js'),'2\n');git('commit','-qam','QA commit');
 const ok=await interruptedQaCommit({workspace:ws,task,baselineSha:base});
 assert.equal(ok.status,'pass');assert.equal(ok.commit,git('rev-parse','HEAD'));assert.match(ok.output,/interrupted after it committed/);
 assert.equal(await interruptedQaCommit({workspace:ws,task:{...task,qaCommand:'node -e "process.exit(3)"'},baselineSha:base}),null,'the check must pass');
 await writeFile(path.join(ws,'a.js'),'dirty\n');
 assert.equal(await interruptedQaCommit({workspace:ws,task,baselineSha:base}),null,'the tree must be clean');
 git('checkout','--','a.js');
 await writeFile(path.join(ws,'b.js'),'2\n');git('commit','-qam','second');
 assert.equal(await interruptedQaCommit({workspace:ws,task,baselineSha:base}),null,'exactly one commit on the baseline');
 git('reset','-q','--hard',base);await writeFile(path.join(ws,'b.js'),'3\n');git('commit','-qam','outside');
 assert.equal(await interruptedQaCommit({workspace:ws,task,baselineSha:base}),null,'only the task paths');
});

test('the loop resumes a QA killed after its commit as an approved task, without running QA again',async t=>{
 const {ws,git,base}=await repo(t);
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'iqa-state-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const state=new DashboardState({stateDir});await state.initialize({task,workspace:ws});
 const packet=({attempt})=>({task,baselineSha:base,attempt,diff:{text:'d',bytes:1},changedFiles:['a.js'],clineSummary:{exitCode:0,text:'x'},qaEvidence:{command:{command:task.qaCommand,exitCode:0},categories:{tests:'PASS',scopeCheck:'PASS'}}});
 const common={workspace:ws,stateDir,objective:'Build',codex:{activeCount:0,assertIdle:async()=>{},resolveBlocked:async()=>assert.fail('must not block')},
  worker:{withExclusive:fn=>fn(),run:async(prompt,hooks)=>{await hooks.onStart({pid:1});await writeFile(path.join(ws,'a.js'),'2\n');return{exitCode:0};}},
  verify:async()=>{},prepareQa:async input=>packet(input),readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:1,
  elevate:async()=>assert.fail('no elevation'),assessCorrection:async()=>assert.fail('no correction')};
 let assessments=0;
 // First run: QA commits, then the engine dies before QA reports (the call never returns, like a killed process).
 void runNodeLoop({...common,baseline:async()=>({head:base}),
  assess:async()=>(++assessments===1?{status:'task',task}:{status:'done'}),
  review:async()=>{git('commit','-qam','QA: add a');await new Promise(()=>{});}});
 for(let i=0;i<200&&git('rev-parse','HEAD')===base;i++)await new Promise(r=>setTimeout(r,25));
 const committed=git('rev-parse','HEAD');assert.notEqual(committed,base);
 // Resume: QA must not run again; the engine verifies the commit and moves on.
 const result=await runNodeLoop({...common,baseline:async()=>({head:git('rev-parse','HEAD')}),
  assess:async()=>({status:'done'}),review:async()=>assert.fail('QA must not run again')});
 assert.equal(result.status,'done');
 const events=await state.readEvents(200);
 assert.ok(events.some(e=>e.type==='qa-commit-recovered'));
 assert.ok(events.some(e=>e.type==='qa-pass'));
 assert.equal(git('rev-parse','HEAD'),committed);
});

test('the recovered commit is checked only with an approved check command',async t=>{
 const {ws,git,base}=await repo(t);
 await writeFile(path.join(ws,'a.js'),'2\n');git('commit','-qam','QA commit');
 const marker=path.join(ws,'ran.txt');
 const other={...task,qaCommand:`node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'x')"`};
 assert.equal(await interruptedQaCommit({workspace:ws,task:other,baselineSha:base}),null);
 assert.equal(existsSync(marker),false,'an unapproved command never runs');
 await assert.rejects(runCheckCommand('node -e "process.exit(0)"',ws),/not an approved project check/);
});
