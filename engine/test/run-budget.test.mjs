import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RUN,parseRunLimits,useRunLimits,elevationAllowed,trackRunEvent,startDeadline,writeRunReport,watchUsage,recordUsage,claudeUsage,codexUsage,openCodeUsage} from '../src/run-budget.mjs';

const fakeState=()=>{const s={controls:[],events:[],setControl:async a=>{s.controls.push(a);},record:async e=>{s.events.push(e);}};return s;};

test('run limits are parsed and validated; nothing is limited by default',()=>{
 assert.deepEqual(parseRunLimits({}),{unattended:false,maxTasks:0,maxHours:0,maxElevations:0});
 assert.deepEqual(parseRunLimits({unattended:'true','max-tasks':'5','max-hours':'1.5','max-elevations':'2'}),{unattended:true,maxTasks:5,maxHours:1.5,maxElevations:2});
 assert.throws(()=>parseRunLimits({'max-tasks':'1.5'}),/whole number/);
 assert.throws(()=>parseRunLimits({unattended:'yes'}),/true or false/);
});

test('the task limit asks for Stop once, after the approved task, and the Elevation limit ends automatic Elevation',async t=>{
 t.after(()=>useRunLimits());
 useRunLimits({unattended:true,maxTasks:2,maxElevations:1});
 const state=fakeState();
 await trackRunEvent(state,{type:'qa-pass'});
 assert.deepEqual(state.controls,[]);
 assert.equal(elevationAllowed(),true);
 await trackRunEvent(state,{type:'sol-reassessment-started'});
 assert.equal(elevationAllowed(),false);
 await trackRunEvent(state,{type:'qa-pass'});
 await trackRunEvent(state,{type:'qa-pass'});
 assert.deepEqual(state.controls,['stop'],'Stop is requested once');
 assert.deepEqual(state.events.map(e=>[e.type,e.limit]),[['run-limit','tasks']]);
 assert.equal(RUN.limit.limit,'tasks');
});

test('the time limit asks for Stop when it passes',async t=>{
 t.after(()=>useRunLimits());
 useRunLimits({unattended:true,maxHours:0.000001});
 const state=fakeState();
 const timer=startDeadline(state);
 await new Promise(r=>setTimeout(r,60));
 clearTimeout(timer);
 assert.deepEqual(state.controls,['stop']);
 assert.equal(state.events[0].limit,'hours');
 assert.equal(startDeadline(fakeState())===null,false,'still armed while a limit is set');
 useRunLimits();
 assert.equal(startDeadline(fakeState()),null,'no time limit, no timer');
});

test('the run report says how the run went and which limit ended it',async t=>{
 t.after(()=>useRunLimits());
 const dir=await mkdtemp(path.join(os.tmpdir(),'run-report-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 useRunLimits({unattended:true,maxTasks:1});
 const state=fakeState();
 await trackRunEvent(state,{type:'retry'});await trackRunEvent(state,{type:'qa-pass'});
 const report=await writeRunReport(dir,{status:'stopped'});
 assert.deepEqual([report.status,report.limit,report.tasksApproved,report.corrections],['stopped','tasks',1,1]);
 const md=await readFile(path.join(dir,'run-report.md'),'utf8');
 assert.match(md,/Mode: Unattended/);assert.match(md,/Why it ended: Task limit reached/);
 assert.equal(JSON.parse(await readFile(path.join(dir,'run-report.json'),'utf8')).tasksApproved,1);
});

test('token usage is read from Claude, Codex and OpenCode output',()=>{
 const claude=JSON.stringify({type:'result',result:'{}',usage:{input_tokens:10,cache_read_input_tokens:100,cache_creation_input_tokens:5,output_tokens:20},total_cost_usd:0.25});
 assert.deepEqual(claudeUsage('noise\n'+claude),{input:115,cached:100,output:20,costUsd:0.25},'cache writes are new input; only cache reads are cached');
 assert.equal(claudeUsage('not json'),null);
 const codex=[JSON.stringify({type:'thread.started'}),JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,cached_input_tokens:600,output_tokens:50,reasoning_output_tokens:30}}),JSON.stringify({type:'turn.completed',usage:{input_tokens:200,output_tokens:10}})].join('\n');
 assert.deepEqual(codexUsage(codex),{input:1200,cached:600,output:90,costUsd:0});
 assert.equal(codexUsage('{"type":"item.completed"}'),null);
 assert.deepEqual(openCodeUsage([{type:'text'},{type:'step_finish',part:{cost:0.01,tokens:{input:40,output:8,reasoning:2,cache:{read:60,write:0}}}}]),{input:100,cached:60,output:10,costUsd:0.01});
 assert.equal(openCodeUsage([]),null);
});

test('token and spend budgets ask for Stop, and the day total carries over between runs',async t=>{
 t.after(()=>useRunLimits());
 const dir=await mkdtemp(path.join(os.tmpdir(),'run-usage-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 assert.deepEqual(parseRunLimits({'max-tokens':'5000','max-cost':'2.5'}),{unattended:false,maxTasks:0,maxHours:0,maxElevations:0,maxTokens:5000,maxCost:2.5});
 assert.throws(()=>parseRunLimits({'max-tokens':'-1'}),/at least 0/);
 useRunLimits({unattended:true,maxTokens:1000});
 const state=fakeState();
 await watchUsage(state,dir);
 await recordUsage({input:600,output:100});
 assert.deepEqual(state.controls,[]);
 await recordUsage({input:5000,cached:5000,output:0});
 assert.deepEqual(state.controls,[],'tokens read from a prompt cache do not count toward the budget');
 await recordUsage({input:250,cached:200,output:260});
 assert.deepEqual(state.controls,['stop']);
 assert.match(state.events[0].message,/Token budget reached: 1,010 of 1,000 tokens/);
 const day=JSON.parse(await readFile(path.join(dir,'usage-day.json'),'utf8'));
 assert.equal(day.tokens,1010);
 const report=await writeRunReport(dir,{status:'stopped'});
 assert.deepEqual([report.limit,report.usage.tokens,report.usage.cached,report.usage.calls],['tokens',1010,5200,3]);
 // A later run the same day starts from today's total for the daily budget.
 useRunLimits({unattended:true,maxCostDay:1});
 const next=fakeState();
 await watchUsage(next,dir);
 assert.equal(RUN.day.tokens,1010);
 await recordUsage({input:10,costUsd:0.6});await recordUsage({input:10,costUsd:0.5});
 assert.deepEqual(next.events.map(e=>e.limit),['cost-day']);
 assert.match(next.events[0].message,/\$1\.10 of \$1\.00 today/);
});
