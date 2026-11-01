import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {checkScripts,missingTools} from '../src/tool-check.mjs';
import {runNodeLoop} from '../src/node-loop.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';

// Smoke run (0.39.0): a Rust task without cargo installed went through QA three times, two corrections and the
// Resolver before anyone learned the toolchain was missing.
async function workspace(t,scripts){
 const ws=await mkdtemp(path.join(os.tmpdir(),'tools-ws-'));t.after(()=>rm(ws,{recursive:true,force:true}));
 await writeFile(path.join(ws,'package.json'),JSON.stringify({scripts}));
 return ws;
}

test('the tools a check needs come from the command and the npm scripts it runs',async t=>{
 const ws=await workspace(t,{'test:rust':'cargo test --workspace','test':'npm run lint && go test ./...',lint:'python3 tools/lint.py','pretest':'node x.js'});
 assert.deepEqual(await checkScripts(ws,'npm run test:rust'),['npm run test:rust','cargo test --workspace']);
 assert.deepEqual(await checkScripts(ws,'npm test'),['npm test','node x.js','npm run lint && go test ./...','python3 tools/lint.py']);
});

test('a tool not on PATH is reported once per toolchain, with an install suggestion; a fresh PATH counts',async t=>{
 const ws=await workspace(t,{'test:rust':'cargo test && rustc --version',check:'deno test'});
 const bin=await mkdtemp(path.join(os.tmpdir(),'tools-bin-'));t.after(()=>rm(bin,{recursive:true,force:true}));
 const saved=process.env.PATH;t.after(()=>{process.env.PATH=saved;});
 process.env.PATH=bin;
 const missing=await missingTools({workspace:ws,command:'npm run test:rust',platform:'win32',refresh:async p=>p});
 assert.deepEqual(missing.map(m=>m.name),['Rust (cargo)']);
 assert.match(missing[0].install,/^winget install --id Rustlang\.Rustup -e/);
 assert.equal((await missingTools({workspace:ws,command:'npm run test:rust',platform:'linux',refresh:async p=>p}))[0].install.includes('rustup.rs'),true);
 // Installed meanwhile: the refreshed PATH (as a new terminal would see it) has the tool.
 const cargoDir=path.join(bin,'cargo-bin');await mkdir(cargoDir);
 for(const name of ['cargo','rustc'])await writeFile(path.join(cargoDir,process.platform==='win32'?`${name}.exe`:name),'');
 assert.deepEqual(await missingTools({workspace:ws,command:'npm run test:rust',platform:process.platform,refresh:async p=>`${p}${path.delimiter}${cargoDir}`}),[]);
 assert.equal(process.env.PATH.includes(cargoDir),true,'the run keeps the refreshed PATH for its checks');
 assert.deepEqual(await missingTools({workspace:ws,command:'npm test',refresh:async p=>p}),[],'no known toolchain: nothing to check');
});

test('the task waits before Implementation while a tool is missing, then continues; Set aside defers it untouched',async t=>{
 for(const answer of ['installed','reject']){
  const ws=await mkdtemp(path.join(os.tmpdir(),'tools-loop-')),stateDir=await mkdtemp(path.join(os.tmpdir(),'tools-state-'));
  t.after(()=>Promise.all([rm(ws,{recursive:true,force:true}),rm(stateDir,{recursive:true,force:true})]));
  const git=(...args)=>execFileSync('git',args,{cwd:ws,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.email','t@example.com');git('config','user.name','T');
  await writeFile(path.join(ws,'a.js'),'1\n');git('add','.');git('commit','-qm','base');
  const state=new DashboardState({stateDir});await state.initialize({task:{id:'boot',prompt:'x'},workspace:ws});
  let installed=false,worker=0,checks=0,assessed=0;
  const task={id:'T1',name:'Rust crate',prompt:'Task skill: implement\nx',allowedPaths:['a.js'],qaCommand:'npm test'};
  const timer=setInterval(async()=>{
   if(!(await state.readEvents(50)).some(e=>e.type==='tools-missing'))return;
   clearInterval(timer);
   if(answer==='installed')installed=true;else await state.setControl('reject-task',{source:'app',reason:'T1'});
  },5);t.after(()=>clearInterval(timer));
  await runNodeLoop({workspace:ws,stateDir,objective:'Build',codex:{activeCount:0,assertIdle:async()=>{},resolveBlocked:async()=>({status:'blocked'})},
   assess:async()=>(++assessed===1?{status:'task',task}:{status:'done'}),
   missingTools:async()=>{checks++;return installed?[]:[{tool:'cargo',name:'Rust (cargo)',install:'winget install --id Rustlang.Rustup -e --source winget',url:'https://rustup.rs',note:null}];},toolPollMs:5,
   worker:{withExclusive:fn=>fn(),run:async()=>{worker++;throw new Error('stop here');}},
   baseline:async()=>({head:git('rev-parse','HEAD')}),readControl:()=>state.readControl(),onEvent:e=>state.record(e),pollMs:1}).catch(()=>null);
  const events=await state.readEvents(80);
  assert.equal(events.filter(e=>e.type==='tools-missing').length,1,'asked once, however long it waits');
  assert.equal(events.find(e=>e.type==='tools-missing').tools[0].name,'Rust (cargo)');
  if(answer==='installed'){assert.ok(worker>=1,'Implementation ran once the tool appeared');assert.ok(events.some(e=>e.type==='tools-ready'));}
  else{assert.equal(worker,0,'Implementation never ran');assert.match(events.find(e=>e.type==='task-deferred').reason,/Rust \(cargo\) not installed/);}
  if(answer==='installed')assert.ok(checks>=2,'checked again until it was found');
 }
});
