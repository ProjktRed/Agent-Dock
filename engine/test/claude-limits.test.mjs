import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {lastRateLimitInfo,saveClaudeRateLimit} from '../src/claude-limits.mjs';
import {extractClaudeResult} from '../src/claude-worker.mjs';
import {claudeUsage} from '../src/run-budget.mjs';

const stream=[
 JSON.stringify({type:'system',subtype:'init'}),
 JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed',unifiedWindows:{five_hour:{utilization:0.2,resetsAt:1}}}}),
 '{"type":"rate_limit_event","rate_limit_info":',
 JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed_warning',unifiedWindows:{five_hour:{utilization:0.81,resetsAt:1}}}}),
 JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'rate_limit_event is just text here'}]}}),
 JSON.stringify({type:'result',subtype:'success',is_error:false,result:'',structured_output:{status:'pass'},usage:{input_tokens:10,output_tokens:5},total_cost_usd:0.01}),
].join('\n');

test('the last rate_limit_event in Claude Code stream-json output is saved for the app', async t=>{
 assert.equal(lastRateLimitInfo(stream).unifiedWindows.five_hour.utilization,0.81);
 assert.equal(lastRateLimitInfo('{"type":"result"}'),null);
 const dir=await mkdtemp(path.join(os.tmpdir(),'claude-limits-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const saved=await saveClaudeRateLimit(dir,stream,()=>new Date('2026-10-19T08:00:00.000Z'));
 assert.deepEqual(JSON.parse(await readFile(path.join(dir,'claude-rate-limit.json'),'utf8')),saved);
 assert.equal(saved.fetchedAt,'2026-10-19T08:00:00.000Z');
 assert.equal(await saveClaudeRateLimit(dir,'no events'),null);
});

test('stream-json output still yields the result envelope and usage', ()=>{
 assert.equal(extractClaudeResult(stream),JSON.stringify({status:'pass'}));
 assert.deepEqual(claudeUsage(stream),{input:10,cached:0,output:5,costUsd:0.01});
});
