import {execFile} from 'node:child_process';
import {TUNING} from './engine-tuning.mjs';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,lstat,mkdir,copyFile,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {atomicWriteJson} from './dashboard-state.mjs';
import {collectGitEvidence} from './qa-packet.mjs';
import {recoveryFingerprint,unsafeCauses} from './recovery-policy.mjs';
import {readPendingCodex,runRecoverableCodex} from './node-loop.mjs';
import {parseRecoveryResult} from './codex-worker.mjs';
import {readWorkerCapabilities} from './guard/state.mjs';
import {OPERATIONALLY_RECOVERABLE_PREFIXES} from './guard/reasons.mjs';

const exec=promisify(execFile);
const git=async(workspace,...args)=>(await exec('git',args,{cwd:workspace,windowsHide:true})).stdout.trim();
const read=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const scratchName=p=>typeof p==='string'&&/^(?:fix[\w-]*\.ps1|temp[\w-]*\.(?:txt|ps1)|[\w-]+\.tmp)$/i.test(p);
const hash=data=>createHash('sha256').update(data).digest('hex');
const escapeRegExp=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const isUntracked=async(workspace,p)=>(await git(workspace,'ls-files','--others','--exclude-standard','--',p)).split(/\r?\n/).includes(p);
async function fileHash(workspace,p){
 if(!scratchName(p))return null;
 const file=path.resolve(workspace,p),info=await lstat(file).catch(()=>null);
 if(!info?.isFile()||info.isSymbolicLink()||info.size>1_000_000)return null;
 return hash(await readFile(file));
}
export async function captureScratchBaseline(workspace){
 try{return {runId:randomUUID(),startedAt:new Date().toISOString(),head:await git(workspace,'rev-parse','HEAD'),untracked:(await git(workspace,'ls-files','--others','--exclude-standard')).split(/\r?\n/).filter(Boolean),writes:[]};}
 catch{return null;} // Missing Git evidence means no automatic cleanup, never a guess.
}
export function recordScratchEvent(record,event){
 if(!record)return;
 const paths=event.type==='cline-file-modified'?[event.path]:[];
 if(event.type==='cline-command')for(const command of event.commands??[]){
  for(const match of String(command).matchAll(/(?:Out-File\s+(?:-FilePath\s+)?|(?:Set|Add)-Content\s+(?:-LiteralPath\s+|-Path\s+)?|>\s*)["']?([\w.-]+)/gi))paths.push(match[1]);
 }
 for(const p of paths)if(scratchName(p)&&!record.writes.includes(p)&&record.writes.length<20)record.writes.push(p);
}
export async function finalizeScratchOwnership(workspace,record){
 if(!record)return {files:[]};
 if(await git(workspace,'rev-parse','HEAD')!==record.head)return {files:[]};
 const files=[];
 for(const p of record.writes){
  if(record.untracked.includes(p))continue;
  if(!await isUntracked(workspace,p))continue;
  const sha256=await fileHash(workspace,p);if(sha256)files.push({path:p,sha256,runId:record.runId});
 }
 return {head:record.head,runId:record.runId,startedAt:record.startedAt,files};
}
export function canArchiveScratch({reason,cause,failure,headMatches,unexpectedPaths,verifiedScratch}){
 return headMatches===true&&/Changes outside allowedPaths:/i.test(reason??'')&&!/permission|security|policy|corrupt|malformed|unsafe|unexpected.*HEAD|destructive/i.test([reason,cause,failure?.cause].join(' '))&&unexpectedPaths?.length>0&&unexpectedPaths.every(p=>verifiedScratch.some(x=>x.path===p));
}
export async function loadResolverCase(stateDir){
 const current=await read(path.join(stateDir,'current-task.json')),live=await read(path.join(stateDir,'live.json'));
 const r=current?.automation?.recovery;
 if(!r?.qaPacket||!current?.id||r.version!==1||!r.baselineSha||!Array.isArray(r.correctionHistory))throw Error('Resolver needs valid current task and QA state');
 const {automation,...task}=current;
 const workspace=live?.workspace;
 const evidence=await collectGitEvidence({workspace,task,baselineSha:r.baselineSha});
 const headMatches=(await git(workspace,'rev-parse','HEAD'))===r.baselineSha;
 const verifiedScratch=[];
 for(const p of evidence.scope.unexpectedPaths){
  const proof=r.scratchOwnership?.files?.find(x=>x.path===p);
  if(!proof||r.scratchOwnership.head!==r.baselineSha||proof.runId!==r.scratchOwnership.runId)continue;
  if(!await isUntracked(workspace,p))continue;
  if(await fileHash(workspace,p)===proof.sha256)verifiedScratch.push(proof);
 }
 const workerCapabilities=await readWorkerCapabilities(stateDir);
 const input={task,qaPacket:r.qaPacket,latestQaVerdict:r.failure??null,currentDiff:evidence.diff,failure:{reason:r.blockedReason??live?.blockedReason,cause:r.failure?.manualReviewCause??null},baselineSha:r.baselineSha,headMatches,unexpectedPaths:evidence.scope.unexpectedPaths,verifiedScratch,correctionHistory:r.correctionHistory,
  workerCapabilities,
  previousResolverStrategies:r.resolverRecoveries??[]};
 input.fingerprint=recoveryFingerprint(input);
 return input;
}
export function canRecoverOperational(input){
 const labelAlternation=['Cline'];
 const labelPattern=labelAlternation.length===1?escapeRegExp(labelAlternation[0]):`(?:${labelAlternation.map(escapeRegExp).join('|')})`;
 return input.headMatches===true&&input.unexpectedPaths?.length===0&&input.currentDiff?.truncated!==true&&!unsafeCauses.has(input.failure?.cause)&&
  new RegExp(`^${labelPattern} editing guard stopped attempt: (?:${OPERATIONALLY_RECOVERABLE_PREFIXES.map(escapeRegExp).join('|')})`).test(input.failure?.reason??'');
}
export function resolverAvailability({live,input}){
 if(live?.stage!=='BLOCKED'||!input?.task||!input?.qaPacket)return{available:false,reason:'No complete blocked case'};
 if(live.clineStatus==='running'||live.qaStatus==='running'||live.activeReasoningRole||live.elevateRunning||live.resolverRunning||live.codexOperation?.status==='running')return{available:false,reason:'A worker is active'};
 if(live.resolverUsedForFingerprint===input.fingerprint)return{available:false,reason:'This unchanged block was already resolved/reviewed'};
 return{available:true,reason:null};
}
export async function runBlockedResolver({workspace,stateDir,codex,readControl,onEvent,pollMs=1000,pendingCodex=null,automatic=false}){
 const current=await read(path.join(stateDir,'current-task.json')),r=current?.automation?.recovery;
 if(!r)return{status:'blocked'};
 const pending=pendingCodex??await readPendingCodex(stateDir);
 const journal=r.resolverJournal;
 const input=pending?.operation==='resolver'?pending.inputs:journal?.status==='applying'?journal.input:await loadResolverCase(stateDir);
 const live=await read(path.join(stateDir,'live.json'));
 if(journal?.status!=='applying'&&pending?.operation!=='resolver'&&!resolverAvailability({live,input}).available)return{status:'blocked'};
 const safe=canArchiveScratch({reason:input.failure.reason,...input});
 const control=await readControl();
 if(control.stopAfterSafePoint)return{status:'stopped'};
 if(automatic&&control.pauseAfterCurrent)return{status:'paused'};
 if(journal?.status!=='applying'&&(r.resolverRecoveries?.length??0)>=TUNING.resolverMaxStrategies){await onEvent({type:'resolver-limit',message:TUNING.resolverMaxStrategies===3?'Three Resolver recovery strategies exhausted; human review required.':`Resolver recovery limit (${TUNING.resolverMaxStrategies}) exhausted; human review required.`});return{status:'blocked'};}
 const save=()=>atomicWriteJson(path.join(stateDir,'current-task.json'),current);
 let op;
 try{
  await codex.assertIdle?.();
  op=journal?.status==='applying'?{result:journal.result,operationId:journal.operationId}:await runRecoverableCodex({stateDir,operation:'resolver',inputs:input,context:{automatic},invoke:x=>codex.resolveBlocked(x),emit:(type,fields)=>onEvent({type,...fields}),readControl,pollMs,pending:pending?.operation==='resolver'?pending:null});
  if(op.stopped)return{status:'stopped'};
  await codex.assertIdle?.(); // Confirm exited/persisted PID reconciled before any mutation or Cline.
  const finalControl=await readControl();
  if(finalControl.stopAfterSafePoint)return{status:'stopped'};
  if(automatic&&finalControl.pauseAfterCurrent)return{status:'paused'};
  r.resolverResult=op.result;
  const decision=parseRecoveryResult(JSON.stringify(op.result));
  const strategy=recoveryFingerprint({strategy:decision.newStrategy.trim().toLowerCase().replace(/\s+/g,' '),instructions:decision.nextWorkerInstructions.trim().toLowerCase().replace(/\s+/g,' ')});
  const duplicate=(r.resolverRecoveries??[]).some(entry=>entry.strategy===strategy);
  if(canRecoverOperational(input)&&['correction','strategy-revised'].includes(decision.status)&&!duplicate){
   // Model advice never grants scope/permission. Recheck independent evidence after Sol exits.
   const evidence=await collectGitEvidence({workspace,task:input.task,baselineSha:r.baselineSha});
   if(evidence.scope.status!=='PASS'||evidence.diff.truncated||await git(workspace,'rev-parse','HEAD')!==r.baselineSha||evidence.diff.text!==input.currentDiff.text)throw Error('Scope/HEAD/diff changed during Resolver');
   r.qaPacket={...r.qaPacket,diff:evidence.diff,changedFiles:evidence.changedFiles,qaEvidence:{...r.qaPacket.qaEvidence,scope:evidence.scope,categories:{...r.qaPacket.qaEvidence.categories,scopeCheck:'PASS'}}};
   r.failure={status:'fail',output:'Rejected tool was not executed. Resolver recovery: '+decision.newStrategy+'\n'+decision.nextWorkerInstructions+'\nOriginal QA findings remain mandatory: '+(input.latestQaVerdict?.output??''),manualReviewCause:null};
   r.phase='correction-assessment';r.blockedReason=null;r.userAttention=true;r.resolverCapabilities=input.workerCapabilities;
   (r.resolverRecoveries??=[]).push({fingerprint:input.fingerprint,strategy,recommendation:decision.nextWorkerInstructions.slice(0,2000)});
   r.resolverUsedForFingerprint=input.fingerprint;r.lastAppliedOperationId=op.operationId;await save();
   await atomicWriteJson(path.join(stateDir,'qa-packet.json'),r.qaPacket);
   await onEvent({type:'resolver-result',fingerprint:input.fingerprint,result:decision,ready:true});
   await onEvent({type:'recovery-state',recovery:{phase:r.phase,blockedReason:null,resolverResult:decision},consumeCodexResult:true});
   return{status:'ready',recovery:r};
  }
  if(safe&&['correction','strategy-revised'].includes(decision.status)&&!duplicate){
   const outside=path.relative(workspace,stateDir);if(!outside.startsWith('..')&&!path.isAbsolute(outside))throw Error('Scratch archive must be outside target repository');
   const entries=journal?.status==='applying'?journal.entries:input.verifiedScratch.map(f=>({...f,destination:path.join(stateDir,'resolver-archive',op.operationId,f.path)}));
   if(!/^[\w-]+$/.test(op.operationId)||!Array.isArray(entries)||entries.length!==input.verifiedScratch.length||new Set(entries.map(e=>e.path)).size!==entries.length)throw Error('Malformed Resolver preservation journal');
   for(const entry of entries){
    const proof=input.verifiedScratch.find(f=>f.path===entry.path);
    if(!scratchName(entry.path)||!proof||proof.sha256!==entry.sha256||entry.destination!==path.join(stateDir,'resolver-archive',op.operationId,entry.path))throw Error('Malformed Resolver preservation journal');
   }
   r.resolverJournal={status:'applying',input,result:decision,operationId:op.operationId,entries};await save();
   if(await git(workspace,'rev-parse','HEAD')!==r.baselineSha)throw Error('Unexpected HEAD before preservation');
   for(const entry of entries){
    const source=path.join(workspace,entry.path),sourceHash=await fileHash(workspace,entry.path);
    if(sourceHash===null){if(hash(await readFile(entry.destination))!==entry.sha256)throw Error('Cannot reconcile scratch archive');continue;}
    if(sourceHash!==entry.sha256)throw Error('Scratch changed after ownership verification');
    if(!await isUntracked(workspace,entry.path))throw Error('Scratch is no longer untracked');
    await mkdir(path.dirname(entry.destination),{recursive:true});
    try{await copyFile(source,entry.destination,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
    if(hash(await readFile(entry.destination))!==entry.sha256||await fileHash(workspace,entry.path)!==entry.sha256)throw Error('Archive hash verification failed');
    await unlink(source); // Only explicitly verified orchestrator-preserved scratch; never a recursive cleanup.
   }
   const evidence=await collectGitEvidence({workspace,task:input.task,baselineSha:r.baselineSha});if(evidence.scope.status!=='PASS')throw Error(evidence.scope.message);
   r.qaPacket={...r.qaPacket,diff:evidence.diff,changedFiles:evidence.changedFiles,qaEvidence:{...r.qaPacket.qaEvidence,scope:evidence.scope,categories:{...r.qaPacket.qaEvidence.categories,scopeCheck:'PASS'}}};
   r.failure={status:'fail',output:'Verified scratch files preserved outside repository. Resolver recommendation: '+decision.nextWorkerInstructions,manualReviewCause:null};
   r.phase='correction-assessment';r.blockedReason=null;r.userAttention=true;r.resolverJournal.status='completed';
   if(!(r.resolverRecoveries??=[]).some(entry=>entry.fingerprint===input.fingerprint))r.resolverRecoveries.push({fingerprint:input.fingerprint,strategy,recommendation:decision.nextWorkerInstructions.slice(0,2000)});
   r.resolverUsedForFingerprint=input.fingerprint;r.lastAppliedOperationId=op.operationId;await save();
   await atomicWriteJson(path.join(stateDir,'qa-packet.json'),r.qaPacket);
   await onEvent({type:'resolver-result',fingerprint:input.fingerprint,result:decision,ready:true,archived:entries.map(e=>e.path)});
   await onEvent({type:'recovery-state',recovery:{phase:r.phase,blockedReason:null,resolverResult:decision},consumeCodexResult:true});
   return{status:'ready',recovery:r,archived:entries};
  }
  r.phase='blocked';r.resolverUsedForFingerprint=input.fingerprint;r.lastAppliedOperationId=op.operationId;await save();
  await onEvent({type:'resolver-result',fingerprint:input.fingerprint,result:{...decision,failureReason:duplicate?'Repeated recovery strategy; human review required.':safe?decision.failureReason:'No provably safe automatic recovery. '+(decision.failureReason??'')},ready:false});
  await onEvent({type:'recovery-state',recovery:{phase:'blocked'},consumeCodexResult:true});
  return{status:'blocked'};
 }catch(error){
  await onEvent({type:'resolver-error',message:error.message});throw error;
 }
}
