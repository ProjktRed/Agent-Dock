import path from 'node:path';
import {appendFile,readFile,rm} from 'node:fs/promises';
import {readWorkerCapabilities} from './guard/state.mjs';
import {randomUUID} from 'node:crypto';
import {atomicWriteJson} from './dashboard-state.mjs';
import {captureGitBaseline} from './qa-runner.mjs';
import {prepareQaPacket,collectGitEvidence,classifyQaCommand,assertQaPacketFresh} from './qa-packet.mjs';
import {buildInitialPrompt,buildCorrectionPrompt,describeAllowedPaths} from './workflow.mjs';
import {readPendingCodex,runRecoverableCodex,validateTask,verifyReview} from './node-loop.mjs';
import {ELEVATE_MODEL} from './codex-worker.mjs';
import {compactCorrections,correctionInstructions,correctionText,packetForPrompt,qaEnvironmentFailure,qaRetryAvailability,recoveryClassification,recoveryFingerprint} from './recovery-policy.mjs';
import {selectKnowledge,recordVerifiedIssue} from './worker-knowledge.mjs';
import {captureScratchBaseline,recordScratchEvent,finalizeScratchOwnership,loadResolverCase,runBlockedResolver} from './blocked-resolver.mjs';
import {TUNING} from './engine-tuning.mjs';
import {gateFailureText,roleGuidanceText} from './workflow-roles.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const compactWorkerResult=value=>({exitCode:value.exitCode,runResult:{finishReason:value.runResult?.finishReason??null,text:String(value.summary??value.runResult?.summary??value.runResult?.text??'No structured summary provided.').slice(0,2000)}});

