import {readFile,appendFile} from 'node:fs/promises';
import {decide} from './decide.mjs';
import {OVERSIZED_HOOK_INPUT} from './reasons.mjs';
import {askable,askUser,askAllowed,definitelyRefused} from './ask.mjs';
import {sendDecision,inputDigest} from './decision-log.mjs';
import {typedAction} from './typed-action.mjs';
import {webAddressResolvesPrivate} from '../web-access.mjs';
import {redactText} from '../redact.mjs';

/** Decode one stdin event and encode the adapter's decision without owning process exit. */
export async function runHook(adapter,{policyPath,logPath,input,handleEvent}={}){
 if(input===undefined){
  input='';
  if(adapter.capabilities.counters===false)process.stdin.setEncoding('utf8');
  for await(const chunk of process.stdin){
   input+=chunk;
   if(adapter.maxHookInput&&input.length>adapter.maxHookInput){
    // Codex and Claude Code encode their own exit code and output; Cline's guard returns a plain object.
    const control=adapter.toControl({effect:'stop',reason:OVERSIZED_HOOK_INPUT});
    return typeof control?.exitCode==='number'?control:{stdout:JSON.stringify(control),exitCode:0};
   }
  }
 }
 if(handleEvent){
  let event;try{event=JSON.parse(input);}catch{event=null;}
  return {stdout:JSON.stringify(await handleEvent(policyPath,event))+'\n',exitCode:0};
 }
 let decision,tool=null,asked=null,decisionLog=null,event=null,action=null,corpus=null;
 try{
  const policyText=await readFile(policyPath,'utf8'),policy=JSON.parse(policyText);
  decisionLog=policy.decisionLog??null;corpus=typeof policy.corpus==='string'?policy.corpus:null;
  event=JSON.parse(input);
  tool=event.tool_name??null;
  action=adapter.toAction(event);
  decision=await decide(policy,action,{adapter});
  // A fetch the address rules allow: its name must not resolve to this computer or a private network (stage 10).
  if(action.kind==='web'&&decision.effect==='allow'&&typeof action.input?.url==='string'){
   const problem=await webAddressResolvesPrivate(action.input.url);
   if(problem)decision={effect:'stop',reason:`Web fetch refused: ${problem}`};
  }
  // Unverified (not certainly protected) and Settings say ask: the app puts it to you; no answer refuses it.
  if(askable(policy,action,decision,adapter)){
   asked=await askUser(policy,action,decision.reason,adapter);
   if(!askAllowed(asked))decision={effect:'stop',reason:`${decision.reason} (${asked==='deny'?'you refused it':'no answer in time'})`};
   else{
    // Your yes covers the action as it was asked: re-checked against the policy as it is now, it still has to be
    // one that may be asked about at all (a policy rewritten while you decided, or a path that now resolves
    // somewhere protected, refuses it).
    const current=await readFile(policyPath,'utf8');
    decision=current!==policyText?{effect:'stop',reason:`${decision.reason} (the policy changed while you were asked)`}
     :definitelyRefused(JSON.parse(current),action)?{effect:'stop',reason:`${decision.reason} (it now names a protected path)`}:{effect:'allow'};
   }
  }
 }catch(error){decision={effect:'stop',reason:adapter.reasons.hookError(error)};}
 // Stage 1 shadow: the typed record of the call (decides nothing; recorded next to today's decision).
 let typed=null;try{typed=action?typedAction(adapter.id,action):null;}catch{typed=null;}
 // Guard plan stage 1: the engine records the decision before the call may run; no acknowledgement refuses it.
 if(decisionLog){
  const recorded=await sendDecision(decisionLog,{tool,kind:action?.kind??null,effect:decision.effect,reason:decision.reason??null,inputDigest:inputDigest(event?.tool_input),callId:event?.tool_use_id??event?.call_id??null,asked,class:typed?.class??null,agrees:typed?.agrees??null,parseComplete:typed?.parseComplete??null}).catch(()=>false);
  if(!recorded&&decision.effect==='allow')decision={effect:'stop',reason:'Agent Dock could not record this decision (its engine did not answer), so the call is refused'};
 }
 // Opt-in corpus (AGENT_DOCK_GUARD_CORPUS=1): the call itself, redacted and cut to 8 KB, for replaying old and new
 // guard against real calls (stage 5). Best effort, like the hook log.
 if(corpus&&event)try{await appendFile(corpus,JSON.stringify({adapter:adapter.id,tool,input:redactText(JSON.stringify(event.tool_input??null)??'null').slice(0,8192),cwd:typeof event.cwd==='string'?event.cwd:null,typed:typed&&JSON.parse(redactText(JSON.stringify(typed))),effect:decision.effect,reason:decision.reason??null})+'\n');}catch{/* best effort */}
 try{await appendFile(logPath,JSON.stringify({at:new Date().toISOString(),tool,allowed:decision.effect==='allow',reason:decision.reason??null,...(asked?{asked}:{})})+'\n');}catch{/* Decision logging remains best effort. */}
 return adapter.toControl(decision);
}
