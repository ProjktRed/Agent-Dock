import {readFile,appendFile} from 'node:fs/promises';
import {decide} from './decide.mjs';
import {OVERSIZED_HOOK_INPUT} from './reasons.mjs';

/** Decode one stdin event and encode the adapter's decision without owning process exit. */
export async function runHook(adapter,{policyPath,logPath,input,handleEvent}={}){
 if(input===undefined){
  input='';
  if(adapter.capabilities.counters===false)process.stdin.setEncoding('utf8');
  for await(const chunk of process.stdin){
   input+=chunk;
   if(adapter.maxHookInput&&input.length>adapter.maxHookInput){
    return {stdout:JSON.stringify(adapter.toControl({effect:'stop',reason:OVERSIZED_HOOK_INPUT})),exitCode:0};
   }
  }
 }
 if(handleEvent){
  let event;try{event=JSON.parse(input);}catch{event=null;}
  return {stdout:JSON.stringify(await handleEvent(policyPath,event))+'\n',exitCode:0};
 }
 let decision,tool=null;
 try{
  const policy=JSON.parse(await readFile(policyPath,'utf8'));
  const event=JSON.parse(input);
  tool=event.tool_name??null;
  decision=await decide(policy,adapter.toAction(event),{adapter});
 }catch(error){decision={effect:'stop',reason:adapter.reasons.hookError(error)};}
 try{await appendFile(logPath,JSON.stringify({at:new Date().toISOString(),tool,allowed:decision.effect==='allow',reason:decision.reason??null})+'\n');}catch{/* Decision logging remains best effort. */}
 return adapter.toControl(decision);
}
