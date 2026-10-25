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

// OWASP L02 (0.38.1): rewriting an entry and recomputing the chain passed verification.
test('with the log key, a rewritten and re-chained entry fails verification; a terminal stop may be unsigned',async t=>{
  const {mkdtemp,rm,readFile,writeFile}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const {createHash}=await import('node:crypto');
  const {canonical,useActionLogKey}=await import('../src/action-log.mjs');
  const dir=await mkdtemp(path.join(os.tmpdir(),'action-log-key-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const key='ab'.repeat(32);useActionLogKey(key);t.after(()=>useActionLogKey(null));
  await appendAction(dir,{type:'qa-pass',taskId:'T1'});await appendAction(dir,{type:'stopped',reason:'stop-now',source:'cli'});
  useActionLogKey(null);await appendAction(dir,{type:'stopped',reason:'stop-now',source:'cli'});useActionLogKey(key);
  await appendAction(dir,{type:'qa-fail',taskId:'T2'});await flushActionLog();
  assert.deepEqual(await verifyActionLog(dir).then(r=>[r.ok,r.signed]),[true,3]);
  // The writer without the key rewrites entry 1 and recomputes every hash after it.
  const lines=(await readFile(path.join(dir,ACTION_LOG),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  let prev=GENESIS;
  for(const entry of lines){delete entry.mac;delete entry.hash;if(entry.seq===1)entry.type='qa-fail';entry.prev=prev;entry.hash=createHash('sha256').update(canonical(entry)).digest('hex');prev=entry.hash;}
  await writeFile(path.join(dir,ACTION_LOG),lines.map(l=>JSON.stringify(l)).join('\n')+'\n');
  assert.equal((await verifyActionLog(dir,{key:null})).ok,true,'without the key the rewrite is invisible');
  const keyed=await verifyActionLog(dir,{key:Buffer.from(key,'hex')});
  assert.equal(keyed.ok,false);
  assert.match(keyed.reason,/without Agent Dock's key/);
  // Keeping the old signatures does not help: they sign the old hashes.
  const forged=lines.map((l,i)=>({...l}));forged[0].mac='00'.repeat(32);
  await writeFile(path.join(dir,ACTION_LOG),forged.map(l=>JSON.stringify(l)).join('\n')+'\n');
  assert.match((await verifyActionLog(dir,{key:Buffer.from(key,'hex')})).reason,/signature/);
});

// Defensive review (0.39.0): which entries predate the key came from their own times, so a rewrite with
// every signature removed and every time moved before the key passed.
const rechain=(lines,change)=>{let prev=GENESIS;return lines.map((l,i)=>{const e={...l};delete e.mac;delete e.hash;change(e,i);e.prev=prev;e.hash=createHashSync(e);prev=e.hash;return e;});};
let createHashSync;
test('a rewrite with signatures removed and times moved before the key does not verify',async t=>{
  const {mkdtemp,rm,readFile,writeFile}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const {createHash}=await import('node:crypto');
  const {canonical,useActionLogKey}=await import('../src/action-log.mjs');createHashSync=e=>createHash('sha256').update(canonical(e)).digest('hex');
  const dir=await mkdtemp(path.join(os.tmpdir(),'action-log-backdate-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const key='cd'.repeat(32);useActionLogKey(key);t.after(()=>useActionLogKey(null));
  await appendAction(dir,{type:'qa-pass',taskId:'T1'});await flushActionLog();
  assert.equal((await verifyActionLog(dir)).ok,true);
  const lines=(await readFile(path.join(dir,ACTION_LOG),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  await writeFile(path.join(dir,ACTION_LOG),rechain(lines,e=>{e.type='qa-fail';e.at='2001-01-01T00:00:00.000Z';}).map(l=>JSON.stringify(l)).join('\n')+'\n');
  const result=await verifyActionLog(dir);
  assert.equal(result.ok,false);assert.match(result.reason,/without Agent Dock's key/);
});

test('entries written before the key verify up to the signed checkpoint and no further',async t=>{
  const {mkdtemp,rm,readFile,writeFile}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const {createHash}=await import('node:crypto');
  const {canonical,useActionLogKey,checkpointLegacyLog,LEGACY_CHECKPOINT}=await import('../src/action-log.mjs');createHashSync=e=>createHash('sha256').update(canonical(e)).digest('hex');
  const dir=await mkdtemp(path.join(os.tmpdir(),'action-log-legacy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const key='ef'.repeat(32);t.after(()=>useActionLogKey(null));
  useActionLogKey(null);await appendAction(dir,{type:'qa-pass',taskId:'T1'});await appendAction(dir,{type:'qa-pass',taskId:'T2'});await flushActionLog();
  useActionLogKey(key);
  assert.equal((await verifyActionLog(dir)).ok,false,'without a checkpoint, unsigned entries do not verify');
  assert.equal(await checkpointLegacyLog(dir),true);
  assert.equal(await checkpointLegacyLog(dir),false,'recorded once');
  await appendAction(dir,{type:'qa-fail',taskId:'T3'});await flushActionLog();
  assert.deepEqual(await verifyActionLog(dir).then(r=>[r.ok,r.signed]),[true,1]);
  const file=path.join(dir,ACTION_LOG),original=await readFile(file,'utf8'),lines=original.trim().split('\n').map(l=>JSON.parse(l));
  // Rewriting an entry before the checkpoint, stripping the signed one after it, or cutting entries off all fail.
  for(const forged of [rechain(lines,(e,i)=>{if(i===0)e.type='qa-fail';}),rechain(lines,()=>{}),rechain(lines.slice(0,1),()=>{})]){
    await writeFile(file,forged.map(l=>JSON.stringify(l)).join('\n')+'\n');
    assert.equal((await verifyActionLog(dir)).ok,false,JSON.stringify(forged.map(e=>e.type)));
  }
  await writeFile(file,original);
  // A checkpoint written without the key, or moved past the real one, is ignored.
  const saved=JSON.parse(await readFile(path.join(dir,LEGACY_CHECKPOINT),'utf8'));
  await writeFile(path.join(dir,LEGACY_CHECKPOINT),JSON.stringify({...saved,seq:3}));
  assert.equal((await verifyActionLog(dir)).ok,false);
});

// Second defensive review (0.39.0): unsigned terminal stops could replace signed entries, and removing
// the newest entries (or all of them) left a chain that still verified.
test('removing the newest entries, emptying the log or swapping signed entries for unsigned stops does not verify',async t=>{
  const {mkdtemp,rm,readFile,writeFile}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const {createHash}=await import('node:crypto');
  const {canonical,useActionLogKey,HEAD_RECORD}=await import('../src/action-log.mjs');createHashSync=e=>createHash('sha256').update(canonical(e)).digest('hex');
  const dir=await mkdtemp(path.join(os.tmpdir(),'action-log-head-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const key='12'.repeat(32);useActionLogKey(key);t.after(()=>useActionLogKey(null));
  await appendAction(dir,{type:'qa-pass',taskId:'T1'});await appendAction(dir,{type:'qa-pass',taskId:'T2'});await flushActionLog();
  // A legitimate terminal stop (no key) after the last signed entry still verifies, counted as unsigned.
  useActionLogKey(null);await appendAction(dir,{type:'stopped',reason:'stop-now',source:'cli'});await flushActionLog();useActionLogKey(key);
  assert.deepEqual(await verifyActionLog(dir).then(r=>[r.ok,r.signed,r.unsigned]),[true,2,1]);
  const file=path.join(dir,ACTION_LOG),original=await readFile(file,'utf8'),lines=original.trim().split(/\r?\n/).map(l=>JSON.parse(l));
  const write=entries=>writeFile(file,entries.length?entries.map(l=>JSON.stringify(l)).join('\n')+'\n':'');
  await write(rechain(lines,e=>{e.type='stopped';e.reason='stop-now';e.source='cli';delete e.taskId;}));
  assert.match((await verifyActionLog(dir)).reason,/newest signed entry/);
  await write(lines.slice(0,1));
  assert.match((await verifyActionLog(dir)).reason,/newest entries are missing/);
  await write([]);
  assert.match((await verifyActionLog(dir)).reason,/empty/);
  await writeFile(file,original);await rm(path.join(dir,HEAD_RECORD));
  assert.match((await verifyActionLog(dir)).reason,/record of its newest signed entry is missing/);
});

// Third defensive review (0.39.0): a verification between an append and its head record reported a
// sound log as broken. It now reads under the writers' lock.
test('verification waits for a writer between an append and its head record',async t=>{
  const {mkdtemp,rm,writeFile,readFile}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
  const {useActionLogKey,HEAD_RECORD}=await import('../src/action-log.mjs');
  const dir=await mkdtemp(path.join(os.tmpdir(),'action-log-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  useActionLogKey('34'.repeat(32));t.after(()=>useActionLogKey(null));
  await appendAction(dir,{type:'qa-pass',taskId:'T1'});await appendAction(dir,{type:'qa-pass',taskId:'T2'});await flushActionLog();
  const head=await readFile(path.join(dir,HEAD_RECORD),'utf8'),log=await readFile(path.join(dir,ACTION_LOG),'utf8');
  // A writer holds the lock with the second entry written but its head record not yet.
  const lock=path.join(dir,`${ACTION_LOG}.lock`);await writeFile(lock,'');
  await writeFile(path.join(dir,ACTION_LOG),log);
  const first=JSON.parse(log.split('\n')[0]);
  const {createHmac}=await import('node:crypto');
  await writeFile(path.join(dir,HEAD_RECORD),JSON.stringify({seq:1,head:first.hash,mac:createHmac('sha256',Buffer.from('34'.repeat(32),'hex')).update(`head:1:${first.hash}`).digest('hex')}));
  let settled=false;const verifying=verifyActionLog(dir).then(r=>{settled=true;return r;});
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(settled,false,'verification waits while the lock is held');
  await writeFile(path.join(dir,HEAD_RECORD),head);await rm(lock);
  assert.deepEqual(await verifying.then(r=>[r.ok,r.signed]),[true,2]);
});

test('appends and verifications at the same time: every entry is kept and no verification fails',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const {spawn}=await import('node:child_process');const {pathToFileURL}=await import('node:url');
  const {useActionLogKey}=await import('../src/action-log.mjs');
  const dir=await mkdtemp(path.join(os.tmpdir(),'action-log-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const key='56'.repeat(32);useActionLogKey(key);t.after(()=>useActionLogKey(null));
  const mod=pathToFileURL(path.resolve('src/action-log.mjs')).href;
  const writer=spawn(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(mod)});m.useActionLogKey(${JSON.stringify(key)});for(let i=0;i<150;i++)await m.appendAction(${JSON.stringify(dir)},{type:'qa-pass',i});`],{stdio:['ignore','ignore','pipe']});
  let stderr='';writer.stderr.on('data',d=>stderr+=d);
  const exited=new Promise(resolve=>writer.on('exit',resolve));let done=false;exited.then(()=>{done=true;});
  const failures=[];
  while(!done){const r=await verifyActionLog(dir);if(!r.ok)failures.push(r.reason);}
  assert.equal(await exited,0,stderr);
  assert.deepEqual(failures,[]);
  assert.deepEqual(await verifyActionLog(dir).then(r=>[r.ok,r.entries,r.signed]),[true,150,150]);
});
