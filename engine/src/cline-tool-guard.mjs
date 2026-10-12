import path from 'node:path';
import {readFile,writeFile,rename,mkdir,realpath,lstat,open,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {atomicWriteJson} from './dashboard-state.mjs';
import {rememberRead,checkSmallEdit,rememberEditFailure,nativeError} from './cline-edit-boundary.mjs';

const readJson=async file=>JSON.parse(await readFile(file,'utf8'));
const within=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
const cancel=reason=>({cancel:true,errorMessage:`Cline editing guard: ${reason}`});
const normalizeCommand=command=>command.trim().replace(/^npm\.cmd\b/i,'npm').replace(/^npx\.cmd\b/i,'npx').replace(/\s+/g,' ');
const allowedTools=['read_files','search_codebase','run_commands','editor','apply_patch','skills','ask_question','submit_and_exit'];
const unsafeCommand=command=>/[\r\n;$`><]/.test(command)||/\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|writeFile|unlink|rmdir|del|erase)\b/i.test(command)||/\bgit\s+(?:reset|clean|checkout|restore|commit|add|push|rebase|stash|merge|switch|update-index|config)\b/i.test(command)||/\b(?:python|node|cmd|powershell|pwsh)\b.*(?: -[ce]| -Command| -File| \/c)\b/i.test(command)||/\b(?:npm|npx)(?:\.cmd)?\s+(?:exec|install|uninstall|publish)\b/i.test(command)||/\bprettier\s+--write\b/.test(command);

export async function prepareToolGuard({stateDir,workspace}) {
  const task=await readJson(path.join(stateDir,'current-task.json'));
  if(!task.id||!Array.isArray(task.allowedPaths)||!task.allowedPaths.length||typeof task.qaCommand!=='string')throw Error('Cline editing guard requires valid current task/scope');
  const configDir=path.join(path.resolve(stateDir),'cline-guard','config');
  const hooksDir=path.join(configDir,'hooks'),policyPath=path.join(path.resolve(stateDir),'cline-guard','policy.json');
  const resolvedWorkspace=await realpath(workspace);
  const approvedCommands=[task.qaCommand,'npm run lint','npm run typecheck','git diff --check',
    ...task.allowedPaths.filter(p=>!p.endsWith('/')).flatMap(p=>[`npx prettier --check ${p}`,`npx prettier --write ${p}`])].map(normalizeCommand);
  const commandChoices=[...new Set([...approvedCommands,
    'git status --short','git diff --stat','git diff --numstat','git diff --name-only','git rev-parse HEAD',
    ...task.allowedPaths.filter(p=>/^[\w][\w./-]*$/.test(p)&&!p.split('/').includes('..')).flatMap(p=>[`git diff -- ${p}`,`git ls-files -- ${p}`,`git show HEAD:${p}`])])];
  const policy={version:1,taskId:task.id,workspace:resolvedWorkspace,allowedPaths:task.allowedPaths,approvedCommands,commandChoices:[],runtimeReady:false,invalidToolCalls:0,failedEdits:0,stopped:false,reason:null};
  for(const command of commandChoices)if(await approvedCommand(policy,command))policy.commandChoices.push(command);
  policy.commandChoices=[...new Set(policy.commandChoices.flatMap(command=>/^(?:npm|npx) /.test(command)?[command,command.replace(/^(npm|npx) /,'$1.cmd ')]:[command]))];
  await atomicWriteJson(policyPath,policy);
  await mkdir(hooksDir,{recursive:true});
  for(const name of ['PreToolUse','PostToolUse']){
    const source=`import {runGuardHook} from ${JSON.stringify(import.meta.url)};\nawait runGuardHook(${JSON.stringify(policyPath)});\n`;
    const file=path.join(hooksDir,name+'.mjs'),temporary=file+'.'+randomUUID()+'.tmp';
    await writeFile(temporary,source,'utf8');await rename(temporary,file);
  }
  const pluginPath=path.join(configDir,'plugins','restricted-tools.js');await mkdir(path.dirname(pluginPath),{recursive:true});
  await atomicWriteJson(path.join(configDir,'package.json'),{private:true,type:'module'});
  const temporary=pluginPath+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,`import {createRestrictedToolsPlugin} from ${JSON.stringify(import.meta.url)};\nexport default createRestrictedToolsPlugin(${JSON.stringify(policyPath)});\n`);await rename(temporary,pluginPath);
  await atomicWriteJson(path.join(configDir,'data/settings/global-settings.json'),{disabledTools:['fetch_web_content','web_search','spawn_agent','spawn_subagent','browser_action','execute_command','write_to_file','replace_in_file'],tools:{web_search:{enabled:false}}});
  return{configDir,hooksDir,policyPath,pluginPath,instructions:'\n\nEnforced editing guard: edit only '+task.allowedPaths.join(', ')+' using the editing tool actually present in your tool schema. A mentioned tool is not necessarily registered. Source-writing shell commands and helper files are prohibited. Read the intended range with read_files immediately before editing. Existing files require a unique exact old_text/new_text replacement (at most 2000 characters each), or a verified insert_line; whole-file rewrites are prohibited. Do not reconstruct backslashes from escaped output. Two consecutive failed native edits stop this attempt. Select run_commands.commands from its exact enum; do not invent commands. Three invalid tool requests stop this attempt. Approved command choices (prefer npm.cmd/npx.cmd on Windows):\n'+policy.commandChoices.join('\n')+'\nDo not wrap commands in PowerShell/cmd or redirect output.'};
}

// SDK plugin hooks filter the model request, then validate execution independently.
// File hooks execute first in Cline: their soft-command exception is enabled only
// after this plugin has successfully narrowed a model request for this attempt.
export function createRestrictedToolsPlugin(policyPath){
 let registeredTools=new Set();
 return {name:'automation.restricted-tools',manifest:{capabilities:['hooks']},hooks:{
  async beforeModel({request}){
   const control=await updateGuardPolicy(policyPath,async policy=>{
    if(policy.stopped)return {stop:true,reason:policy.reason};
    if(!Array.isArray(policy.commandChoices)||!policy.commandChoices.length)throw Error('missing command choices');
    registeredTools=new Set(request.tools.map(tool=>tool.name));
    const tools=request.tools.filter(tool=>allowedTools.includes(tool.name)).map(tool=>tool.name==='run_commands'?{...tool,inputSchema:{type:'object',properties:{commands:{type:'array',minItems:1,items:{type:'string',enum:policy.commandChoices}}},required:['commands'],additionalProperties:false}}:tool);
    policy.nativeTools=tools.map(tool=>tool.name);
    policy.runtimeReady=true;return {tools};
   });
   return control.cancel?{stop:true,reason:control.errorMessage}:control;
  },
  async afterModel({assistantMessage}){
   // SDK never invokes beforeTool for names absent from its registry. Count
   // these in original model output, without modifying the assistant transcript.
   const unknown=assistantMessage.content.filter(part=>part.type==='tool-call'&&!registeredTools.has(part.toolName));
   if(!unknown.length)return;
   const control=await updateGuardPolicy(policyPath,async policy=>{
    if(policy.stopped)return {stop:true,reason:policy.reason};
    for(const part of unknown){const rejected=rejectTool(policy,part.toolName,part.input);if(rejected.stop)return rejected;}
   });
   return control?.cancel?{stop:true,reason:control.errorMessage}:control;
  },
  async beforeTool(context){
   const control=await updateGuardPolicy(policyPath,async policy=>{
    if(policy.stopped)return {stop:true,reason:policy.reason};
    if(!policy.runtimeReady)throw Error('tool restriction handshake missing');
    const name=context.tool.name,input=context.input;
    if(name==='run_commands'){
     const commands=input?.commands;
     const valid=input&&Object.keys(input).length===1&&Array.isArray(commands)&&commands.length>0&&commands.every(command=>typeof command==='string'&&policy.commandChoices.includes(command));
     if(valid){for(const command of commands)if(!await approvedCommand(policy,command))return hardStop(policy,'command safety validation failed',name,input);return;}
     const text=JSON.stringify(input);
     if(unsafeCommand(text??''))return hardStop(policy,'unsafe command is prohibited',name,input);
     return rejectTool(policy,name,input);
    }
    if(!allowedTools.includes(name)){
     if(typeof input?.path==='string'&&!await approvedPath(policy,input.path))return hardStop(policy,'unapproved tool path is outside approved scope',name,input);
     return rejectTool(policy,name,input);
    }
    // Keep native scope validation and malformed-input handling identical to file hooks.
    const checked=await inspect(policy,{hookName:'tool_call',tool_call:{name,input}});
    if(checked.cancel)return hardStop(policy,checked.errorMessage,name,input);
    if(['editor','apply_patch'].includes(name)){
     const reason=await checkSmallEdit(policy,name,input);
     if(reason){
      await rememberEditFailure(policy,{name,input,id:context.toolCall?.toolCallId},reason,'before-execution');
      policy.failedEdits++;
      if(policy.failedEdits>=2)return hardStop(policy,'two consecutive native edit failures; preserve the diff and reassess',name,input);
      return {skip:true,reason};
     }
    }
   });
   return control?.cancel?{stop:true,reason:control.errorMessage}:control;
  }
 }};
}
function hardStop(policy,reason,name,input){policy.stopped=true;policy.reason=reason;rememberRejection(policy,name,input);return {stop:true,reason};}
function rememberRejection(policy,name,input){policy.lastRejection={tool:name,path:typeof input?.path==='string'?input.path.slice(0,500):null,commands:name==='run_commands'?JSON.stringify(input)?.slice(0,1500):null};}
function rejectTool(policy,name,input){
 policy.invalidToolCalls=(policy.invalidToolCalls??0)+1;rememberRejection(policy,name,input);
 const reason='Tool/command not approved. Use only the visible native tools and select an exact run_commands.commands enum value.';
 return policy.invalidToolCalls>=3?hardStop(policy,'three invalid tool requests; preserve the diff and reassess',name,input):{skip:true,reason};
}
export async function verifyRestrictedTools({pluginPath}){
 const plugin=(await import(pathToFileURL(pluginPath).href+'?verify='+randomUUID())).default;
 if(plugin?.name!=='automation.restricted-tools'||typeof plugin.hooks?.beforeModel!=='function'||typeof plugin.hooks?.beforeTool!=='function'||typeof plugin.hooks?.afterModel!=='function')throw Error('Cline tool restriction plugin unavailable');
}

async function approvedPath(policy,file){
  if(typeof file!=='string'||!file.trim())return false;
  const absolute=path.resolve(policy.workspace,file);
  if(!within(policy.workspace,absolute))return false;
  const scopes=[];
  for(const scope of policy.allowedPaths){
    const base=path.resolve(policy.workspace,scope);if(!within(policy.workspace,base)||base===policy.workspace)continue;
    let directory=scope.endsWith('/');try{directory ||= (await lstat(base)).isDirectory();}catch(error){if(error.code!=='ENOENT')throw error;}
    if(path.relative(base,absolute)===''||(directory&&within(base,absolute)))scopes.push({base,directory});
  }
  if(!scopes.length)return false;
  // Resolve the closest existing parent too: creating a new file through a junction must not escape.
  let ancestor=absolute;
  for(;;){try{const destination=path.resolve(await realpath(ancestor),path.relative(ancestor,absolute));return within(policy.workspace,destination)&&scopes.some(({base,directory})=>path.relative(base,destination)===''||(directory&&within(base,destination)));}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)return false;ancestor=parent;}}
}

async function approvedCommand(policy,value){
  if(value?.args!==undefined&&(!Array.isArray(value.args)||!value.args.every(arg=>typeof arg==='string'&&!/\s/.test(arg))))return false;
  const command=typeof value==='string'?value:typeof value?.command==='string'?[value.command,...(value.args??[])].join(' '):null;
  if(typeof command!=='string'||!command.trim()||/[\r\n;$`|><]/.test(command)||/(?<!&)&(?!&)/.test(command))return false;
  const parts=command.split(/\s*&&\s*/);if(parts.length>1){for(const part of parts)if(!await approvedCommand(policy,part))return false;return true;}
  const normalized=normalizeCommand(command);
  // Exact task validation is allowed, but never an interpreter, wrapper or an arbitrary script writer.
  if(!/^(?:npm|npx|git)\s/.test(normalized))return false;
  const formatter=normalized.match(/^npx prettier --write ([\w][\w./-]*)$/);
  if(formatter){try{return policy.approvedCommands.includes(normalized)&&await approvedPath(policy,formatter[1])&&(await lstat(path.resolve(policy.workspace,formatter[1]))).isFile();}catch(error){if(error.code==='ENOENT')return false;throw error;}}
  if(policy.approvedCommands.includes(normalized))return true;
  // Bounded read-only Git inspection; output redirection and write-capable flags remain prohibited.
  const scoped=normalized.match(/^git (?:ls-files(?: --others --exclude-standard)?|diff(?: --check| --stat| --numstat| --name-only| --cached| --staged)?|status(?: --short| --porcelain)?)(?: --)? (\w[\w./ -]*)$/);
  if(scoped)return scoped[1].split(' ').every(file=>/^[\w][\w./-]*$/.test(file)&&!file.split('/').includes('..')&&!path.isAbsolute(file));
  return /^git (?:status(?: --short| --porcelain)?|diff(?: --check| --stat| --numstat| --name-only| --cached| --staged)?|rev-parse (?:HEAD|--show-toplevel)|show (?:HEAD|[a-f0-9]{7,40}):[\w./-]+|ls-files(?: --others --exclude-standard)?)$/.test(normalized);
}

