import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import * as guard from '../src/guard/adapters/cline.mjs';
import {ClineCliWorker,launchCline} from '../src/cline-cli-worker.mjs';

async function setup(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'restricted-tools-'));
 const workspace=path.join(root,'repo'),stateDir=path.join(root,'state');await mkdir(workspace);await mkdir(stateDir);
 await writeFile(path.join(workspace,'example.ts'),'unchanged');
 await writeFile(path.join(stateDir,'current-task.json'),JSON.stringify({id:'bounded',allowedPaths:['example.ts'],qaCommand:'npx vitest run example.ts'}));
 const result={...await guard.prepareToolGuard({workspace,stateDir}),workspace,stateDir};
 t.after(async()=>{await result.beforeCleanup?.();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 return result;
}
const call=(name,input)=>({tool:{name},toolCall:{toolName:name,toolCallId:'fake'},input});
const request={tools:['read_files','search_codebase','run_commands','editor','apply_patch','skills','ask_question','submit_and_exit','fetch_web_content','spawn_agent','unknown_future_tool'].map(name=>({name,description:name,inputSchema:{type:'object'}}))};
async function plugin(p){return (await import(pathToFileURL(p.pluginPath).href)).default;}

test('model sees only native allowed tools and enumerated Windows-safe task commands',async t=>{
 const p=await setup(t),extension=await plugin(p),result=await extension.hooks.beforeModel({request});
 assert.deepEqual(result.tools.map(x=>x.name),['read_files','search_codebase','run_commands','editor','apply_patch','ask_question','submit_and_exit']);
 const schema=result.tools.find(x=>x.name==='run_commands').inputSchema;
 assert.deepEqual(schema.required,['commands']);assert.equal(schema.additionalProperties,false);
 const commands=schema.properties.commands.items.enum;
 assert.ok(commands.includes('npx.cmd vitest run example.ts'));assert.ok(commands.includes('git diff -- example.ts'));
 assert.ok(!commands.includes('Get-Content example.ts'));assert.ok(!commands.includes('npm exec node writer.js'));
 const settings=JSON.parse(await readFile(path.join(p.configDir,'data/settings/global-settings.json'),'utf8'));
 assert.ok(settings.disabledTools.includes('fetch_web_content'));
 assert.ok(settings.disabledTools.includes('skills'));
 assert.equal((await readFile(path.join(p.workspace,'example.ts'),'utf8')),'unchanged');
});

test('ordinary invented command is skipped without abort; legacy first hook cannot abort it',async t=>{
 const p=await setup(t),extension=await plugin(p);await extension.hooks.beforeModel({request});
 const input={commands:['Get-Content example.ts | Format-Hex']};
 assert.equal((await guard.handleGuardEvent(p.policyPath,{hookName:'tool_call',tool_call:{name:'run_commands',input}})).cancel,false);
 const rejected=await extension.hooks.beforeTool(call('run_commands',input));
 assert.equal(rejected.skip,true);assert.notEqual(rejected.stop,true);assert.match(rejected.reason,/approved/i);
 assert.equal((await guard.readGuardOutcome(p.policyPath)).stopped,false);
 assert.equal(await extension.hooks.beforeTool(call('run_commands',{commands:['npx.cmd vitest run example.ts']})),undefined);
});

test('three invalid requests stop boundedly and preserve rejection evidence',async t=>{
 const p=await setup(t),extension=await plugin(p);await extension.hooks.beforeModel({request});
 for(let i=0;i<2;i++)assert.equal((await extension.hooks.beforeTool(call('run_commands',{commands:['Get-Content example.ts']}))).skip,true);
 assert.equal((await extension.hooks.beforeTool(call('run_commands',{commands:['Get-Content example.ts']}))).stop,true);
 const state=await guard.readGuardOutcome(p.policyPath);assert.equal(state.stopped,true);assert.equal(state.invalidToolCalls,3);assert.equal(state.lastRejection.tool,'run_commands');
});

test('hidden registered read-only tool returns retry error after file hook, while unknown edit escape hard stops',async t=>{
 const p=await setup(t),extension=await plugin(p);await extension.hooks.beforeModel({request});
 const payload={hookName:'tool_call',tool_call:{name:'fetch_web_content',input:{url:'https://example.invalid'}}};
 assert.equal((await guard.handleGuardEvent(p.policyPath,payload)).cancel,false);
 assert.equal((await extension.hooks.beforeTool(call('fetch_web_content',payload.tool_call.input))).skip,true);
 assert.equal((await extension.hooks.beforeTool(call('write_to_file',{path:'outside.ts',content:'bad'}))).stop,true);
});

test('unknown tool names are counted before SDK tool lookup and third invalid request stops',async t=>{
 const p=await setup(t),extension=await plugin(p);await extension.hooks.beforeModel({request});
 for(let i=0;i<3;i++){
  const result=await extension.hooks.afterModel({assistantMessage:{content:[{type:'tool-call',toolCallId:'x'+i,toolName:'imaginary_tool',input:{}}]}});
  assert.equal(result?.stop===true,i===2);
 }
 assert.equal((await guard.readGuardOutcome(p.policyPath)).invalidToolCalls,3);
});

test('real launch adapter pins isolated disabledTools settings even with a separate provider data directory',async t=>{
 const p=await setup(t),result=await launchCline({...p,clineJs:path.resolve('fixtures/fake-cline-restricted-env.mjs'),dataDir:path.join(p.stateDir,'cline-data'),prompt:'fake only',guardPolicyPath:p.policyPath,guardPluginPath:p.pluginPath});
 assert.equal(result.runResult.settingsPath,path.join(p.configDir,'data/settings/global-settings.json'));
 assert.ok(result.runResult.disabledTools.includes('fetch_web_content'));
});

test('unsafe Git, source writes, out-of-scope edits and corrupted policy still hard stop',async t=>{
 for(const [name,input] of [['run_commands',{commands:['git reset --hard']}],['run_commands',{commands:['Set-Content helper.ps1 bad']}],['editor',{path:'outside.ts',new_text:'bad'}]]){
  const p=await setup(t),extension=await plugin(p);await extension.hooks.beforeModel({request});
  assert.equal((await extension.hooks.beforeTool(call(name,input))).stop,true);
  assert.equal((await guard.readGuardOutcome(p.policyPath)).stopped,true);
 }
 const p=await setup(t),extension=await plugin(p);await writeFile(p.policyPath,'{}');assert.equal((await extension.hooks.beforeModel({request})).stop,true);
});

test('without runtime handshake file guard rejects invented commands; damaged plugin is not silently accepted',async t=>{
 const p=await setup(t);
 assert.equal((await guard.handleGuardEvent(p.policyPath,{hookName:'tool_call',tool_call:{name:'run_commands',input:{commands:['Get-Content example.ts']}}})).cancel,true);
 assert.ok(p.pluginPath);await writeFile(p.pluginPath,'export default {}');
 await assert.rejects(guard.verifyRestrictedTools(p),/plugin|restriction/i);
});

test('new approved file does not prevent guard preparation, and guarded worker receives the generated plugin',async t=>{
 const p=await setup(t);await rm(path.join(p.workspace,'example.ts'));
 let received=false;
 const worker=new ClineCliWorker({...p,toolGuard:true,checkExternalBusy:async()=>false,launch:async options=>{
  assert.equal(options.guardPluginPath,path.join(p.configDir,'plugins/restricted-tools.js'));await guard.verifyRestrictedTools({pluginPath:options.guardPluginPath});received=true;
  return {exitCode:0,runResult:{finishReason:'completed'}};
 }});
 await worker.run('fake only');assert.equal(received,true);
});

for(const mode of ['in_process','sandbox'])test(`installed SDK ${mode} loads generated config and fake model recovers from skipped command without executing it`,async t=>{
 const sdkFile=process.env.CLINE_TEST_SDK??path.join(process.env.APPDATA??'', 'npm/node_modules/cline/node_modules/@cline/core/dist/index.js');
 try{await readFile(sdkFile);}catch{return t.skip('Installed SDK unavailable; all portable guard tests still run');}
 const sdk=await import(pathToFileURL(sdkFile).href),p=await setup(t);sdk.setClineDir(p.configDir);
 const previousIdle=process.env.CLINE_PLUGIN_IDLE_TIMEOUT_MS;process.env.CLINE_PLUGIN_IDLE_TIMEOUT_MS='1000';
 t.after(()=>{if(previousIdle===undefined)delete process.env.CLINE_PLUGIN_IDLE_TIMEOUT_MS;else process.env.CLINE_PLUGIN_IDLE_TIMEOUT_MS=previousIdle;});
 const loaded=await sdk.resolveAndLoadAgentPlugins({workspacePath:p.workspace,cwd:p.workspace,mode});p.beforeCleanup=loaded.shutdown;
 if(loaded.failures.length)console.error('Fake SDK plugin load failures:',loaded.failures);
 assert.deepEqual(loaded.failures,[]);const extension=loaded.extensions.find(e=>e.name==='automation.restricted-tools');assert.ok(extension);
 assert.ok(!sdk.filterDisabledTools(request.tools).some(x=>x.name==='fetch_web_content'));
 const legacy=sdk.createHookConfigFileHooks({cwd:p.workspace,workspacePath:p.workspace,detachAsyncHooks:false});
 let turn=0,executed=[];
 const runtime=sdk.createAgentRuntime({maxIterations:4,hooks:legacy,plugins:[{name:extension.name,setup:()=>({hooks:extension.hooks})}],
 tools:request.tools.map(tool=>({...tool,execute:input=>{executed.push(input);return {output:'ok'};}})),
 model:{async *stream(r){
  assert.ok(!r.tools.some(x=>x.name==='fetch_web_content'));turn++;
  if(turn===2)assert.match(JSON.stringify(r.messages),/approved/i);
  if(turn<3){yield {type:'tool-call-delta',toolCallId:'call-'+turn,toolName:'run_commands',input:{commands:[turn===1?'Get-Content example.ts':'npm.cmd run lint']}};yield {type:'finish',reason:'tool-calls'};}
  else{yield {type:'text-delta',text:'done'};yield {type:'finish',reason:'stop'};}
 }}});
 const result=await runtime.run('fake test, never invoke real model');
 assert.equal(result.status,'completed');assert.deepEqual(executed,[{commands:['npm.cmd run lint']}]);assert.equal(turn,3);
 assert.equal((await guard.readGuardOutcome(p.policyPath)).stopped,false);
 await guard.prepareToolGuard({stateDir:p.stateDir,workspace:p.workspace});
 let unknownTurns=0;
 const unknownRuntime=sdk.createAgentRuntime({maxIterations:10,hooks:legacy,plugins:[{name:extension.name,setup:()=>({hooks:extension.hooks})}],tools:request.tools.map(tool=>({...tool,execute:()=>assert.fail('unknown tool must never execute')})),
 model:{async *stream(){unknownTurns++;yield {type:'tool-call-delta',toolCallId:'unknown-'+unknownTurns,toolName:'imaginary_tool',input:{}};yield {type:'finish',reason:'tool-calls'};}}});
 const unknownResult=await unknownRuntime.run('fake repeated unknown tools');
 assert.equal(unknownResult.status,'aborted');assert.equal(unknownTurns,3);assert.equal((await guard.readGuardOutcome(p.policyPath)).invalidToolCalls,3);
});

test('installed SDK fake model recovers from rejected rewrite using real read/editor tools and durable freshness',async t=>{
 const sdkFile=process.env.CLINE_TEST_SDK??path.join(process.env.APPDATA??'','npm/node_modules/cline/node_modules/@cline/core/dist/index.js');
 try{await readFile(sdkFile);}catch{return t.skip('Installed SDK unavailable');}
 const sdk=await import(pathToFileURL(sdkFile).href),p=await setup(t);sdk.setClineDir(p.configDir);
 const source='const a = 1;\nconst a = 1;\nconst b = 2;\n';await writeFile(path.join(p.workspace,'example.ts'),source);
 const extension=guard.createRestrictedToolsPlugin(p.policyPath);
 const tools=sdk.createDefaultToolsWithPreset('act',{cwd:p.workspace,executors:sdk.createDefaultExecutors(),fileReadTimeoutMs:1000,editorTimeoutMs:1000,enableBash:false,enableWebFetch:false,enableSkills:false,enableAskQuestion:false});
 const exposed=sdk.getCoreHeadlessToolNames(new Set(['editor']),{mode:'act',providerId:'openai-compatible',modelId:'glm-4.7-flash-ud-q3-k-xl'});
 assert.deepEqual(exposed,['editor']);
 const legacy=sdk.createHookConfigFileHooks({cwd:p.workspace,workspacePath:p.workspace,detachAsyncHooks:false});let turn=0;
 const runtime=sdk.createAgentRuntime({maxIterations:5,hooks:legacy,plugins:[{name:extension.name,setup:()=>({hooks:extension.hooks})}],tools,
  model:{async *stream(request){turn++;assert.ok(!request.tools.some(x=>x.name==='apply_patch'));
   const file=path.join(p.workspace,'example.ts');
   const call=turn===1?{toolName:'editor',input:{path:file,new_text:'rewrite'}}:
    turn===2?{toolName:'read_files',input:{files:[{path:file,start_line:1,end_line:3}]}}:
    turn===3?{toolName:'editor',input:{path:file,old_text:'const a = 1;\nconst a = 1;',new_text:'const a = 1;'}}:null;
   if(call){yield {type:'tool-call-delta',toolCallId:'edit-'+turn,...call};yield {type:'finish',reason:'tool-calls'};}
   else{yield {type:'text-delta',text:'done'};yield {type:'finish',reason:'stop'};}
  }}});
 const result=await runtime.run('fake model only');assert.equal(result.status,'completed',JSON.stringify({result,policy:await guard.readGuardOutcome(p.policyPath)}));assert.equal(turn,4);
 assert.equal(await readFile(path.join(p.workspace,'example.ts'),'utf8'),'const a = 1;\nconst b = 2;\n');
 const state=await guard.readGuardOutcome(p.policyPath);assert.equal(state.failedEdits,0);assert.equal(state.editFailures.length,1);assert.ok(state.freshReads);assert.ok(!state.nativeTools.includes('apply_patch'));
});
