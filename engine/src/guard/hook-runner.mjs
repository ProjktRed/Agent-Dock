import {readFile,appendFile} from 'node:fs/promises';
import {decide} from './decide.mjs';
import {OVERSIZED_HOOK_INPUT} from './reasons.mjs';
import {askable,askUser,askAllowed} from './ask.mjs';

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
 let decision,tool=null,asked=null;
 try{
  const policy=JSON.parse(await readFile(policyPath,'utf8'));
  const event=JSON.parse(input);
  tool=event.tool_name??null;
  const action=adapter.toAction(event);
  decision=await decide(policy,action,{adapter});
  // Unverified (not certainly protected) and Settings say ask: the app puts it to you; no answer refuses it.
  if(askable(policy,action,decision,adapter)){
   asked=await askUser(policy,action,decision.reason,adapter);
   decision=askAllowed(asked)?{effect:'allow'}:{effect:'stop',reason:`${decision.reason} (${asked==='deny'?'you refused it':'no answer in time'})`};
  }
 }catch(error){decision={effect:'stop',reason:adapter.reasons.hookError(error)};}
 try{await appendFile(logPath,JSON.stringify({at:new Date().toISOString(),tool,allowed:decision.effect==='allow',reason:decision.reason??null,...(asked?{asked}:{})})+'\n');}catch{/* Decision logging remains best effort. */}
 return adapter.toControl(decision);
}
