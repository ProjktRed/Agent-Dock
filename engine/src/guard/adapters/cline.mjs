import path from 'node:path';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {atomicWriteJson} from '../../dashboard-state.mjs';
import {createPolicy} from '../policy.mjs';
import {readJson,updateGuardPolicy,readGuardOutcome,readWorkerCapabilities} from '../state.mjs';
import {parsePatchPaths} from '../action.mjs';
import {decide,observe,recordHookDecision} from '../decide.mjs';
import {runHook} from '../hook-runner.mjs';
import {cancelPrefix,MALFORMED_HOOK_INPUT,MISSING_TOOL_IDENTITY,MALFORMED_PATCH} from '../reasons.mjs';
import {createRestrictedToolsPlugin,verifyRestrictedTools} from './cline-plugin.mjs';

export {createRestrictedToolsPlugin,verifyRestrictedTools,readGuardOutcome,readWorkerCapabilities};
export const allowedTools=['read_files','search_codebase','run_commands','editor','apply_patch','skills','ask_question','submit_and_exit'];

export function instructions(policy){return '\n\nEnforced editing guard: edit only '+policy.allowedPaths.join(', ')+' using the editing tool actually present in your tool schema. A mentioned tool is not necessarily registered. Source-writing shell commands and helper files are prohibited. Read the intended range with read_files immediately before editing. Existing files require a unique exact old_text/new_text replacement (at most 2000 characters each), or a verified insert_line; whole-file rewrites are prohibited. Do not reconstruct backslashes from escaped output. Two consecutive failed native edits stop this attempt. Select run_commands.commands from its exact enum; do not invent commands. Three invalid tool requests stop this attempt. Approved command choices (prefer npm.cmd/npx.cmd on Windows):\n'+policy.commandChoices.join('\n')+'\nDo not wrap commands in PowerShell/cmd or redirect output.';}

export function launchConfiguration({configDir,hooksDir,dataDir,pluginPath}={}){
 const launchArgs=[];
 if(dataDir)launchArgs.push('--data-dir',dataDir);
 if(configDir)launchArgs.push('--config',configDir);
 if(hooksDir)launchArgs.push('--hooks-dir',hooksDir);
 return {launchArgs,env:configDir?{CLINE_GLOBAL_SETTINGS_PATH:path.join(configDir,'data/settings/global-settings.json')}:{},verify:()=>verifyRestrictedTools({pluginPath})};
}

export async function install({policy,policyPath,guardDir}){
 const configDir=path.join(guardDir,'config'),hooksDir=path.join(configDir,'hooks');
 await mkdir(hooksDir,{recursive:true});
 for(const name of ['PreToolUse','PostToolUse']){
  const source=`import {runGuardHook} from ${JSON.stringify(import.meta.url)};\nawait runGuardHook(${JSON.stringify(policyPath)});\n`;
  const file=path.join(hooksDir,name+'.mjs'),temporary=file+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,source,'utf8');await rename(temporary,file);
 }
 const pluginPath=path.join(configDir,'plugins','restricted-tools.js');await mkdir(path.dirname(pluginPath),{recursive:true});
 await atomicWriteJson(path.join(configDir,'package.json'),{private:true,type:'module'});
 const temporary=pluginPath+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,`import {createRestrictedToolsPlugin} from ${JSON.stringify(new URL('./cline-plugin.mjs',import.meta.url).href)};\nexport default createRestrictedToolsPlugin(${JSON.stringify(policyPath)});\n`);await rename(temporary,pluginPath);
 await atomicWriteJson(path.join(configDir,'data/settings/global-settings.json'),{disabledTools:['fetch_web_content','web_search','spawn_agent','spawn_subagent','browser_action','execute_command','write_to_file','replace_in_file'],tools:{web_search:{enabled:false}}});
 return {configDir,hooksDir,policyPath,pluginPath,...launchConfiguration({configDir,hooksDir,dataDir:path.join(configDir,'data'),pluginPath})};
}

export async function prepareToolGuard({stateDir,workspace}){
 const task=await readJson(path.join(stateDir,'current-task.json'));
 const policy=await createPolicy(task,workspace,{stateDir});
 const guardDir=path.join(path.resolve(stateDir),adapter.stateSubdir),policyPath=path.join(guardDir,'policy.json');
 await atomicWriteJson(policyPath,policy);
 const {configDir,hooksDir,pluginPath}=await install({policy,policyPath,guardDir});
 return {configDir,hooksDir,policyPath,pluginPath,instructions:instructions(policy)};
}