function failedResult(value){
  if(typeof value==='string'){try{return failedResult(JSON.parse(value));}catch{return /Editor operation failed|No replacement performed|text not found/i.test(value);}}
  if(Array.isArray(value))return value.some(failedResult);
  return value?.success===false||value?.isError===true||Boolean(value?.error);
}

async function inspect(policy,payload){
  if(policy.stopped)return cancel(policy.reason);
  if(!payload||!['tool_call','tool_result'].includes(payload.hookName))return cancel('malformed hook input');
  const tool=payload.tool_call??payload.tool_result;
  if(!tool||typeof tool.name!=='string')return cancel('missing tool identity');
  if(payload.hookName==='tool_result'){
    if(tool.name==='read_files'&&!failedResult(tool.output))await rememberRead(policy,tool,approvedPath);
    if(['editor','apply_patch'].includes(tool.name)){
      // The SDK also dispatches PostToolUse for a plugin-skipped call. It is
      // the same rejection, not a second failed edit or a native execution.
      if(tool.id&&(policy.editFailures??[]).some(e=>e.id===tool.id&&e.stage==='before-execution'))return {cancel:false};
      const failed=payload.postToolUse?.success===false||failedResult(tool.output);
      if(failed)await rememberEditFailure(policy,tool,nativeError(tool.output));
      policy.failedEdits=failed?policy.failedEdits+1:0;
      if(policy.failedEdits>=2)return cancel('two consecutive native edit failures; preserve the diff and reassess');
    }
    return{cancel:false};
  }
  const input=tool.input;
  if(input==null)return cancel('missing tool input');
  if(tool.name==='editor')return await approvedPath(policy,input.path)?{cancel:false}:cancel('edit path is outside approved scope or unresolved');
  if(tool.name==='apply_patch'){
    if(typeof input.input!=='string')return cancel('malformed patch');
    const files=[...input.input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match=>match[1]);
    if(!files.length)return cancel('patch paths are not explicit');
    for(const file of files)if(!await approvedPath(policy,file))return cancel('patch path is outside approved scope');
    return{cancel:false};
  }
  if(tool.name==='run_commands'){
    const raw=typeof input==='string'||Array.isArray(input)?input:input.commands??(input.command?input:null);
    const commands=Array.isArray(raw)?raw:raw==null?[]:[raw];
    if(commands.length>0){let approved=true;for(const command of commands)if(!await approvedCommand(policy,command)){approved=false;break;}if(approved)return{cancel:false};}
    if(policy.runtimeReady&&!unsafeCommand(JSON.stringify(input)))return {cancel:false};
    return cancel('command is not approved validation/read-only inspection; use native editing tools, not shell writes');
  }
  if(['read_files','search_codebase','skills','ask_question','submit_and_exit'].includes(tool.name))return{cancel:false};
  if(policy.runtimeReady&&!(typeof input?.path==='string'&&!await approvedPath(policy,input.path)))return{cancel:false};
  return cancel('unknown or unapproved tool: '+tool.name);
}

