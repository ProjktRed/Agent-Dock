import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {atomicWriteJson} from '../../dashboard-state.mjs';
import {createPolicy} from '../policy.mjs';
import {readJson,readGuardOutcome,updateGuardPolicy} from '../state.mjs';
import {parsePatchPaths} from '../action.mjs';
import {decide,observe,recordHookDecision} from '../decide.mjs';
import {cancelPrefix,HANDSHAKE_MISSING,MALFORMED_PATCH,MISSING_TOOL_IDENTITY,UNAPPROVED_TOOL_PATH} from '../reasons.mjs';

export const PLUGIN_ID='agent-dock.guard';
export const SENTINEL_BASE_URL='https://127.0.0.1:1/agent-dock-guard-not-loaded/v1';
export const allowedTools=['shell','bash','read','edit','write','patch','glob','grep','question'];
const refusedTools=['skill','execute','subagent','webfetch','websearch'];

export function providerId(provider){return provider.id==='openrouter'?'openrouter':provider.id==='opencode'?'opencode':'agent-dock';}
export function modelId(provider,model=provider.model){return provider.id==='openrouter'?model.replace(/^openrouter\//,''):provider.id==='opencode'?model.replace(/^opencode\//,''):model;}

export function instructions(policy){
 return '\n\nEnforced editing guard: edit only '+policy.allowedPaths.join(', ')+'. Read the intended range with read immediately before editing. Existing files require a unique exact oldString/newString replacement (at most 2000 characters each); write may create new files only. Patches must be at most 4000 characters and name each affected path. Source-writing shell commands and helper files are prohibited. Two consecutive failed native edits stop this attempt. Use only approved validation/read-only shell commands, from the workspace root:\n'+policy.commandChoices.join('\n')+'\nDo not wrap commands in another shell or redirect output. Code Mode, subagents and web tools are unavailable.';
}

export function patchPaths(input,options){return parsePatchPaths(input?.input??input?.patchText,options);}
export function toAction(event){
 const tool=event?.tool,input=event?.input;
 const common={tool,input,id:event?.id,hasTool:true,output:event?.result?.output??event?.output,commandEvidence:tool==='shell'||tool==='bash'};
 if(typeof tool!=='string')return {kind:'unknown',...common,error:MISSING_TOOL_IDENTITY};
 if(tool==='shell'||tool==='bash')return {kind:'command',...common,commands:typeof input?.command==='string'?[input.command]:[],cwd:input?.workdir??input?.cwd};
 if(tool==='edit')return {kind:'edit',...common,input:input==null?input:{...input,old_text:input.oldString,new_text:input.newString},paths:[input?.path],patch:false};
 if(tool==='write')return {kind:'edit',...common,input:input==null?input:{...input,new_text:input.content},paths:[input?.path],patch:false};
 if(tool==='patch')return {kind:'edit',...common,input:input==null?input:{...input,input:input.patchText},paths:patchPaths(input),patch:true,...(typeof input?.patchText!=='string'?{error:MALFORMED_PATCH}:{})};
 if(tool==='read')return {kind:'read',...common};
 if(allowedTools.includes(tool))return {kind:'inspect',...common};
 return {kind:'unknown',...common};
}

export function readRange(input,output){
 if(typeof input?.path!=='string'||!output||typeof output.content!=='string')return [];
 if(output.type!=='text-page'&&(output.type!=='file'||output.encoding!=='utf8'))return [];
 const start=input.offset??1;
 if(!Number.isInteger(start)||start<1||output.type==='text-page'&&output.offset!==start)return [];
 const text=output.content.replace(/\r\n/g,'\n');
 return [{file:input.path,start,end:start+text.split('\n').length-1,text}];
}

export function toControl(decision){return decision.effect==='allow'?{cancel:false}:{cancel:true,errorMessage:cancelPrefix(adapter.label)+decision.reason};}

// Cline's hook-mode handshake exception depends on its narrowed command enum.
// OpenCode has no enum, so check commands and unknown tools without that exception.
async function scopedDecision(policy,action){
 const runtimeReady=policy.runtimeReady;
 try{
  policy.runtimeReady=false;
  const rooted=action.kind==='command'&&action.cwd&&path.resolve(policy.workspace,action.cwd)!==policy.workspace?{...action,commands:[]}:action;
  return await decide(policy,rooted,{adapter});
 }finally{policy.runtimeReady=runtimeReady;}
}

export async function handleGuardEvent(policyPath,event,{after=false,handshake}={}){
 return updateGuardPolicy(policyPath,async policy=>{
  if(!policy.runtimeReady||handshake&&policy.runtimeHandshake!==handshake)throw Error(HANDSHAKE_MISSING);
  const action=toAction(event);
  let decision;
  if(after)decision=await observe(policy,action,{adapter,success:event.status==='completed'});
  else {
   decision=await scopedDecision(policy,action);
   if(decision.effect==='allow'&&action.kind==='edit')decision=await decide(policy,action,{adapter,mode:'plugin'});
  }
  policy.decisions??=[];
  policy.decisions.push({tool:action.tool,kind:action.kind,effect:decision.effect,reason:decision.reason??null,stage:after?'after':'before'});
  policy.decisions=policy.decisions.slice(-128);
  return toControl(recordHookDecision(policy,decision,action));
 },{adapter});
}

export function createOpenCodePlugin({policyPath,handshake,providerID,model,baseUrl,apiKeyEnv}){
 return {id:PLUGIN_ID,async setup(ctx){
  const check=async(event,after=false)=>{
   const control=await handleGuardEvent(policyPath,event,{after,handshake});
   if(control.cancel)throw Error(control.errorMessage);
  };
  await ctx.tool.hook('execute.before',event=>check(event));
  await ctx.tool.hook('execute.after',event=>check(event,true));
  await ctx.permission.hook('evaluate',async event=>{
   const control=await updateGuardPolicy(policyPath,async policy=>{
    if(!policy.runtimeReady||policy.runtimeHandshake!==handshake)throw Error(HANDSHAKE_MISSING);
    if(policy.stopped)return toControl({effect:'stop',reason:policy.reason});
    if(event.action==='external_directory')return toControl(recordHookDecision(policy,{effect:'stop',reason:UNAPPROVED_TOOL_PATH},{hasTool:false}));
    for(const resource of event.resources??[]){
     const action=event.action==='shell'?toAction({tool:'shell',input:{command:resource}}):event.action==='edit'?toAction({tool:'write',input:{path:resource,content:''}}):toAction({tool:event.action,input:{path:resource}});
     const decision=await scopedDecision(policy,action);
     if(decision.effect!=='allow')return toControl(recordHookDecision(policy,decision,action));
    }
    return {cancel:false};
   },{adapter});
   if(control.cancel){event.effect='deny';event.message=control.errorMessage;}
  });
  await ctx.shell.hook('create.before',event=>{
   if(apiKeyEnv&&event.env)delete event.env[apiKeyEnv];
  });
  await ctx.session.hook('model.request',async event=>{
   const control=await updateGuardPolicy(policyPath,async policy=>{
    if(!policy.runtimeReady||policy.runtimeHandshake!==handshake)throw Error(HANDSHAKE_MISSING);
    if(policy.stopped)return toControl({effect:'stop',reason:policy.reason});
    if(event.model?.providerID!==providerID||event.model?.id!==model||event.baseURL!==SENTINEL_BASE_URL)throw Error('OpenCode guarded provider/model endpoint changed; run refused');
    return {cancel:false};
   },{adapter});
   if(control.cancel)throw Error(control.errorMessage);
   event.baseURL=baseUrl;
  });
  const control=await updateGuardPolicy(policyPath,async policy=>{
   policy.runtimeReady=true;policy.runtimeHandshake=handshake;policy.runtimeReadyMeaning='OpenCode plugin loaded and registered its hooks';policy.nativeTools=allowedTools;
   return {cancel:false};
  },{adapter});
  if(control.cancel)throw Error(control.errorMessage);
 }};
}

export async function install({policy,policyPath,guardDir,providerDescriptor,model=providerDescriptor.model,steps=40}){
 if(!providerDescriptor.baseUrl)throw Error('OpenCode requires an explicit provider base URL');
 const handshake=randomUUID(),configDir=path.join(guardDir,'config'),pluginPath=path.join(configDir,'plugins','agent-dock-guard.js');
 for(const dir of [path.dirname(pluginPath),'home','data','state','cache','xdg-config'].map(dir=>path.isAbsolute(dir)?dir:path.join(guardDir,dir)))await mkdir(dir,{recursive:true,mode:0o700});
 const providerID=providerId(providerDescriptor),nativeModel=modelId(providerDescriptor,model);
 const pluginOptions={policyPath,handshake,providerID,model:nativeModel,baseUrl:providerDescriptor.baseUrl,apiKeyEnv:providerDescriptor.apiKeyEnv};
 await writeFile(path.join(configDir,'package.json'),JSON.stringify({private:true,type:'module'}),{mode:0o600});
 await writeFile(pluginPath,`import {createOpenCodePlugin} from ${JSON.stringify(import.meta.url)};\nexport default createOpenCodePlugin(${JSON.stringify(pluginOptions)});\n`,{mode:0o600});
 const permissions=[{action:'*',resource:'*',effect:'allow'},...refusedTools.map(action=>({action,resource:'*',effect:'deny'})),{action:'external_directory',resource:'*',effect:'deny'}];
 // Local plugins are discovered under config/plugins; plugin IDs here are package specifiers.
 const config={model:`${providerID}/${nativeModel}`,default_agent:'agent-dock',update:'disable',share:'disabled',snapshots:false,formatter:false,lsp:false,websearch:false,warming:false,compaction:{auto:false},permissions,
  agents:{'agent-dock':{mode:'primary',steps,permissions},title:{disabled:true},summary:{disabled:true}},
  providers:{[providerID]:{
   name:'Agent Dock provider',package:providerDescriptor.id==='openrouter'?'@opencode/ai/providers/openrouter':'@opencode/ai/providers/openai-compatible',env:[],
   settings:{apiKey:providerDescriptor.apiKeyEnv?`{env:${providerDescriptor.apiKeyEnv}}`:'local-no-key',baseURL:SENTINEL_BASE_URL,timeout:providerDescriptor.timeoutMs??1_800_000},
   models:{[nativeModel]:{modelID:nativeModel,capabilities:{tools:true},limit:{context:providerDescriptor.contextTokens??98_304,output:providerDescriptor.maxOutputTokens??4096},body:{max_tokens:providerDescriptor.maxOutputTokens??4096,...(providerDescriptor.id==='openrouter'?{usage:{include:true}}:{})}}}
  }},
  experimental:{policies:[{action:'provider.use',resource:'*',effect:'deny'},{action:'provider.use',resource:providerID,effect:'allow'},{action:'tool.use',resource:'*',effect:'deny'},...allowedTools.map(tool=>({action:'tool.use',resource:`${tool}:*`,effect:'allow'}))]}};
 const env={OPENCODE_CONFIG_DIR:configDir,OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FILEWATCHER:'1',XDG_CONFIG_HOME:path.join(guardDir,'xdg-config'),XDG_DATA_HOME:path.join(guardDir,'data'),XDG_STATE_HOME:path.join(guardDir,'state'),XDG_CACHE_HOME:path.join(guardDir,'cache'),HOME:path.join(guardDir,'home'),PWD:policy.workspace};
 // Compatibility discovery is separate from OpenCode config discovery. On
 // Windows os.homedir() uses USERPROFILE, not HOME.
 Object.assign(env,{OPENCODE_DISABLE_EXTERNAL_SKILLS:'1',OPENCODE_DISABLE_CLAUDE_CODE_SKILLS:'1',USERPROFILE:env.HOME});
 return {configDir,pluginPath,policyPath,handshake,providerID,model:nativeModel,env,instructions:instructions(policy)};
}

export async function prepareOpenCodeGuard({stateDir,workspace,providerDescriptor,model,steps,task}){
 const policy=await createPolicy(task??await readJson(path.join(stateDir,'current-task.json')),workspace,{stateDir});
 const root=path.join(path.resolve(stateDir),adapter.stateSubdir),policyPath=path.join(root,'policy.json'),guardDir=path.join(root,'runs',randomUUID());
 await atomicWriteJson(policyPath,policy);
 return install({policy,policyPath,guardDir,providerDescriptor,model,steps});
}

export {readGuardOutcome};
export const adapter={id:'opencode',label:'OpenCode',stateSubdir:'opencode-guard',capabilities:{narrowsToolSchema:true,enumeratesCommands:false,postToolEvents:true,outOfProcessHooks:false,counters:true,editDiscipline:true},install,instructions,toAction,toControl,readRange,patchPaths};
export default adapter;
