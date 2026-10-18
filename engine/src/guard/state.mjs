import path from 'node:path';
import {readFile,open,unlink} from 'node:fs/promises';
import {atomicWriteJson} from '../dashboard-state.mjs';
import {cancelPrefix,LOCK_UNRESOLVED,INVALID_GUARD_POLICY,GUARD_STATE_UNAVAILABLE,INVALID_OUTCOME_POLICY} from './reasons.mjs';

export const readJson = async file => JSON.parse(await readFile(file,'utf8'));
const cancel = (reason,adapter) => adapter ? adapter.toControl({effect:'stop',reason}) : {cancel:true,errorMessage:cancelPrefix('Cline')+reason};

export async function updateGuardPolicy(policyPath,operation,{adapter}={}){
 let lock;
 try{
  // Parallel tool batches share only this attempt's persisted counter.
  for(let attempt=0;attempt<40;attempt++){
   try{lock=await open(policyPath+'.lock','wx');break;}catch(error){if(error.code!=='EEXIST')throw error;await new Promise(resolve=>setTimeout(resolve,25));}
  }
  if(!lock)return cancel(LOCK_UNRESOLVED,adapter);
  const policy=await readJson(policyPath);
  if(policy.version!==1||!Number.isInteger(policy.failedEdits)||!Array.isArray(policy.allowedPaths))throw Error(INVALID_GUARD_POLICY);
  const control=await operation(policy);
  await atomicWriteJson(policyPath,policy);
  return control;
 }catch(error){return cancel(GUARD_STATE_UNAVAILABLE+error.message,adapter);}
 finally{if(lock){await lock.close();await unlink(policyPath+'.lock');}}
}

export async function readGuardOutcome(policyPath){
 const policy=await readJson(policyPath);
 if(policy.version!==1||typeof policy.stopped!=='boolean'||!Number.isInteger(policy.failedEdits))throw Error(INVALID_OUTCOME_POLICY);
 return policy;
}

export async function readWorkerCapabilities(stateDir,subdir='cline-guard'){
 let guard;try{guard=await readJson(path.join(stateDir,subdir,'policy.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
 return {allowedPaths:guard.allowedPaths,approvedCommands:guard.approvedCommands,nativeTools:guard.nativeTools??[],editFailures:guard.editFailures??[],lastRejection:guard.lastRejection??null};
}
