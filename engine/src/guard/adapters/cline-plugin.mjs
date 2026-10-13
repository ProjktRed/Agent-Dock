import {randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {updateGuardPolicy} from '../state.mjs';
import {decide} from '../decide.mjs';
import {MISSING_COMMAND_CHOICES,PLUGIN_UNAVAILABLE,HANDSHAKE_MISSING} from '../reasons.mjs';
import {adapter,allowedTools,toAction,toControl} from './cline.mjs';

// File hooks run before SDK hooks. The handshake enables their soft-command
// exception only after this plugin has narrowed a request for this attempt.
export function createRestrictedToolsPlugin(policyPath){
 let registeredTools=new Set();
 return {name:'automation.restricted-tools',manifest:{capabilities:['hooks']},hooks:{
  async beforeModel({request}){
   const control=await updateGuardPolicy(policyPath,async policy=>{
    if(policy.stopped)return {stop:true,reason:policy.reason};
    if(!Array.isArray(policy.commandChoices)||!policy.commandChoices.length)throw Error(MISSING_COMMAND_CHOICES);
    registeredTools=new Set(request.tools.map(tool=>tool.name));
    const tools=request.tools.filter(tool=>allowedTools.includes(tool.name)).map(tool=>tool.name==='run_commands'?{...tool,inputSchema:{type:'object',properties:{commands:{type:'array',minItems:1,items:{type:'string',enum:policy.commandChoices}}},required:['commands'],additionalProperties:false}}:tool);
    policy.nativeTools=tools.map(tool=>tool.name);
    policy.runtimeReady=true;return {tools};
   },{adapter});
   return control.cancel?{stop:true,reason:control.errorMessage}:control;
  },
  async afterModel({assistantMessage}){
   // Names absent from the SDK registry never reach beforeTool.
   const unknown=assistantMessage.content.filter(part=>part.type==='tool-call'&&!registeredTools.has(part.toolName));
   if(!unknown.length)return;
   const control=await updateGuardPolicy(policyPath,async policy=>{
    if(policy.stopped)return {stop:true,reason:policy.reason};
    for(const part of unknown){
     const action=toAction({hookName:'tool_call',tool_call:{name:part.toolName,input:part.input}});
     const decision=await decide(policy,action,{adapter,mode:'unregistered'});
     if(decision.effect==='stop')return toControl(decision,'plugin');
    }
   },{adapter});
   return control?.cancel?{stop:true,reason:control.errorMessage}:control;
  },
  async beforeTool(context){
   const control=await updateGuardPolicy(policyPath,async policy=>{
    if(policy.stopped)return {stop:true,reason:policy.reason};
    if(!policy.runtimeReady)throw Error(HANDSHAKE_MISSING);
    const action=toAction({hookName:'tool_call',tool_call:{name:context.tool.name,input:context.input,id:context.toolCall?.toolCallId}});
    return toControl(await decide(policy,action,{adapter,mode:'plugin'}),'plugin');
   },{adapter});
   return control?.cancel?{stop:true,reason:control.errorMessage}:control;
  }
 }};
}

export async function verifyRestrictedTools({pluginPath}){
 let plugin;
 try{plugin=(await import(pathToFileURL(pluginPath).href+'?verify='+randomUUID())).default;}
 catch(error){
  const importer=' imported from '+fileURLToPath(import.meta.url);
  if(error.code==='ERR_MODULE_NOT_FOUND'&&error.message.endsWith(importer))error.message=error.message.slice(0,-importer.length)+' imported from '+fileURLToPath(new URL('../../cline-tool-guard.mjs',import.meta.url));
  throw error;
 }
 if(plugin?.name!=='automation.restricted-tools'||typeof plugin.hooks?.beforeModel!=='function'||typeof plugin.hooks?.beforeTool!=='function'||typeof plugin.hooks?.afterModel!=='function')throw Error(PLUGIN_UNAVAILABLE);
}