async function updateGuardPolicy(policyPath,operation){
  let lock;
  try{
    // Parallel tool batches may invoke hooks concurrently. Serialize only this attempt's tiny counter.
    for(let attempt=0;attempt<40;attempt++){
      try{lock=await open(policyPath+'.lock','wx');break;}catch(error){if(error.code!=='EEXIST')throw error;await new Promise(resolve=>setTimeout(resolve,25));}
    }
    if(!lock)return cancel('guard counter lock is unresolved');
    const policy=await readJson(policyPath);
    if(policy.version!==1||!Number.isInteger(policy.failedEdits)||!Array.isArray(policy.allowedPaths))throw Error('invalid guard policy');
    const control=await operation(policy);
    await atomicWriteJson(policyPath,policy);
    return control;
  }catch(error){return cancel('guard state unavailable: '+error.message);}
  finally{if(lock){await lock.close();await unlink(policyPath+'.lock');}}
}
export async function handleGuardEvent(policyPath,payload){
  return updateGuardPolicy(policyPath,async policy=>{
    const control=await inspect(policy,payload);
    if(control.cancel){policy.stopped=true;policy.reason=control.errorMessage.replace(/^Cline editing guard: /,'');
      const tool=payload?.tool_call; if(tool)policy.lastRejection={tool:tool.name,path:typeof tool.input?.path==='string'?tool.input.path.slice(0,500):null,commands:tool.name==='run_commands'?JSON.stringify(tool.input).slice(0,1500):null};}
    return control;
  });
}

export async function readGuardOutcome(policyPath){
  const policy=await readJson(policyPath);
  if(policy.version!==1||typeof policy.stopped!=='boolean'||!Number.isInteger(policy.failedEdits))throw Error('Invalid Cline editing guard policy');
  return policy;
}
export async function readWorkerCapabilities(stateDir){
  let guard;try{guard=await readJson(path.join(stateDir,'cline-guard','policy.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  return {allowedPaths:guard.allowedPaths,approvedCommands:guard.approvedCommands,nativeTools:guard.nativeTools??[],editFailures:guard.editFailures??[],lastRejection:guard.lastRejection??null};
}
export async function runGuardHook(policyPath){
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1_000_000){process.stdout.write(JSON.stringify(cancel('oversized hook input')));return;}}
  let payload;try{payload=JSON.parse(input);}catch{payload=null;}
  process.stdout.write(JSON.stringify(await handleGuardEvent(policyPath,payload))+'\n');
}
