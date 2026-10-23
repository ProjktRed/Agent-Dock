import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {lockHeld,withBusyLock} from './busy-lock.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWriteJson} from './dashboard-state.mjs';
import {adapter,PLUGIN_ID,prepareOpenCodeGuard,readGuardOutcome} from './guard/adapters/opencode.mjs';
import {stopMessage} from './guard/reasons.mjs';
import {noteUsage,openCodeUsage} from './run-budget.mjs';
import {openCodeRunOptions} from './cli-run-settings.mjs';

const FAIL_CLOSED='OpenCode guard plugin did not initialize; guarded run refused';
const redact=(text,env,keyEnv)=>keyEnv&&env[keyEnv]?String(text).replaceAll(env[keyEnv],'[REDACTED]'):String(text);

export function openCodeChildEnv(env,guard,apiKeyEnv){
 const child={...env};
 for(const name of Object.keys(child))if(name.startsWith('OPENCODE_')&&name!==apiKeyEnv)delete child[name];
 return {...child,...guard.env};
}

export function normalizeOpenCodeEvent(event){
 const part=event?.part;
 if(event?.type==='text'&&typeof part?.text==='string')return {type:'cline-message',message:part.text.slice(0,4000),action:part.text.slice(0,1000)};
 if(event?.type==='reasoning')return {type:'cline-thinking',action:'Thinking…'};
 if(event?.type==='tool_use'){
  const input=part?.state?.input??{};
  return {type:'cline-tool',tool:part?.tool??'unknown',action:(input.command??input.path??part?.tool??'Tool').slice(0,1000),...(part?.state?.status==='error'?{error:part.state.error}:{} )};
 }
 return null;
}

export function collectOpenCodeProcess(command,args,{cwd,env=process.env,spawnProcess=spawn,timeoutMs=1_800_000,onStart=()=>{},onEvent=()=>{},apiKeyEnv}={}){
 return new Promise((resolve,reject)=>{
  const child=spawnProcess(command,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',line='',settled=false,timedOut=false;
  const events=[];
  let eventQueue=Promise.resolve();
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
  const parse=raw=>{
   if(!raw.trim())return;
   let event;try{event=JSON.parse(redact(raw,env,apiKeyEnv));}catch{return;}
   events.push(event);
   const activity=normalizeOpenCodeEvent(event);
   if(activity)eventQueue=eventQueue.then(()=>onEvent(activity));
  };
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
   stdout=(stdout+chunk).slice(-4_000_000);line+=chunk;
   const lines=line.split(/\r?\n/);line=lines.pop()??'';
   for(const entry of lines)parse(entry);
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-100_000);});
  child.stdin.on('error',()=>{});
  child.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(Error(redact(error.message,env,apiKeyEnv)));});
  child.on('close',async code=>{
   if(settled)return;settled=true;clearTimeout(timer);
   parse(line);
   try{await eventQueue;}catch(error){reject(error);return;}
   const steps=events.filter(event=>event.type==='step_finish'),lastStep=steps.at(-1)?.part;
   const errors=events.filter(event=>event.type==='error');
   const text=events.filter(event=>event.type==='text').map(event=>event.part?.text??'').join('').slice(-4000);
   const completed=!timedOut&&code===0&&!errors.length&&lastStep?.reason==='stop';
   resolve({exitCode:timedOut?124:code??1,pid:child.pid??null,stdout:redact(stdout,env,apiKeyEnv),stderr:redact(stderr,env,apiKeyEnv),output:redact(stdout+stderr,env,apiKeyEnv),events,runResult:{finishReason:completed?'completed':timedOut?'timeout':'failed',text:text||errors.at(-1)?.error?.message||redact(stderr.slice(-2000),env,apiKeyEnv),steps:steps.length,cost:steps.reduce((sum,event)=>sum+(Number(event.part?.cost)||0),0),lastFinishReason:lastStep?.reason??null}});
  });
  Promise.resolve(onStart({pid:child.pid??null})).then(()=>child.stdin.end(),error=>{child.kill('SIGKILL');if(settled)return;settled=true;clearTimeout(timer);reject(error);});
 });
}

