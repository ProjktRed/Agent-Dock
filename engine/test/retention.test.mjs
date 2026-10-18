import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,readFile,rm,utimes,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {applyRetention} from '../src/retention.mjs';
import {appendAction,flushActionLog,pruneActionLog,rotateActionLog,verifyActionLog} from '../src/action-log.mjs';

const DAY=24*60*60*1000;
async function dir(t){const d=await mkdtemp(path.join(os.tmpdir(),'retention-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
async function folder(base,name,ageDays){const p=path.join(base,name);await mkdir(p,{recursive:true});await writeFile(path.join(p,'prompt.txt'),'x');const when=new Date(Date.now()-ageDays*DAY);await utimes(p,when,when);return p;}

test('old call folders and Cline sessions go; the newest always stay; 0 days keeps everything',async t=>{
 const state=await dir(t);
 for(let i=0;i<5;i++)await folder(path.join(state,'codex'),`old-${i}`,40+i);
 for(let i=0;i<3;i++)await folder(path.join(state,'codex'),`new-${i}`,1);
 for(let i=0;i<4;i++)await folder(path.join(state,'cline-data','sessions'),`s-${i}`,60);
 assert.deepEqual(await applyRetention(state,{days:0}),{calls:0,sessions:0,setAside:0,activityTrimmed:false,actionLogRotated:false,actionLogPruned:0});
 const r=await applyRetention(state,{days:30,keepCalls:4,keepSessions:2});
 assert.equal(r.calls,4,'5 old minus the one kept among the newest 4');assert.equal(r.sessions,2);
 assert.deepEqual((await readdir(path.join(state,'codex'))).sort(),['new-0','new-1','new-2','old-0']);
});

test('Activity is trimmed to its newest lines once it is too big',async t=>{
 const state=await dir(t);
 await writeFile(path.join(state,'activity.ndjson'),Array.from({length:100},(_,i)=>JSON.stringify({i})).join('\n')+'\n');
 const r=await applyRetention(state,{days:30,maxActivityBytes:200,keepActivityLines:10});
 assert.equal(r.activityTrimmed,true);
 const lines=(await readFile(path.join(state,'activity.ndjson'),'utf8')).trim().split('\n');
 assert.equal(lines.length,10);assert.equal(JSON.parse(lines[9]).i,99);
});

test('the action log rotates, keeps one chain across files, prunes with a record, and still catches tampering',async t=>{
 const state=await dir(t);
 for(let i=0;i<5;i++)await appendAction(state,{type:'e',i});
 await flushActionLog();
 assert.equal(await rotateActionLog(state,{maxBytes:10}),true);
 for(let i=5;i<8;i++)await appendAction(state,{type:'e',i});
 await flushActionLog();
 assert.deepEqual((await readdir(state)).filter(n=>n.startsWith('action-log')).sort(),['action-log-000000001-000000005.ndjson','action-log.ndjson']);
 let v=await verifyActionLog(state);assert.equal(v.ok,true);assert.equal(v.entries,8);
 const current=(await readFile(path.join(state,'action-log.ndjson'),'utf8')).trim().split('\n');
 assert.equal(JSON.parse(current[0]).seq,6,'the sequence continues in the new file');
 // Prune the archive: a chained record says where the chain now starts.
 assert.equal(await pruneActionLog(state,{before:Date.now()+1000}),1);
 v=await verifyActionLog(state);assert.equal(v.ok,true);assert.equal(v.pruned,5);assert.equal(v.entries,4);
 // Editing a kept entry is still caught.
 const edited=current.map((l,i)=>i===1?l.replace('"i":6','"i":66'):l);
 const after=(await readFile(path.join(state,'action-log.ndjson'),'utf8')).trim().split('\n');
 await writeFile(path.join(state,'action-log.ndjson'),[...edited,...after.slice(current.length)].join('\n')+'\n');
 v=await verifyActionLog(state);assert.equal(v.ok,false);assert.match(v.reason,/content changed/);
});

test('a log that starts mid-chain without a prune record does not verify',async t=>{
 const state=await dir(t);
 for(let i=0;i<4;i++)await appendAction(state,{type:'e',i});
 await flushActionLog();
 const lines=(await readFile(path.join(state,'action-log.ndjson'),'utf8')).trim().split('\n');
 await writeFile(path.join(state,'action-log.ndjson'),lines.slice(2).join('\n')+'\n');
 const v=await verifyActionLog(state);assert.equal(v.ok,false);assert.match(v.reason,/sequence jumps|does not link/);
});
