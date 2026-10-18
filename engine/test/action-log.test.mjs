import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ACTION_LOG,GENESIS,appendAction,flushActionLog,verifyActionLog} from '../src/action-log.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';
import {parseStopArgs,stopAll} from '../src/stop-all.mjs';

const tempDir=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'action-log-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
const lines=async dir=>(await readFile(path.join(dir,ACTION_LOG),'utf8')).trim().split('\n');

test('entries chain by hash, keep their own fields, and survive concurrent appends in order',async t=>{
 const dir=await tempDir(t);
 assert.deepEqual(await verifyActionLog(dir),{ok:true,entries:0,head:GENESIS,lastAt:null});
 await Promise.all(Array.from({length:20},(_,i)=>appendAction(dir,{type:'event',i,seq:999,hash:'forged',text:'x'.repeat(5000)})));
 const entries=(await lines(dir)).map(line=>JSON.parse(line));
 assert.deepEqual(entries.map(e=>e.seq),Array.from({length:20},(_,i)=>i+1),'the log numbers entries, not the event');
 assert.equal(entries[0].prev,GENESIS);
 assert.equal(entries[1].prev,entries[0].hash);
 assert.match(entries[0].text,/…\[3000 more\]$/);
 const result=await verifyActionLog(dir);
 assert.deepEqual([result.ok,result.entries,result.head],[true,20,entries[19].hash]);
});

test('editing, deleting or reordering an entry is detected at that entry',async t=>{
 const dir=await tempDir(t);
 for(const type of ['a','b','c','d'])await appendAction(dir,{type});
 const original=await lines(dir),file=path.join(dir,ACTION_LOG);
 const edited=[...original];edited[1]=edited[1].replace('"type":"b"','"type":"B"');
 await writeFile(file,edited.join('\n')+'\n');
 assert.deepEqual(await verifyActionLog(dir).then(r=>[r.ok,r.brokenAt,r.reason]),[false,2,'content changed after it was written']);
 await writeFile(file,[original[0],original[2],original[3]].join('\n')+'\n');
 assert.deepEqual(await verifyActionLog(dir).then(r=>[r.ok,r.brokenAt]),[false,2]);
 await writeFile(file,original.join('\n')+'\n');
 assert.equal((await verifyActionLog(dir)).ok,true);
});

test('activity events and controls reach the action log with who asked',async t=>{
 const dir=await tempDir(t);
 const state=new DashboardState({stateDir:dir});
 await state.setControl('pause',{source:'dashboard'});
 await state.record({type:'qa-pass',taskId:'t1'});
 await flushActionLog();
 const entries=(await lines(dir)).map(line=>JSON.parse(line));
 assert.deepEqual(entries.map(e=>[e.type,e.source??null]),[['control-pause','dashboard'],['qa-pass',null]]);
 // Clearing activity history leaves the action log alone.
 await writeFile(path.join(dir,'live.json'),JSON.stringify({stage:'paused'}));
 await state.clearActivityHistory();
 assert.equal((await verifyActionLog(dir)).entries,2);
});

test('stop-all asks running engines to stop, kills them with --now, and skips the rest',async t=>{
 const config=await tempDir(t),a=path.join(config,'a'),b=path.join(config,'b'),c=path.join(config,'c');
 for(const dir of [a,b,c])await mkdir(dir,{recursive:true});
 await writeFile(path.join(config,'projects.json'),JSON.stringify([{id:'1',name:'Alpha',stateDir:a},{id:'2',name:'Beta',stateDir:b},{id:'3',name:'Gamma',stateDir:c}]));
 const pids={[a]:101,[b]:102},killed=[];
 const deps={findPid:async dir=>pids[dir]??null,kill:async pid=>{killed.push(pid);}};
 assert.deepEqual(await stopAll({config},deps),[{project:'Alpha',result:'stopping at the next safe point'},{project:'Beta',result:'stopping at the next safe point'},{project:'Gamma',result:'not running'}]);
 assert.equal(JSON.parse(await readFile(path.join(a,'control.json'),'utf8')).stopAfterSafePoint,true);
 assert.deepEqual(killed,[]);
 assert.deepEqual(await stopAll({config,now:true,project:'Beta'},deps),[{project:'Beta',result:'stopped now'}]);
 assert.deepEqual(killed,[102]);
 const logged=(await lines(b)).map(line=>JSON.parse(line)).map(e=>[e.type,e.source]);
 assert.deepEqual(logged,[['control-stop','cli'],['stopped','cli']]);
 await assert.rejects(stopAll({config,project:'Nope'},deps),/No project named Nope/);
 assert.deepEqual(parseStopArgs(['--config','x','--now']),{config:'x',now:true,project:null});
 assert.throws(()=>parseStopArgs(['--force']),/Unknown option/);
});
