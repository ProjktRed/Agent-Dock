import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as guard from '../src/cline-tool-guard.mjs';
import {buildCorrectionPrompt} from '../src/workflow.mjs';
import {correctionText} from '../src/recovery-policy.mjs';

async function fixture(t,text='const a = 1;\nconst b = 2;\n') {
 const root=await mkdtemp(path.join(os.tmpdir(),'edit-boundary-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=path.join(root,'repo'),stateDir=path.join(root,'state');await mkdir(workspace);await mkdir(stateDir);
 await writeFile(path.join(workspace,'test.ts'),text);
 await writeFile(path.join(stateDir,'current-task.json'),JSON.stringify({id:'test',allowedPaths:['test.ts'],qaCommand:'npm test'}));
 const p=await guard.prepareToolGuard({workspace,stateDir});const plugin=guard.createRestrictedToolsPlugin(p.policyPath);
 await plugin.hooks.beforeModel({request:{tools:['read_files','editor','run_commands'].map(name=>({name,inputSchema:{type:'object'}}))}});
 const edit=input=>plugin.hooks.beforeTool({tool:{name:'editor'},toolCall:{toolCallId:'e'},input:{path:'test.ts',...input}});
 const read=async(start=1,end=999)=>{const lines=(await readFile(path.join(workspace,'test.ts'),'utf8')).split(/\r?\n/);
  await guard.handleGuardEvent(p.policyPath,{hookName:'tool_result',tool_result:{id:'r',name:'read_files',input:{files:[{path:'test.ts',start_line:start,end_line:end}]},output:[{success:true,query:'test.ts',result:lines.slice(start-1,end).map((s,i)=>`${start+i} | ${s}`).join('\n')}]}});
 };
 return {...p,workspace,stateDir,plugin,edit,read};
}
test('runtime capabilities report only registered visible tools, never an invented patch tool',async t=>{
 const p=await fixture(t),state=await guard.readGuardOutcome(p.policyPath);
 assert.deepEqual(state.nativeTools,['read_files','editor','run_commands']);
});
test('existing-file rewrites and oversized edits are rejected before mutation with precise evidence',async t=>{
 const p=await fixture(t);await p.read();
 assert.equal((await p.edit({new_text:'rewrite'})).skip,true);
 const outcome=await guard.readGuardOutcome(p.policyPath);
 assert.match(outcome.editFailures[0].error,/replacement|whole.file/i);
 assert.equal((await p.edit({old_text:'const a = 1;',new_text:'x'.repeat(10499)})).stop,true);
 assert.equal(await readFile(path.join(p.workspace,'test.ts'),'utf8'),'const a = 1;\nconst b = 2;\n');
});
test('replacement needs a fresh read, unique match and an actually read range',async t=>{
 const p=await fixture(t);assert.equal((await p.edit({old_text:'const a = 1;',new_text:'const a = 3;'})).skip,true);
 await p.read(1,1);assert.equal(await p.edit({old_text:'const a = 1;',new_text:'const a = 3;'}),undefined);
 await writeFile(path.join(p.workspace,'test.ts'),'const a = 1;\nconst b = 4;\n');
 assert.equal((await p.edit({old_text:'const a = 1;',new_text:'const a = 3;'})).stop,true);
 const q=await fixture(t,'same\nsame\nother\n');await q.read(1,1);
 assert.equal((await q.edit({old_text:'same',new_text:'new'})).skip,true);
 assert.equal((await q.edit({old_text:'other',new_text:'new'})).stop,true);
});
test('failed native result preserves arguments/error/excerpt even when the second failure stops the SDK',async t=>{
 const p=await fixture(t);await p.read();
 for(let i=0;i<2;i++)await guard.handleGuardEvent(p.policyPath,{hookName:'tool_result',tool_result:{id:'edit'+i,name:'editor',input:{path:'test.ts',old_text:'not present',new_text:'changed'},output:JSON.stringify({success:false,error:'No replacement performed: text not found'})},postToolUse:{success:true}});
 const state=await guard.readGuardOutcome(p.policyPath);assert.equal(state.stopped,true);assert.equal(state.editFailures.length,2);
 assert.equal(state.editFailures[1].input.old_text,'not present');assert.match(state.editFailures[1].error,/text not found/);assert.match(state.editFailures[1].excerpt,/const a/);
});
test('same failed edit cannot be executed again even after a fresh read',async t=>{
 const p=await fixture(t);await p.read();const input={path:'test.ts',old_text:'const a = 1;',new_text:'const a = 3;'};
 await guard.handleGuardEvent(p.policyPath,{hookName:'tool_result',tool_result:{name:'editor',input,output:{success:false,error:'native failure'}}});
 await p.read();assert.equal((await p.edit(input)).stop,true);
});
test('correction handoff includes acceptance once and does not replay nested obsolete QA strategies',()=>{
 const task={id:'x',prompt:'Task skill: implement\nAcceptance: preserve all tests and parser.',allowedPaths:['test.ts'],qaCommand:'npm test'};
 const result={status:'correction',nextWorkerInstructions:'Delete only the duplicate declaration using editor.',preserve:['all tests'],rootProblem:'duplicate declaration',newStrategy:'small exact replacement'};
 const prompt=buildCorrectionPrompt(task,'OBSOLETE STRATEGY '.repeat(1000),12,correctionText(result,{task,acceptanceCriteria:task.prompt}));
 assert.equal(prompt.split('Acceptance: preserve all tests and parser.').length-1,1);
 assert.ok(prompt.indexOf('Delete only')<prompt.indexOf('Acceptance:'));
 assert.ok(!prompt.includes('OBSOLETE STRATEGY'));assert.ok(prompt.length<5000);
});
