import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {saveTaskDefinition,taskFileName} from '../src/task-archive.mjs';

test('each started task is kept by its definition only, under a safe file name', async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'task-archive-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 assert.equal(taskFileName('T1: add/slug'),'T1_add_slug.json');
 const file=await saveTaskDefinition(dir,{id:'T1',name:'Slug',prompt:'Add slug',allowedPaths:['src/slug.js'],qaCommand:'npm test',automation:{recovery:{attempt:3}}});
 const saved=JSON.parse(await readFile(file,'utf8'));
 assert.deepEqual([saved.id,saved.prompt,saved.qaCommand,saved.allowedPaths],['T1','Add slug','npm test',['src/slug.js']]);
 assert.equal(saved.automation,undefined,'recovery state is never kept');
 assert.equal(await saveTaskDefinition(dir,{id:'assessment',name:'Assessing'}),null);
});
