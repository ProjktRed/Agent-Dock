import path from 'node:path';
import {realpath,lstat} from 'node:fs/promises';
import {PREPARE_INVALID_TASK} from './reasons.mjs';
import {isProtectedPath,protectedPathsFor} from './protected-paths.mjs';

const within=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
export const normalizeCommand=command=>command.trim().replace(/^npm\.cmd\b/i,'npm').replace(/^npx\.cmd\b/i,'npx').replace(/\s+/g,' ');
export const unsafeCommand=command=>/[\r\n;$`><]/.test(command)||/\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|writeFile|unlink|rmdir|del|erase)\b/i.test(command)||/\bgit\s+(?:reset|clean|checkout|restore|commit|add|push|rebase|stash|merge|switch|update-index|config)\b/i.test(command)||/\b(?:python|node|cmd|powershell|pwsh)\b.*(?: -[ce]| -Command| -File| \/c)\b/i.test(command)||/\b(?:npm|npx)(?:\.cmd)?\s+(?:exec|install|uninstall|publish)\b/i.test(command)||/\bprettier\s+--write\b/.test(command);

export async function createPolicy(task,workspace,security={}){
  if(!task.id||!Array.isArray(task.allowedPaths)||!task.allowedPaths.length||typeof task.qaCommand!=='string')throw Error(PREPARE_INVALID_TASK);
  const resolvedWorkspace=await realpath(workspace);
  const approvedCommands=[task.qaCommand,'npm run lint','npm run typecheck','git diff --check',
    ...task.allowedPaths.filter(p=>!p.endsWith('/')).flatMap(p=>[`npx prettier --check ${p}`,`npx prettier --write ${p}`])].map(normalizeCommand);
  const commandChoices=[...new Set([...approvedCommands,
    'git status --short','git diff --stat','git diff --numstat','git diff --name-only','git rev-parse HEAD',
    ...task.allowedPaths.filter(p=>/^[\w][\w./-]*$/.test(p)&&!p.split('/').includes('..')).flatMap(p=>[`git diff -- ${p}`,`git ls-files -- ${p}`,`git show HEAD:${p}`])])];
  const policy={version:1,taskId:task.id,workspace:resolvedWorkspace,protectedPaths:protectedPathsFor({workspace:resolvedWorkspace,...security}),qaCommand:task.qaCommand,allowedPaths:task.allowedPaths,approvedCommands,commandChoices:[],runtimeReady:false,invalidToolCalls:0,failedEdits:0,stopped:false,reason:null};
  for(const command of commandChoices)if(await approvedCommand(policy,command))policy.commandChoices.push(command);
  policy.commandChoices=[...new Set(policy.commandChoices.flatMap(command=>/^(?:npm|npx) /.test(command)?[command,command.replace(/^(npm|npx) /,'$1.cmd ')]:[command]))];
  return policy;
}

export async function approvedPath(policy,file){
  if(typeof file!=='string'||!file.trim())return false;
  if(isProtectedPath(policy,file))return false;
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

export async function approvedCommand(policy,value){
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
