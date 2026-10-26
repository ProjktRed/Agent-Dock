import {approvedPath,approvedCommand,unsafeCommand} from './policy.mjs';
import {failedResult} from './action.mjs';
import {protectedActionReason} from './protected-paths.mjs';
import {rememberRead,checkSmallEdit,rememberEditFailure,nativeError} from './edit-discipline.mjs';
import {cancelPrefix,COMMAND_NOT_APPROVED,UNKNOWN_TOOL,TWO_EDIT_FAILURES,HANDSHAKE_MISSING,COMMAND_SAFETY_FAILED,UNSAFE_COMMAND,UNAPPROVED_TOOL_PATH,SOFT_REJECT,THREE_INVALID_REQUESTS,MISSING_TOOL_INPUT,EDIT_PATH_OUTSIDE,PATCH_PATHS_NOT_EXPLICIT,PATCH_PATH_OUTSIDE} from './reasons.mjs';

const allow = () => ({effect:'allow'});
const stop = reason => ({effect:'stop',reason});

export function rememberRejection(policy,action,strict=false){
 const input=action.input;
 policy.lastRejection={tool:action.tool,path:typeof input?.path==='string'?input.path.slice(0,500):null,commands:(action.commandEvidence??action.kind==='command')?(strict?JSON.stringify(input).slice(0,1500):JSON.stringify(input)?.slice(0,1500)):null};
}

export function recordHookDecision(policy,decision,action){
 if(decision.effect==='stop'){
  policy.stopped=true;policy.reason=decision.reason;
  if(action.hasTool)rememberRejection(policy,action,true);
 }
 return decision;
}

function hardStop(policy,reason,action){policy.stopped=true;policy.reason=reason;rememberRejection(policy,action);return stop(reason);}
function rejectTool(policy,action){
 policy.invalidToolCalls=(policy.invalidToolCalls??0)+1;rememberRejection(policy,action);
 return policy.invalidToolCalls>=3?hardStop(policy,THREE_INVALID_REQUESTS,action):{effect:'reject',reason:SOFT_REJECT};
}

function decideStateless(policy,action,adapter){
 adapter.validatePolicy?.(policy);
 if(action.kind==='edit'){
  if(!action.patch)return stop(adapter.reasons.editMustBePatch);
  if(!action.paths.length)return stop(adapter.reasons.patchNoFiles);
  const outside=action.paths.filter(file=>!adapter.approvedPath(policy,file,action.cwd));
  return outside.length?stop(adapter.reasons.patchOutside(policy,outside)):allow();
 }
 if(action.kind==='command'){
  if(!policy.toolGuard)return allow();
  return action.commands.every(command=>adapter.approvedCommand(policy,command))?allow():stop(adapter.reasons.commandNotApproved(policy));
 }
 return policy.toolGuard&&action.kind==='unknown'?stop(typeof adapter.reasons.unknownTool==='function'?adapter.reasons.unknownTool(policy):adapter.reasons.unknownTool):allow();
}