async function verifyActivePlugin(command,{workspace,env,spawnProcess}){
 const password=randomUUID(),deadline=Date.now()+30_000;
 const child=spawnProcess(command,['serve','--stdio','--hostname','127.0.0.1','--port','0'],{cwd:workspace,env:{...env,OPENCODE_PASSWORD:password},windowsHide:true,stdio:['pipe','pipe','pipe']});
 let closed=false,buffer='';
 const finished=new Promise(resolve=>child.once('close',()=>{closed=true;resolve();}));
 child.stderr.resume();
 child.stdin.on('error',()=>{});
 try{
  const baseUrl=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error(FAIL_CLOSED+' (plugin server startup timed out)')),30_000);
   const fail=error=>{clearTimeout(timer);reject(error);};
   child.once('error',fail);
   child.once('close',()=>fail(Error(FAIL_CLOSED+' (plugin server exited)')));
   child.stdout.setEncoding('utf8');
   child.stdout.on('data',chunk=>{
    buffer+=chunk;
    const newline=buffer.indexOf('\n');if(newline<0)return;
    clearTimeout(timer);
    try{
     const url=new URL(JSON.parse(buffer.slice(0,newline)).url);
     if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)throw Error('invalid local endpoint');
     resolve(url);
    }catch{reject(Error(FAIL_CLOSED+' (plugin server returned invalid endpoint)'));}
   });
  });
  const headers={authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')};
  // This fork returns [] before asynchronous plugin setup completes. Keep this private
  // server alive until it reports the guard active; one-shot standalone API exits early.
  while(!closed&&Date.now()<deadline){
   const response=await fetch(new URL('/api/plugin',baseUrl),{headers,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
   if(!response.ok)throw Error(FAIL_CLOSED+' (plugin preflight HTTP '+response.status+')');
   let plugins=await response.json();
   if(plugins&&!Array.isArray(plugins)&&Array.isArray(plugins.data))plugins=plugins.data;
   if(!Array.isArray(plugins))throw Error(FAIL_CLOSED+' (plugin preflight returned invalid JSON)');
   if(plugins.some(plugin=>plugin.id===PLUGIN_ID&&plugin.state?.status==='active'))return;
   if(plugins.length)throw Error(FAIL_CLOSED+' (plugin is not active)');
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error(FAIL_CLOSED+' (plugin initialization timed out)');
 }finally{
  child.stdin.end();
  const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
  await finished;
  clearTimeout(timer);
 }
}

export async function preflightOpenCode({command='opencode',workspace,env=process.env,policyPath,handshake,spawnProcess=spawn,apiKeyEnv}){
 const version=await collectOpenCodeProcess(command,['--version'],{cwd:workspace,env,spawnProcess,timeoutMs:30_000,apiKeyEnv});
 const match=version.stdout.trim().match(/^(?:opencode\s+)?v?((\d+)\.\d+\.\d+(?:[-+][\w.-]+)?)$/);
 if(version.exitCode!==0||!match)throw Error('OpenCode version could not be verified; guarded run refused');
 if(Number(match[2])!==2)throw Error(`OpenCode major version ${match[2]} is unsupported; expected the v2 plugin API`);
 await verifyActivePlugin(command,{workspace,env,spawnProcess});
 const outcome=await readGuardOutcome(policyPath);
 if(!outcome.runtimeReady||outcome.runtimeHandshake!==handshake)throw Error(FAIL_CLOSED+' (plugin handshake missing)');
 return {version:match[1]};
}

/** The guarded run: the agent-dock agent, with the variant from CLIs › OpenCode › Settings when one is set. */
export function openCodeRunArgs(guard,prompt,runOptions=openCodeRunOptions()){
 return ['run','--standalone','--format','json','-m',`${guard.providerID}/${guard.model}${runOptions.variant?`#${runOptions.variant}`:''}`,'--agent','agent-dock','--auto',prompt];
}

export async function launchOpenCode({command='opencode',opencodeCommand,workspace,providerDescriptor,prompt,timeoutSeconds=1800,guard,onStart,onEvent,env=process.env,spawnProcess=spawn}){
 if(!guard?.policyPath||!guard?.handshake)throw Error(FAIL_CLOSED+' (guard configuration missing)');
 command=opencodeCommand??command;
 const childEnv=openCodeChildEnv(env,guard,providerDescriptor.apiKeyEnv);
 await preflightOpenCode({command,workspace,env:childEnv,policyPath:guard.policyPath,handshake:guard.handshake,spawnProcess,apiKeyEnv:providerDescriptor.apiKeyEnv});
 // The standalone run must independently prove setup; a preflight handshake alone cannot satisfy it.
 const policy=await readGuardOutcome(guard.policyPath);
 policy.runtimeReady=false;policy.runtimeHandshake=null;
 await atomicWriteJson(guard.policyPath,policy);
 const result=await collectOpenCodeProcess(command,openCodeRunArgs(guard,prompt),{cwd:workspace,env:childEnv,spawnProcess,timeoutMs:timeoutSeconds*1000,onStart,onEvent,apiKeyEnv:providerDescriptor.apiKeyEnv});
 noteUsage(openCodeUsage(result.events));
 const outcome=await readGuardOutcome(guard.policyPath);
 if(!outcome.runtimeReady||outcome.runtimeHandshake!==guard.handshake)throw Error(FAIL_CLOSED+' (run handshake missing)');
 if(outcome.stopped){
  await onEvent?.({type:'cline-guard-stopped',message:outcome.reason});
  throw Object.assign(Error(stopMessage(adapter.label,outcome.reason)),{output:result.output});
 }
 // The CLI can omit the final step event. Its persisted session proves the finish
 // reason and execution outcome, and includes all steps in usage totals.
 const sessionID=result.events.find(event=>typeof event.sessionID==='string')?.sessionID;
 if(result.exitCode===0&&sessionID&&!result.events.some(event=>event.type==='error')){
  const exported=await collectOpenCodeProcess(command,['session','export','--standalone',sessionID],{cwd:workspace,env:childEnv,spawnProcess,timeoutMs:30_000,apiKeyEnv:providerDescriptor.apiKeyEnv});
  let session;try{session=JSON.parse(exported.stdout);}catch{}
  const messages=Array.isArray(session?.messages)?session.messages:[],steps=messages.filter(message=>message.type==='assistant'),last=steps.at(-1),idle=messages.filter(message=>message.type==='idle').at(-1);
  const completed=exported.exitCode===0&&session?.info?.id===sessionID&&session.info.location?.directory===workspace&&session.info.outcome==='succeeded'&&idle?.outcome==='succeeded'&&last?.finish==='stop'&&typeof last.time?.completed==='number';
  result.runResult={...result.runResult,finishReason:completed?'completed':'failed',lastFinishReason:last?.finish??null,steps:steps.length,cost:Number(session?.info?.cost)||0};
 }
 if(result.runResult.finishReason!=='completed')throw Object.assign(Error('Guarded OpenCode attempt did not complete: '+(result.runResult.lastFinishReason??result.runResult.finishReason)),{output:result.output});
 return result;
}

export class OpenCodeCliWorker {
 constructor({stateDir,workspace,opencodeCommand,command='opencode',providerDescriptor,model=providerDescriptor.model,timeoutSeconds=1800,steps=40,toolGuard=true,env=process.env,spawnProcess=spawn,launch=launchOpenCode}){
  this.stateDir=path.resolve(stateDir);this.workspace=path.resolve(workspace);this.lockPath=path.join(this.stateDir,'cline.busy.lock');
  this.options={command:opencodeCommand??command,workspace:this.workspace,providerDescriptor,model,timeoutSeconds,env,spawnProcess};this.steps=steps;this.toolGuard=toolGuard;this.launch=launch;
 }
 async isBusy(){return lockHeld(this.lockPath);}
 async withExclusive(operation){
  await mkdir(this.stateDir,{recursive:true});
  return withBusyLock(this.lockPath,operation);
 }
 async run(prompt,hooks={}){
  const onEvent=hooks.onEvent??(()=>{}),provider=this.options.providerDescriptor;
  const identity={requestedProvider:provider.id,provider:provider.id,baseUrl:provider.baseUrl,model:this.options.model};
  try{await provider.preflight?.();}catch(error){await onEvent({type:'cline-provider-validation-failed',...identity,error:error.message,fallbackAttempted:false});throw error;}
  await onEvent({type:'cline-provider-ready',...identity});
  const guard=await prepareOpenCodeGuard({stateDir:this.stateDir,workspace:this.workspace,providerDescriptor:provider,model:this.options.model,steps:openCodeRunOptions().steps??this.steps,task:hooks.task});
  // OpenCode always uses the plugin: --tool-guard false cannot bypass its fail-closed boundary.
  return this.launch({...this.options,...hooks,guard,prompt:prompt+guard.instructions});
 }
}
