import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SUPERVISOR,digest,failureSignature,parseSupervisorOptions,startSupervisor,superviseEvent,superviseTask,supervisorAlerts} from '../src/supervisor.mjs';
import {checkChannelUrl,flushNotifications,notify,notifyEvent,useNotify} from '../src/notify.mjs';
import {recordUsage,useRunLimits} from '../src/run-budget.mjs';

const fakeState=(live={})=>{const s={live,controls:[],events:[],setControl:async(a,o)=>{s.controls.push([a,o?.source]);},record:async e=>{s.events.push(e);},readLive:async()=>s.live};return s;};
const alerts=s=>s.events.filter(e=>e.type==='supervisor-alert').map(e=>[e.monitor,e.action??null]);

test('options: modes and thresholds are validated; 0 turns a monitor off',()=>{
 assert.equal(parseSupervisorOptions({}).mode,'alert');
 assert.deepEqual((({mode,stallMinutes,tokensPerTask})=>({mode,stallMinutes,tokensPerTask}))(parseSupervisorOptions({supervisor:'pause','sv-stall-minutes':'12.5','sv-tokens-per-task':'2000000'})),{mode:'pause',stallMinutes:12.5,tokensPerTask:2000000});
 assert.throws(()=>parseSupervisorOptions({supervisor:'edit-code'}),/off, alert, pause or stop/);
 assert.throws(()=>parseSupervisorOptions({'sv-refusals':'-2'}),/at least 0/);
});

test('the same QA failure repeated alerts, and in pause mode asks for Pause; different failures do not',async t=>{
 const state=fakeState({task:{id:'T1'}});
 const stop=startSupervisor(state,{config:{mode:'pause',repeatFailures:3,planDrift:0}});t.after(stop);
 assert.equal(failureSignature('Expected 3 tests\nat line 42'),failureSignature('Expected 7 tests\nat line 99'));
 await superviseEvent({type:'retry',qa:'Lint failed: 4 errors'});
 await superviseEvent({type:'retry',qa:'Type error in a.ts'});
 await superviseEvent({type:'retry',qa:'Lint failed: 2 errors'});
 assert.deepEqual(alerts(state),[]);
 await superviseEvent({type:'retry',qa:'Lint failed: 9 errors'});
 assert.deepEqual(alerts(state),[]);
 await superviseEvent({type:'qa-fail',qa:'Lint failed: 1 errors'});
 assert.deepEqual(alerts(state),[['repeat failure','pause']]);
 assert.deepEqual(state.controls,[['pause','supervisor']]);
});

test('guard refusal spikes alert, then act at twice the threshold; alert mode never acts',async t=>{
 const state=fakeState();
 const stop=startSupervisor(state,{config:{mode:'alert',refusals:2}});t.after(stop);
 for(let i=0;i<4;i++)await superviseEvent({type:'implementation-scope-blocked',tool:'Write',reason:'outside allowed paths'});
 await superviseEvent({type:'cline-tool-failed',message:'file not found'});
 assert.deepEqual(alerts(state),[['guard refusals',null],['guard refusals',null]]);
 assert.deepEqual(state.controls,[]);
});

test('Assessment tokens count toward the task it chooses, and the alert names Assessment',async t=>{
 useRunLimits();t.after(()=>useRunLimits());
 const state=fakeState({task:{id:'assessment'}});
 const stop=startSupervisor(state,{config:{mode:'alert',tokensPerTask:1000}});t.after(stop);
 await recordUsage({input:1200});await superviseEvent({type:'codex-finished'});
 assert.ok(state.events.at(-1).message.startsWith('Assessment (choosing the next task) has used 1,200 tokens'));
 await recordUsage({input:500});await superviseEvent({type:'cline-started',taskId:'T1'});
 assert.equal(state.events.filter(e=>e.type==='supervisor-alert').length,1,'no second first-threshold alert for the same work');
 await recordUsage({input:500});await superviseEvent({type:'cline-finished',taskId:'T1'});
 assert.match(state.events.at(-1).message,/^T1 has used 2,200 tokens, twice/);
});