/** Stateless adapters stay synchronous; stateful decisions may resolve paths. */
export function decide(policy,action,{adapter,mode='hook'}={}){
 // Web search and page fetch: only with web access on (never for QA), and only web addresses.
 if(action.kind==='web'){
  const url=action.input?.url;
  return policy.webAccess===true&&(url===undefined||/^https?:\/\//i.test(String(url)))?allow():stop('Web access for agents is off (Settings › Execution & safety)');
 }
 // Cline's narrowed SDK never executes unknown tools or non-enumerated commands.
 // Keep its retry/counter protocol; its plugin is the final gate after the file hook.
 const sdkRejected=adapter?.id==='cline'&&policy.runtimeReady&&(
   mode==='unregistered'||action.kind==='unknown'||
   action.kind==='command'&&!adapter.validCommandInput(policy,action.input)&&!unsafeCommand(JSON.stringify(action.input)??''));
 if(sdkRejected)return decideStateful(policy,action,adapter,mode);
 const protection=protectedActionReason(policy,action);
 if(protection)return adapter?.capabilities.counters===false?stop(protection):hardStop(policy,protection,action);
 if(policy.protectionOnly)return allow();
 if(adapter?.capabilities.counters===false)return decideStateless(policy,action,adapter);
 return decideStateful(policy,action,adapter,mode);
}

async function inspectAction(policy,action){
 if(policy.stopped)return stop(policy.reason);
 if(action.error)return stop(action.error);
 if(action.input==null)return stop(MISSING_TOOL_INPUT);
 if(action.kind==='edit'){
  if(!action.patch)return await approvedPath(policy,action.input.path)?allow():stop(EDIT_PATH_OUTSIDE);
  if(!action.paths.length)return stop(PATCH_PATHS_NOT_EXPLICIT);
  for(const file of action.paths)if(!await approvedPath(policy,file))return stop(PATCH_PATH_OUTSIDE);
  return allow();
 }
 if(action.kind==='command'){
  if(action.commands.length>0){let approved=true;for(const command of action.commands)if(!await approvedCommand(policy,command)){approved=false;break;}if(approved)return allow();}
  if(policy.runtimeReady&&!unsafeCommand(JSON.stringify(action.input)))return allow();
  return stop(COMMAND_NOT_APPROVED);
 }
 if(action.kind==='read'||action.kind==='inspect')return allow();
 if(policy.runtimeReady&&!(typeof action.input?.path==='string'&&!await approvedPath(policy,action.input.path)))return allow();
 return stop(UNKNOWN_TOOL+action.tool);
}

async function decideStateful(policy,action,adapter,mode){
 if(policy.stopped)return stop(policy.reason);
 if(mode==='unregistered')return rejectTool(policy,action);
 if(mode!=='plugin')return inspectAction(policy,action);
 if(!policy.runtimeReady)throw Error(HANDSHAKE_MISSING);
 if(action.kind==='command'){
  if(adapter.validCommandInput(policy,action.input)){
   for(const command of action.commands)if(!await approvedCommand(policy,command))return hardStop(policy,COMMAND_SAFETY_FAILED,action);
   return allow();
  }
  if(unsafeCommand(JSON.stringify(action.input)??''))return hardStop(policy,UNSAFE_COMMAND,action);
  return rejectTool(policy,action);
 }
 if(action.kind==='unknown'){
  if(typeof action.input?.path==='string'&&!await approvedPath(policy,action.input.path))return hardStop(policy,UNAPPROVED_TOOL_PATH,action);
  return rejectTool(policy,action);
 }
 const checked=await inspectAction(policy,action);
 if(checked.effect==='stop')return hardStop(policy,cancelPrefix(adapter.label)+checked.reason,action);
 if(action.kind==='edit'&&adapter.capabilities.editDiscipline){
  const reason=await checkSmallEdit(policy,action,adapter);
  if(reason){
   await rememberEditFailure(policy,{name:action.tool,input:action.input,id:action.id},reason,'before-execution');
   policy.failedEdits++;
   return policy.failedEdits>=2?hardStop(policy,TWO_EDIT_FAILURES,action):{effect:'reject',reason};
  }
 }
 return allow();
}

export async function observe(policy,action,{adapter,success}={}){
 if(policy.stopped)return stop(policy.reason);
 if(action.error)return stop(action.error);
 if(action.kind==='read'&&!failedResult(action.output))await rememberRead(policy,{input:action.input,output:action.output},approvedPath,adapter);
 if(action.kind==='edit'){
  if(action.id&&(policy.editFailures??[]).some(e=>e.id===action.id&&e.stage==='before-execution'))return allow();
  const failed=success===false||failedResult(action.output);
  if(failed)await rememberEditFailure(policy,{name:action.tool,input:action.input,id:action.id},nativeError(action.output));
  policy.failedEdits=failed?policy.failedEdits+1:0;
  if(policy.failedEdits>=2)return stop(TWO_EDIT_FAILURES);
 }
 return allow();
}