// All recovery progress belongs to the existing current-task.json record. A model
// result is checkpointed here before its completed-operation receipt is consumed.
export async function runNodeLoop({workspace,stateDir,objective,initialTask,codex,worker,
  assess=input=>codex.assess(input),review=async(input,context)=>{await assertQaPacketFresh(workspace,input);return codex.review(input,context);},
  assessCorrection=input=>codex.assessCorrection(input),
  reassessManualReview=input=>codex.reassessManualReview(input),elevate=reassessManualReview,
  solReassessmentEnabled=true,baseline=()=>captureGitBaseline(workspace),verify=verifyReview,
  prepareQa=input=>prepareQaPacket({workspace,stateDir,...input}),
  reconcile=async(task,sha)=>{const evidence=await collectGitEvidence({workspace,task,baselineSha:sha});if(evidence.scope.status!=='PASS')throw new Error('Cannot reconcile scope/HEAD: '+evidence.scope.message);},
  readControl,onEvent,onTask=async()=>{},pollMs=1000,pendingCodex=null,correctionResume=null,stopAfterTask=false,manualElevation=false,manualResolver=false,
  knowledgeFile,roles=[],runRole=null,
}) {
  const emit=(type,fields={})=>onEvent({type,...fields});
  const stageRoles=stage=>runRole?roles.filter(role=>role.stage===stage):[];
  if((await readControl()).stopAfterSafePoint){await emit('stopped');return{status:'stopped'};}
  knowledgeFile ??= path.resolve(stateDir,'..','LOCAL_WORKER_ISSUES.md');
  const file=path.join(stateDir,'current-task.json');
  let saved=await read(file), pending=pendingCodex??await readPendingCodex(stateDir);
  // A completed Assessment receipt is replayed so a crash never repeats work, but one that produced
  // no task has nothing to resume: replaying it only repeats the old verdict, and Retry would never
  // run a fresh Assessment. Consume it instead.
  const consumeAssessment=async()=>{await rm(path.join(stateDir,'pending-codex.json'),{force:true});await emit('codex-operation-consumed');};
  if(pending?.operation==='assessment'&&pending.status==='completed'&&!['task','done'].includes(pending.result?.status)){await consumeAssessment();pending=null;}
  let task=pending?(pending.operation==='assessment'?null:pending.context?.task??pending.inputs?.task):initialTask??correctionResume?.task;
  let r=saved?.automation?.recovery;
  const suppliedTaskChanged=r&&task&&task.id===saved.id&&recoveryFingerprint(task)!==recoveryFingerprint(Object.fromEntries(Object.entries(saved).filter(([k])=>k!=='automation')));
  if(r && (!task || task.id===saved.id)) task=Object.fromEntries(Object.entries(saved).filter(([k])=>k!=='automation'));
  else r=null;
  let previous;
  const save=async(consumeCodexResult=false)=>{
    await atomicWriteJson(file,{...task,automation:{...(saved?.id===task.id?saved.automation:{}),recovery:r}});
    await emit('recovery-state',{recovery:{correctionCount:r.correctionCount,correctionHistory:r.correctionHistory,assessmentResult:r.assessmentResult,currentCorrection:r.currentCorrection,elevateResult:r.elevateResult,resolverResult:r.resolverResult,userAttention:r.userAttention,userAttentionReason:r.failure?.output,phase:r.phase},consumeCodexResult});
  };
  let exclusiveHeld=false;
  const resolveExclusive=async options=>(await worker.withExclusive(()=>runBlockedResolver({workspace,stateDir,codex,readControl,onEvent,pollMs,...options})))??{status:'blocked'};
  const block=async reason=>{
    if(r){r.phase='blocked';r.blockedReason=reason;await save();}await emit('blocked',{qa:reason});
    if(r&&!exclusiveHeld){
      const input=await loadResolverCase(stateDir).catch(()=>null);
      if(input){
        const result=await resolveExclusive({automatic:true});
        if(result.status==='ready'){r=result.recovery;return{status:'resolver-ready'};}
        if(['stopped','paused'].includes(result.status))return result;
      }
    }
    return{status:'blocked',output:reason};
  };
  const stopped=async()=>{if(!(await readControl()).stopAfterSafePoint)return false;await emit('stopped');return true;};
  const operation=async(type,inputs,invoke,extra={})=>{
    const resume=pending?.operation===type?pending:null;
    const result=await runRecoverableCodex({stateDir,operation:type,inputs:JSON.parse(JSON.stringify(resume?.inputs??inputs)),
      context:JSON.parse(JSON.stringify(resume?.context??{task,recovery:r,stopAfterTask,...extra})),invoke,emit,readControl,pollMs,pending:resume});
    if(!result.stopped)pending=null;
    return result;
  };
  // Workflow roles run read-only through the orchestrator lock. Each result is checkpointed in the
  // recovery record, so a resumed run never repeats a finished role. An advisory role that fails to
  // run is recorded and skipped; a gate that cannot run blocks (the change would go unreviewed).
  const runStageRoles=async(stage,input,suffix='')=>{
    const results=[];
    for(const role of stageRoles(stage)){
      const key=`${stage}:${role.id}${suffix}`;
      r.roleResults??={};
      const evidenceFingerprint=stage==='before-qa'?recoveryFingerprint({task:input.task,attempt:input.attempt,baselineSha:input.baselineSha,diff:input.diff,qaEvidence:input.qaEvidence?.fingerprint??input.qaEvidence}):null;
      if(stage==='before-qa'&&r.roleResults[key]?.evidenceFingerprint!==evidenceFingerprint)delete r.roleResults[key];
      if(!r.roleResults[key]){
        let op;
        try{op=await operation('role:'+role.id,input,async value=>{if(stage==='before-qa')await assertQaPacketFresh(workspace,value);return runRole(role,value);},{roleName:role.name,roleStage:stage,roleModel:role.model});}
        catch(error){
          if(role.gate)throw new Error(`Workflow role ${role.name} could not run: ${error.message}`);
          await emit('role-error',{roleId:role.id,roleName:role.name,stage,message:error.message});
          r.roleResults[key]={error:error.message,evidenceFingerprint};await save();continue;
        }
        if(op.stopped)return{stopped:true};
        r.roleResults[key]={result:op.result,evidenceFingerprint};r.lastAppliedOperationId=op.operationId;await save(true);
        await emit('role-result',{roleId:role.id,roleName:role.name,stage,verdict:op.result.verdict,summary:op.result.summary,findings:op.result.findings});
      }
      if(r.roleResults[key].result)results.push({id:role.id,name:role.name,gate:role.gate,result:r.roleResults[key].result});
    }
    return{results};
  };
  try {
    if(suppliedTaskChanged)return block('Cannot reconcile changed task definition with existing recovery');
    // Legacy review migration never repeats completed implementation. Recover the
    // existing packet/baseline and classify its failure before any launch.
    if(!r && !initialTask && !correctionResume && saved && !pending) {
      const last=await read(path.join(stateDir,'last-result.json')),packet=await read(path.join(stateDir,'qa-packet.json'));
      if(last?.task?.id===saved.id && packet?.task?.id===saved.id && last.result?.qa?.status!=='pass') {
        task=Object.fromEntries(Object.entries(saved).filter(([k])=>k!=='automation'));
        r={version:1,baselineSha:packet.baselineSha,attempt:packet.attempt,phase:'decision',qaPacket:packet,
          failure:last.result.qa,history:last.result.history??[],correctionCount:0,correctionHistory:[],elevations:[],lastElevationCount:0,userAttention:true};
      } else if(last?.result?.qa?.status!=='pass') return block('Cannot reconcile legacy task with its QA packet and baseline');
    }
    if(r) {
      validateTask(task);
      if(r.version!==1 || !r.baselineSha || !Number.isInteger(r.correctionCount) || !Array.isArray(r.correctionHistory)) return block('Malformed recovery state');
      // Retry QA (the user fixed what stopped QA): collect fresh evidence for the same finished
      // attempt and review it again. HEAD and scope are reconciled below before QA runs.
      const retryControl=await readControl();
      if(r.phase==='blocked'&&Number(retryControl.qaRetryGeneration??0)>Number(r.qaRetryGeneration??0)&&qaRetryAvailability(r).available){
        r.qaRetryGeneration=Number(retryControl.qaRetryGeneration);r.phase='evidence';r.blockedReason=null;r.forceFreshQa=true;
        await save();await emit('qa-retry',{attempt:r.attempt});
      }
      if(r.phase==='blocked'){
        const result=await resolveExclusive({pendingCodex:pending,automatic:!manualResolver});
        if(result.status!=='ready')return result;
        r=result.recovery;pending=null;
      }
      if(r.phase==='blocked') return block(r.blockedReason??'Recovery is blocked');
      if(r.phase==='worker-launching'||r.phase==='worker-running') return block('Cannot reconcile interrupted local worker; implementation must not be replayed');
      if(!['worker','evidence','review','qa','decision','correction-assessment','elevation','passed'].includes(r.phase))return block('Malformed recovery phase');
      const completedPass=(pending?.operation==='qa'&&pending.status==='completed'&&pending.result?.status==='pass')?pending.result:(r.phase==='decision'&&r.failure?.status==='pass'?r.failure:null);
      if(completedPass)await verify({workspace,baselineHead:r.baselineSha,decision:completedPass,task});
      else if(r.phase!=='passed') await reconcile(task,r.baselineSha);
      if(pending?.status==='completed'&&pending.operationId===r.lastAppliedOperationId) {
        await save(true);await rm(path.join(stateDir,'pending-codex.json'),{force:true});pending=null;
      }
      stopAfterTask ||= pending?.context?.stopAfterTask===true || r.stopAfterTask===true;
      if(manualElevation) {
        if(!r.failure || recoveryClassification(r.failure)==='blocked')return block('Unsafe case cannot be elevated');
        const fingerprint=recoveryFingerprint({task,baseline:r.baselineSha,diff:r.qaPacket.diff,failure:r.failure,corrections:r.correctionHistory});
        if(r.elevations.includes(fingerprint))return block('This unchanged failure has already been elevated');
        r.elevationFingerprint=fingerprint;
        r.phase='elevation';r.elevationAutomatic=false;
      }
      await save();
    }
    for(;;) {
      if(await stopped())return{status:'stopped'};
      if(!r && (await readControl()).pauseAfterCurrent) {
        await emit('paused');while((await readControl()).pauseAfterCurrent){if(await stopped())return{status:'stopped'};await sleep(pollMs);}
      }
      let result;
      try {result=await worker.withExclusive(async()=>{
        exclusiveHeld=true;
        try {
        if(await stopped())return{status:'stopped'};
        if(!r) {
          const sha=correctionResume?.baselineSha??pending?.inputs?.baselineSha??pending?.inputs?.baselineHead??pending?.context?.baselineHead??(await baseline()).head;
          let assessmentOperationId;
          if(!task) {
            const op=await operation('assessment',{objective,previous},assess,{baselineHead:sha});if(op.stopped)return{status:'stopped'};
            if(op.result.status==='done'){await emit('loop-complete');return{status:'done'};}
            if(op.result.status!=='task'){await consumeAssessment();return block(op.result.output??'Assessment could not produce a safe task');}
            task=op.result.task;if((await baseline()).head!==sha)return block('Unexpected baseline HEAD after assessment');
            assessmentOperationId=op.operationId;
          }
          validateTask(task);
          const resumeQa=pending?.operation==='qa';
          r={version:1,baselineSha:sha,attempt:correctionResume?.attempt??pending?.attempt??1,phase:resumeQa?'qa':'worker',
            prompt:correctionResume?.prompt??buildInitialPrompt(task,{workspace}),history:correctionResume?.history??pending?.context?.history??[],
            correctionCount:0,correctionHistory:[],elevations:[],lastElevationCount:0,userAttention:false,lastAppliedOperationId:assessmentOperationId,stopAfterTask,
            ...(resumeQa?{qaPacket:pending.inputs,workerResult:{exitCode:pending.inputs.clineSummary?.exitCode??pending.inputs.workerResult?.exitCode??0}}:{})};
          if(correctionResume){await reconcile(task,sha);r.currentCorrection=correctionResume.currentCorrection??{id:randomUUID(),source:'elevation',prompt:r.prompt,attempted:false};}
          if(!resumeQa&&!correctionResume)await onTask(task);
          await save(Boolean(assessmentOperationId));
        }
        for(;;) {
          if(await stopped())return{status:'stopped'};
          const boundaryControl=await readControl();
          if(r.userAttention && ['worker','correction-assessment'].includes(r.phase) && Number(boundaryControl.elevateGeneration??0)>Number(r.elevateGeneration??0)) {
            r.elevateGeneration=boundaryControl.elevateGeneration;
            r.elevationFingerprint=recoveryFingerprint({task,baseline:r.baselineSha,diff:r.qaPacket.diff,failure:r.failure,corrections:r.correctionHistory});
            if(!r.elevations.includes(r.elevationFingerprint)){r.phase='elevation';r.elevationAutomatic=false;await save();}
          }
          if(r.phase==='passed') {
            if(!r.afterPassDone&&stageRoles('after-pass').length) {
              const reports=await runStageRoles('after-pass',{task,commit:r.failure?.commit??null,qaOutput:r.failure?.output??'',attempts:r.attempt,changedFiles:r.qaPacket?.changedFiles??[]});
              if(reports.stopped)return{status:'stopped'};
              for(const report of reports.results)await appendFile(path.join(stateDir,'role-reports.ndjson'),JSON.stringify({at:new Date().toISOString(),taskId:task.id,role:report.name,...report.result})+'\n');
              r.afterPassDone=true;await save();
            }
            return{status:'passed',attempts:r.attempt,qa:r.failure,history:r.history};
          }
          if(r.phase==='worker') {
            const guidance=await runStageRoles('before-implementation',{objective,task,fileStatus:describeAllowedPaths(task,workspace)});
            if(guidance.stopped)return{status:'stopped'};
            if(codex.activeCount!==0)throw new Error('Cannot launch local worker while Codex is alive');
            await codex.assertIdle?.();
            r.scratchBaseline=await captureScratchBaseline(workspace);await save();
            const knowledge=await selectKnowledge(knowledgeFile,task.prompt+' '+(r.failure?.output??''));
            await emit('known-issues-selected',{knownIssues:[...knowledge.matchAll(/^## (.+)$/gm)].map(m=>m[1])});
            const roleText=roleGuidanceText(guidance.results);
            r.promptWithKnowledge=r.prompt+(roleText?'\n\n'+roleText:'')+(knowledge?'\n\n'+knowledge:'');
            r.phase='worker-launching';await save();
            const started=Date.now();await emit('cline-started',{attempt:r.attempt,startedAt:new Date(started).toISOString()});
            r.workerResult=compactWorkerResult(await worker.run(r.promptWithKnowledge,{task,
              onStart:async({pid})=>{
                // A correction counts only once the owned worker has actually started.
                if(r.currentCorrection&&!r.currentCorrection.attempted){r.currentCorrection.attempted=true;r.currentCorrection.attempt=r.attempt;
                  if(r.currentCorrection.source==='assessment')r.correctionCount++;
                  r.correctionHistory.push({...r.currentCorrection});}
                r.phase='worker-running';await save();await emit('cline-process-started',{pid,attempt:r.attempt,startedAt:new Date(started).toISOString()});
              },onEvent:async({type,...event})=>{recordScratchEvent(r.scratchBaseline,{type,...event});await emit(type,{...event,attempt:r.attempt});},
            }));
            r.scratchOwnership=await finalizeScratchOwnership(workspace,r.scratchBaseline);delete r.scratchBaseline;
            r.phase='evidence';await save();await emit('cline-finished',{attempt:r.attempt,exitCode:r.workerResult.exitCode,durationMs:Date.now()-started});
          }
          if(r.phase==='evidence') {
            if(r.forceFreshQa)for(const key of Object.keys(r.roleResults??{}))if(key.startsWith('before-qa:'))delete r.roleResults[key];
            const checks={tests:'NOT RUN',typecheck:'NOT RUN',lint:'NOT RUN',build:'NOT RUN',scopeCheck:'RUNNING'},category=classifyQaCommand(task.qaCommand);if(category)checks[category]='RUNNING';
            await emit('qa-evidence-started',{attempt:r.attempt,qaChecks:checks});
            r.qaPacket=await prepareQa({task,attempt:r.attempt,baselineSha:r.baselineSha,workerResult:r.workerResult,previousPacket:r.forceFreshQa?null:r.qaPacket});
            r.forceFreshQa=false;
            r.phase=stageRoles('before-qa').length?'review':'qa';await save();await emit('qa-evidence-finished',{attempt:r.attempt,qaChecks:r.qaPacket.qaEvidence.categories,changedFileCount:r.qaPacket.changedFiles.length,diffByteCount:r.qaPacket.diff.bytes,commands:[task.qaCommand],durationMs:r.qaPacket.qaEvidence.durationMs});
          }
          if(r.phase==='review') {
            if(r.qaPacket.qaEvidence?.scope?.status==='FAIL' || r.qaPacket.qaEvidence?.categories?.scopeCheck==='FAIL')return block(r.qaPacket.qaEvidence.scope?.message??'Out-of-scope mutation');
            const reviews=await runStageRoles('before-qa',{task,attempt:r.attempt,baselineSha:r.baselineSha,diff:r.qaPacket.diff,changedFiles:r.qaPacket.changedFiles,qaEvidence:r.qaPacket.qaEvidence,workerSummary:r.qaPacket.clineSummary??null},':'+r.attempt);
            if(reviews.stopped)return{status:'stopped'};
            // Reviews travel with the packet: QA and Assessment read them.
            r.qaPacket.roleReviews=reviews.results.map(x=>({role:x.name,gate:x.gate,...x.result}));
            const gate=reviews.results.find(x=>x.gate&&x.result.verdict==='changes-needed');
            if(gate) {
              r.failure={status:'fail',output:gateFailureText(gate),correction:'',commit:'',manualReviewCause:null,gateRole:gate.name};
              await verify({workspace,baselineHead:r.baselineSha,decision:r.failure,task});
              r.history.push({attempt:r.attempt,prompt:r.prompt,workerResult:r.workerResult,qa:r.failure});
              r.phase='decision';await save();await emit('role-gate-failed',{attempt:r.attempt,roleName:gate.name,qa:r.failure.output});
            } else {r.phase='qa';await save();}
          }
          if(r.phase==='qa') {
            if(r.qaPacket.qaEvidence?.scope?.status==='FAIL' || r.qaPacket.qaEvidence?.categories?.scopeCheck==='FAIL')return block(r.qaPacket.qaEvidence.scope?.message??'Out-of-scope mutation');
            const op=await operation('qa',r.qaPacket,review);if(op.stopped)return{status:'stopped'};
            r.failure=op.result;
            r.lastAppliedOperationId=op.operationId;
            if(!['pass','fail','recoverable','manual-review','blocked'].includes(r.failure.status))return block('Malformed QA decision');
            if(r.workerResult?.exitCode!==0 && r.failure.status==='pass')return block('QA accepted a failed local worker');
            // QA could not run its tools while the engine's own checks passed: an environment problem, not
            // the code. Retry once, reusing stable passing engine evidence; a second time stops for the user.
            if(qaEnvironmentFailure(r.failure,r.qaPacket)) {
              await verify({workspace,baselineHead:r.baselineSha,decision:r.failure,task});
              const retried=r.qaEnvironmentRetry?.attempt===r.attempt;
              if(!retried){r.qaEnvironmentRetry={attempt:r.attempt};r.phase='evidence';await save(true);await emit('qa-environment-retry',{attempt:r.attempt,qa:r.failure.output});continue;}
              return block('QA could not run its commands (an environment problem, not the code): '+String(r.failure.output).split(/\r?\n/)[0].slice(0,300)+' Fix the tool or permission problem, then press Retry QA.');
            }
            await verify({workspace,baselineHead:r.baselineSha,decision:r.failure,task});
            r.history.push({attempt:r.attempt,prompt:r.prompt,workerResult:r.workerResult,qa:r.failure});
            r.phase='decision';await save(true);
            await atomicWriteJson(path.join(stateDir,'last-result.json'),{task,completedAt:new Date().toISOString(),result:{status:r.failure.status,attempts:r.attempt,qa:r.failure,history:r.history}});
          }
          if(r.phase==='decision') {
            const classification=recoveryClassification(r.failure);
            if(classification==='blocked')return block(r.failure.output??'Unsafe QA condition');
            if(classification==='pass') {
              if(r.failure.verifiedIssue)await recordVerifiedIssue(knowledgeFile,r.failure.verifiedIssue,{role:'QA',passed:r.qaPacket.qaEvidence.command.exitCode===0});
              r.phase='passed';r.userAttention=false;r.elevateResult=null;await save();await emit('qa-pass',{attempt:r.attempt,qa:r.failure.output});continue;
            }
            r.userAttention=true;await emit('qa-fail',{attempt:r.attempt,qa:r.failure.output});await emit('user-attention',{qa:r.failure.output});
            const fingerprint=recoveryFingerprint({task,baseline:r.baselineSha,diff:r.qaPacket.diff,failure:r.failure,corrections:r.correctionHistory});
            const control=await readControl();
            const manual=manualElevation || Number(control.elevateGeneration??0)>Number(r.elevateGeneration??0);
            if(manual)r.elevateGeneration=control.elevateGeneration;
            const auto=solReassessmentEnabled&&r.correctionCount-r.lastElevationCount>=TUNING.elevationAfter&&!r.elevations.includes(fingerprint);
            // Optional correction limit: stop for the user; Resume grants another round of corrections.
            if(!manual&&!auto&&TUNING.maxCorrections>0&&r.correctionCount-(r.correctionLimitBase??0)>=TUNING.maxCorrections) {
              r.correctionLimitBase=r.correctionCount;r.phase='correction-assessment';r.elevationAutomatic=false;r.elevationFingerprint=fingerprint;manualElevation=false;await save();
              const reason=`Correction limit reached (${TUNING.maxCorrections} without success). Resume for another ${TUNING.maxCorrections}, or Elevate.`;
              await emit('correction-limit',{correctionCount:r.correctionCount,limit:TUNING.maxCorrections});await emit('user-attention',{qa:reason});
              return{status:'user-attention',output:reason};
            }
            r.phase=manual||auto?'elevation':'correction-assessment';r.elevationAutomatic=!manual;r.elevationFingerprint=fingerprint;manualElevation=false;await save();
          }
          if(['correction-assessment','elevation'].includes(r.phase)) {
            const elevation=r.phase==='elevation';
            const input={task,acceptanceCriteria:r.qaPacket.acceptanceCriteria,baselineSha:r.baselineSha,currentDiff:r.qaPacket.diff,changedFiles:r.qaPacket.changedFiles,qaPacket:packetForPrompt(r.qaPacket),
              latestQaVerdict:r.failure,failure:{reason:r.failure.output,cause:r.failure.manualReviewCause},correctionCount:r.correctionCount,correctionHistory:compactCorrections(r.correctionHistory),
              previousCorrections:r.correctionHistory.map(x=>correctionInstructions(x.prompt)),workerSummaries:r.history.map(x=>({attempt:x.attempt,result:compactWorkerResult(x.workerResult??{})})),assessmentResults:r.assessmentResults??[],
              resolverResult:r.resolverResult??null,workerCapabilities:await readWorkerCapabilities(stateDir,/^OpenCode editing guard stopped attempt: /.test(r.failure.output??'')?'opencode-guard':'cline-guard')??r.resolverCapabilities??null,
              verifiedKnowledge:await selectKnowledge(knowledgeFile,task.prompt+' '+r.failure.output)};
            const op=await operation(elevation?'elevate':'correction-assessment',input,elevation?elevate:assessCorrection,{automatic:r.elevationAutomatic,triggeredBy:elevation?`${r.correctionCount} Assessment corrections attempted`:'QA recoverable failure'});
            if(op.stopped)return{status:'stopped'};
            const decision=op.result;
            r.lastAppliedOperationId=op.operationId;
            if(decision.status==='blocked')return block(decision.failureReason||decision.rootProblem);
            if(elevation){r.lastElevationCount=r.correctionCount;r.elevations.push(r.elevationFingerprint);r.elevateResult={...decision,kind:decision.status,label:decision.status==='strategy-revised'?'Strategy revised':'Insufficient evidence',model:ELEVATE_MODEL,automatic:r.elevationAutomatic};}
            else {r.assessmentResult=decision;(r.assessmentResults??=[]).push(decision);}
            if(decision.status==='insufficient-evidence') {
              // Request executable evidence instead of inventing a repair. No tight
              // model-to-model loop: the next step is a bounded diagnostic worker.
              if(!decision.neededEvidence?.length){
                if(elevation){r.phase='correction-assessment';await save(true);await emit('elevate-result',{elevateResult:r.elevateResult,fingerprint:r.elevationFingerprint});continue;}
                return block('Malformed recovery result: no safe executable evidence request');
              }
              decision.nextWorkerInstructions='Collect only this evidence, preserving current implementation:\n'+decision.neededEvidence.join('\n');
              decision.status='correction';
            }
            const text=correctionText(decision,r.qaPacket);
            r.prompt=buildCorrectionPrompt(task,r.failure.output,r.attempt,text,false,{workspace});
            r.currentCorrection={id:randomUUID(),source:elevation?'elevation':'assessment',prompt:r.prompt,attempted:false};
            r.attempt++;r.phase='worker';await save(true);
            await atomicWriteJson(path.join(stateDir,'correction-task.json'),{...task,prompt:r.prompt,source:r.currentCorrection.source});
            if(elevation)await emit('elevate-result',{elevateResult:r.elevateResult,fingerprint:r.elevationFingerprint});
            await emit('retry',{attempt:r.attempt,qa:r.failure.output});
          }
        }
        }finally{exclusiveHeld=false;}
      });}catch(error){result=await block(error.message);}
      if(!result){await emit('queued');await sleep(pollMs);continue;}
      if(result.status==='blocked')result=await block(result.output??r?.blockedReason??'Recovery is blocked');
      if(result.status==='resolver-ready')continue;
      if(result.status!=='passed'||stopAfterTask)return result;
      previous={task,result:result.qa};task=null;r=null;saved=null;
    }
  } catch(error) {return block(error.message);}
}
