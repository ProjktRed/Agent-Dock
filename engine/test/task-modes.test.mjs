import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {runNodeLoop} from '../src/node-loop.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';
import {MODE_SIZING,TUNING,parseTuning,readFilesText,taskScopeText,taskSizingText,useTuning,workerSizingText} from '../src/engine-tuning.mjs';
import {objectiveWithDeferred} from '../src/defer-task.mjs';

test('task modes: eco is the default; standard and max size tasks for capable models',()=>{
 assert.equal(parseTuning({}).taskMode,'eco');
 const standard=parseTuning({'task-mode':'standard'});
 assert.deepEqual([standard.taskMaxFiles,standard.taskMaxNewLines,standard.taskMaxReadFiles],[10,800,10]);
 assert.match(taskSizingText(standard),/one task per unchecked plan item, its code and tests together.*at most 10 files per task.*about 800 lines/);
 assert.match(taskScopeText(standard),/a whole unchecked plan item/);
 assert.match(workerSizingText(standard),/^Worker sizing \(standard mode/);
 const max=parseTuning({'task-mode':'max'});
 assert.deepEqual([max.taskMaxFiles,max.taskMaxNewLines,max.taskMaxReadFiles],[0,0,0]);
 assert.doesNotMatch(taskSizingText(max),/at most|under about/,'max has no limits by default');
 assert.equal(readFilesText(max),'Name the files to read (with line ranges for large files).');
 const limited=parseTuning({'task-mode':'max','task-max-files':'20','task-max-read-files':'15'});
 assert.match(taskSizingText(limited),/at most 20 files per task/);
 assert.match(readFilesText(limited),/at most 15/);
 const eco=parseTuning({});
 assert.match(taskScopeText(eco),/small bounded/);
 assert.match(workerSizingText(eco),/^Local worker sizing \(98K context/);
 assert.throws(()=>parseTuning({'task-mode':'huge'}),/eco, standard or max/);
 assert.equal('stepDown' in parseTuning({}),false,'no step-down: a failing task keeps its size');
});

test('a task set aside by the step-down of an earlier version is listed like any deferred task',async t=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'deferred-old-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 await writeFile(path.join(stateDir,'deferred-tasks.json'),JSON.stringify([{id:'A',name:'Whole item',reason:'Stepped down from standard to eco size after 2 failed reviews',stash:null,stepDown:{from:'standard',to:'eco'}}]));
 const text=await objectiveWithDeferred(stateDir,'Build it');
 assert.match(text,/Deferred tasks .*A "Whole item"/);
 assert.doesNotMatch(text,/Stepped down: /);
});