export function patchPaths(input,options){return parsePatchPaths(input?.input,options);}
export function readRange(input,output){
 let results=output;try{if(typeof output==='string')results=JSON.parse(output);}catch{}
 const files=input?.files;
 if(!Array.isArray(results)||!Array.isArray(files))return [];
 const ranges=[];
 for(let i=0;i<Math.min(files.length,32);i++){
  const file=files[i]?.path,result=results[i];
  if(!file||result?.success!==true||typeof result.result!=='string')continue;
  const returned=[...result.result.matchAll(/^\s*(\d+) \| ?(.*)$/gm)];
  const contiguous=returned.length&&!returned.some((m,j)=>j&&Number(m[1])!==Number(returned[j-1][1])+1);
  ranges.push({file,start:returned.length?Number(returned[0][1]):null,end:returned.length?Number(returned.at(-1)[1]):null,text:contiguous?returned.map(m=>m[2].replace(/\r$/,'')).join('\n'):null});
 }
 return ranges;
}

export function toAction(event){
 if(!event||!['tool_call','tool_result'].includes(event.hookName))return {kind:'unknown',error:MALFORMED_HOOK_INPUT,hasTool:Boolean(event?.tool_call),tool:event?.tool_call?.name,input:event?.tool_call?.input,commandEvidence:event?.tool_call?.name==='run_commands'};
 const tool=event.tool_call??event.tool_result;
 if(!tool||typeof tool.name!=='string')return {kind:'unknown',error:MISSING_TOOL_IDENTITY,hasTool:Boolean(event.tool_call),tool:tool?.name,input:tool?.input,commandEvidence:tool?.name==='run_commands'};
 const {name,input,output,id}=tool;
 const common={tool:name,input,output,id,hasTool:Boolean(event.tool_call),commandEvidence:name==='run_commands'};
 if(name==='run_commands'){
  const raw=typeof input==='string'||Array.isArray(input)?input:input?.commands??(input?.command?input:null);
  return {kind:'command',...common,commands:Array.isArray(raw)?raw:raw==null?[]:[raw]};
 }
 if(name==='editor')return {kind:'edit',...common,paths:[input?.path],patch:false};
 if(name==='apply_patch')return {kind:'edit',...common,paths:patchPaths(input),patch:true,...(event.hookName==='tool_call'&&input!=null&&typeof input.input!=='string'?{error:MALFORMED_PATCH}:{})};
 if(name==='read_files')return {kind:'read',...common};
 if(allowedTools.includes(name))return {kind:'inspect',...common};
 return {kind:'unknown',...common};
}

export function toControl(decision,mode='hook'){
 if(mode==='plugin')return decision.effect==='allow'?undefined:{[decision.effect==='reject'?'skip':'stop']:true,reason:decision.reason};
 return decision.effect==='allow'?{cancel:false}:{cancel:true,errorMessage:cancelPrefix(adapter.label)+decision.reason};
}

export const adapter={
 id:'cline',label:'Cline',stateSubdir:'cline-guard',
 capabilities:{narrowsToolSchema:true,enumeratesCommands:true,postToolEvents:true,outOfProcessHooks:true,counters:true,editDiscipline:true},
 maxHookInput:1_000_000,install,instructions,toAction,toControl,readRange,patchPaths,launchConfiguration,
 validCommandInput(policy,input){
  const commands=input?.commands;
  return input&&Object.keys(input).length===1&&Array.isArray(commands)&&commands.length>0&&commands.every(command=>typeof command==='string'&&policy.commandChoices.includes(command));
 },
};

export async function handleGuardEvent(policyPath,payload){
 return updateGuardPolicy(policyPath,async policy=>{
  const action=toAction(payload);
  const decision=payload?.hookName==='tool_result'?await observe(policy,action,{adapter,success:payload.postToolUse?.success}):await decide(policy,action,{adapter});
  return toControl(recordHookDecision(policy,decision,action));
 },{adapter});
}

export async function runGuardHook(policyPath){
 const result=await runHook(adapter,{policyPath,handleEvent:handleGuardEvent});
 process.stdout.write(result.stdout);
}
export default adapter;