test('burn rate per task, scope creep and plan drift',async t=>{
 const ws=await mkdtemp(path.join(os.tmpdir(),'supervisor-'));t.after(()=>rm(ws,{recursive:true,force:true}));
 await writeFile(path.join(ws,'IMPLEMENTATION_PLAN.md'),'## Phase 1 — Core\n- [x] one\n- [ ] two\n');
 useRunLimits();t.after(()=>useRunLimits());
 const state=fakeState({task:{id:'T2'}});
 const stop=startSupervisor(state,{workspace:ws,stateDir:ws,config:{mode:'stop',tokensPerTask:1000,planDrift:2}});t.after(stop);
 await recordUsage({input:900,output:200});await superviseEvent({type:'cline-message'});
 await recordUsage({input:1000});await superviseEvent({type:'cline-message'});
 assert.deepEqual(alerts(state),[['burn rate',null],['burn rate','stop']]);
 await superviseTask({id:'T3',allowedPaths:['src/**']});
 await superviseTask({id:'T4',allowedPaths:Array.from({length:30},(_,i)=>`f${i}.js`)});
 await superviseTask({id:'T5',allowedPaths:['src/a.js','test/a.test.js']});
 assert.deepEqual(alerts(state).slice(2),[['scope creep',null],['scope creep',null]]);
 for(let i=0;i<3;i++)await superviseEvent({type:'qa-pass'});
 assert.deepEqual(alerts(state).at(-1),['plan drift',null]);
 const text=await digest('final');
 assert.match(text,/Plan 1\/2 \(50%\)/);assert.match(text,/Supervisor alerts: 5/);
 assert.match(await readFile(path.join(ws,'supervisor-digest.md'),'utf8'),/plan drift/);
 assert.equal(supervisorAlerts().length,5);
});

test('stall: alerts after the quiet period, not while waiting for you; off mode watches nothing',async t=>{
 let clock=0;const state=fakeState({stage:'running'});
 const stop=startSupervisor(state,{config:{mode:'alert',stallMinutes:30},now:()=>clock});t.after(stop);
 // tick is internal; drive it through the interval by calling the module's timer logic indirectly:
 const {tickForTest}=await import('../src/supervisor.mjs');
 clock=29*60_000;await tickForTest();assert.deepEqual(alerts(state),[]);
 clock=31*60_000;await tickForTest();assert.deepEqual(alerts(state),[['stall',null]]);
 state.live={stage:'paused'};clock=200*60_000;await tickForTest();
 assert.equal(alerts(state).length,1,'paused is not a stall');
 const quiet=fakeState();const off=startSupervisor(quiet,{config:{mode:'off'}});off();
 await superviseEvent({type:'retry',qa:'x'});assert.deepEqual(quiet.events,[]);
 assert.equal(SUPERVISOR.mode,'off');
});

test('stall: a parallel round\'s task engines at work are activity of the run, not a stall',async t=>{
 let clock=0;const state=fakeState({stage:'waiting'});
 const stop=startSupervisor(state,{config:{mode:'alert',stallMinutes:30},now:()=>clock});t.after(stop);
 const {noteActivity,tickForTest}=await import('../src/supervisor.mjs');
 // The run itself records nothing while its tasks run; their engines' activity reaches noteActivity.
 for(clock=10*60_000;clock<=120*60_000;clock+=10*60_000){noteActivity();await tickForTest();}
 assert.deepEqual(alerts(state),[],'no stall while the task engines work');
 clock+=31*60_000;await tickForTest();
 assert.deepEqual(alerts(state),[['stall',null]],'a round where nothing happens still is one');
});

test('notifications: webhook and Discord get the event, digests can be turned off, bad URLs are refused',async t=>{
 const sent=[];t.after(()=>useNotify());
 useNotify({project:'Demo',webhook:'https://hooks.example.com/x',discord:'https://discord.com/api/webhooks/1/abc',digests:false},{fetchImpl:async(url,init)=>{sent.push([url,JSON.parse(init.body)]);return {ok:true};}});
 notifyEvent({type:'run-limit',message:'Task limit reached.'});
 notify({type:'supervisor-digest',title:'Digest',message:'skipped'});
 notifyEvent({type:'qa-pass'});
 await flushNotifications();
 assert.equal(sent.length,2);
 assert.deepEqual(sent[0],['https://hooks.example.com/x',{source:'agent-dock',project:'Demo',type:'run-limit',title:'Run limit reached',message:'Task limit reached.',at:sent[0][1].at}]);
 assert.match(sent[1][1].content,/^\*\*Run limit reached\*\* · Demo\nTask limit reached\.$/);
 assert.deepEqual(sent[1][1].allowed_mentions,{parse:[]});
 assert.throws(()=>checkChannelUrl('webhook','http://hooks.example.com'),/https/);
 assert.equal(checkChannelUrl('webhook','http://127.0.0.1:9000/hook'),'http://127.0.0.1:9000/hook');
 assert.throws(()=>checkChannelUrl('discord','https://evil.example.com/api/webhooks/1'),/Discord webhook URL/);
});
