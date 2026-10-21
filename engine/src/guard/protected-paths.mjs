import path from 'node:path';
import {realpathSync,lstatSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stripCheckOutputFilter} from './check-output-filter.mjs';

const engineRoot=fileURLToPath(new URL('../../',import.meta.url));
// Same list as src/shared/defaults.ts: secrets, plus the folders and files that configure tools which run code
// (agent CLI settings and hooks, git hooks, CI workflows, editor tasks).
export const DEFAULTS=['.git/','.env*','secrets/','.claude/','.codex/','.opencode/','.clinerules','.husky/','.github/workflows/','.vscode/'];
const normalize=value=>process.platform==='win32'?value.replaceAll('\\','/').toLowerCase():value;
const within=(root,file)=>{const r=path.relative(root,file);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};

export function parseProtectedPaths(value) {
  const paths=typeof value==='string'?JSON.parse(value):value;
  if(!Array.isArray(paths)||paths.some(p=>typeof p!=='string'||!p.trim()||/[\0\r\n]/.test(p)))throw Error('Protected paths must be a JSON array of nonempty paths');
  return [...new Set(paths.map(p=>p.trim()))];
}

export function protectedPathsFor({workspace,stateDir,paths=[]}={}) {
  const configured=process.env.AGENT_DOCK_PROTECTED_PATHS?parseProtectedPaths(process.env.AGENT_DOCK_PROTECTED_PATHS):DEFAULTS;
  return [...new Set([...configured,...paths,engineRoot,...(stateDir?[path.resolve(stateDir)]:[])])];
}

/** The trusted launcher freezes its configuration before any worker starts. */
export function configureProtection({workspace,stateDir,paths}) {
  const values=paths===undefined?DEFAULTS:parseProtectedPaths(paths);
  process.env.AGENT_DOCK_PROTECTED_PATHS=JSON.stringify([...new Set([...values,engineRoot,path.resolve(stateDir)])]);
}

function canonical(file) {
  let ancestor=file;
  for(;;) {
    try{return path.resolve(realpathSync.native(ancestor),path.relative(ancestor,file));}
    catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}
  }
}

function glob(pattern) {
  let result='';
  for(let i=0;i<pattern.length;i++) {
    const c=pattern[i];
    if(c==='*'&&pattern[i+1]==='*'){i++;if(pattern[i+1]==='/'){i++;result+='(?:.*/)?';}else result+='.*';}
    else if(c==='*')result+='[^/]*';
    else if(c==='?')result+='[^/]';
    else result+=c.replace(/[\\^$+.[\]{}()|]/g,'\\$&');
  }
  return new RegExp('^'+result+'(?:/.*)?$');
}

/** Checks both the lexical name and the resolved target (including missing-file parents). */
export function isProtectedPath(policy,file,cwd=policy.workspace) {
  if(typeof file!=='string'||!file.trim()||file.includes('\0'))return true;
  // Device namespaces, drive-relative names, NTFS streams and trailing-dot aliases are ambiguous.
  if(process.platform==='win32'&&(/^(?:\\\\[?.]\\|[a-z]:(?![\\/]))/i.test(file)||file.replace(/^[a-z]:/i,'').includes(':')||file.split(/[\\/]/).some(p=>p!=='.'&&p!=='..'&&/[. ]$/.test(p))))return true;
  try {
    const absolute=path.resolve(cwd||policy.workspace,file),resolved=canonical(absolute);
    const candidates=[absolute,resolved].map(normalize);
    const workspace=canonical(path.resolve(policy.workspace));
    for(const rule of policy.protectedPaths??[]) {
      const trimmed=rule.replaceAll('\\','/').replace(/\/+$/,'');
      if(!trimmed)return true;
      if(!/[*?]/.test(trimmed)) {
        const base=path.resolve(policy.workspace,trimmed);
        if([base,canonical(base)].some(root=>[absolute,resolved].some(file=>within(root,file))))return true;
      } else {
        const absolutePattern=normalize(path.resolve(policy.workspace,trimmed)).replaceAll('\\','/');
        const matcher=glob(absolutePattern);
        if(candidates.some(p=>matcher.test(p.replaceAll('\\','/'))))return true;
        // Relative basename patterns also cover nested .env files.
        if(!trimmed.includes('/')&&!path.isAbsolute(rule)) {
          const match=glob(normalize(trimmed));
          if([absolute,resolved].some(p=>within(workspace,p)&&path.relative(workspace,p).split(path.sep).some(part=>match.test(normalize(part)))))return true;
        }
        // Resolve the non-glob prefix so an aliased workspace/root cannot bypass the pattern.
        const prefix=absolutePattern.slice(0,absolutePattern.search(/[*?]/));
        const slash=prefix.lastIndexOf('/');
        if(slash>=0){const canonicalPattern=normalize(canonical(prefix.slice(0,slash)||path.parse(absolute).root)).replaceAll('\\','/')+absolutePattern.slice(slash);if(candidates.some(p=>glob(canonicalPattern).test(p.replaceAll('\\','/'))))return true;}
      }
    }
    return false;
  }catch{return true;}
}

/** A recursive search/list/read may expose any descendant; bound the scan and fail closed. */
function safeRead(policy,file,cwd) {
  if(/[*?\[\]{}]/.test(file)||isProtectedPath(policy,file,cwd))return false;
  const queue=[path.resolve(cwd||policy.workspace,file)],seen=new Set();
  let count=0;
  while(queue.length) {
    const current=queue.pop(); if(++count>10000||isProtectedPath(policy,current))return false;
    try {
      const real=canonical(current);if(seen.has(real))continue;seen.add(real);
      if(lstatSync(real).isDirectory())for(const name of readdirSync(real))queue.push(path.join(current,name));
    }catch(error){if(error.code!=='ENOENT')return false;}
  }
  return true;
}

function pathsIn(input,out=[]) {
  if(!input||typeof input!=='object')return out;
  for(const [key,value] of Object.entries(input)) {
    if(/^(?:path|file_path|filePath|filepath|directory|dir|cwd|workdir|target_path)$/.test(key)&&typeof value==='string')out.push(value);
    else if(['paths','files'].includes(key)&&Array.isArray(value)){for(const item of value){if(typeof item==='string')out.push(item);else pathsIn(item,out);}}
    else if(value&&typeof value==='object')pathsIn(value,out);
  }
  return out;
}

// A QA commit message is free text: it may span lines and contain <>()[]!?*;| inside its quotes,
// but nothing a shell expands in quotes ($, backtick, %, ^, backslash). It becomes one opaque word.
const COMMIT_MESSAGE='__AGENT_DOCK_COMMIT_MESSAGE__';
const quotedMessages=script=>script.replace(/(\s-m\s+)(?:"([^"$`%^\\\0]*)"|'([^'$`%^\\\0]*)')(?=\s|$)/g,(_,flag,dq,sq)=>((dq??sq).trim()?flag+COMMIT_MESSAGE:_));

function commandSafe(policy,script,cwd) {
  script=stripCheckOutputFilter(script);
  if(typeof script==='string'&&/\bgit\s+commit\b/.test(script))script=quotedMessages(script);
  // ";" runs commands one after another, like "&&" (Windows PowerShell 5.1 has no "&&"): every part must be safe.
  if(typeof script==='string'&&script.includes(';')&&!/[\r\n|]/.test(script)){
    const parts=script.split(';').map(p=>p.trim());
    if(parts.at(-1)==='')parts.pop();
    return parts.length>1&&parts.every(p=>p&&commandSafe(policy,p,cwd));
  }
  if(typeof script!=='string'||/[\r\n`$%^<>;|\x00(){}\[\]!*?]/.test(script))return false;
  if(process.platform!=='win32'&&script.includes('\\'))return false;
  if(script.includes('&&'))return script.split('&&').every(part=>commandSafe(policy,part,cwd));
  if(script.includes('&'))return false;
  const text=script.trim(),parts=[];
  const token=/\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)(?=\s|$)/gy;
  while(token.lastIndex<text.length){const match=token.exec(text);if(!match)return false;parts.push(match[0].trim());}
  const words=parts.map(p=>p.replace(/^(['"])(.*)\1$/,'$2'));
  const command=words.shift()?.toLowerCase();if(!command)return false;
  // Approved project checks execute trusted project code, not arbitrary model-written shell.
  if(['npm','npm.cmd','npx','npx.cmd'].includes(command)) {
    if(command.startsWith('npm')&&!((words[0]==='run'&&/^[\w:-]+$/.test(words[1]??'')&&!words[1].startsWith('-'))||words[0]==='test'))return false;
    // npm consumes its own options unless script arguments follow an explicit separator.
    // In particular, --script-shell/--node-options must never be model-controlled.
    if(command.startsWith('npm')){const end=words[0]==='run'?2:1;if(words.length>end&&words[end]!=='--')return false;}
    if(command.startsWith('npx')&&!['tsc','eslint','prettier','vitest','playwright'].includes(words[0]))return false;
    if(words.some(w=>/^--(?:prefix|cwd|config|require|import|eval|package|call|yes|script-shell|node-options|userconfig|globalconfig)(?:=|$)/i.test(w)))return false;
    const normalized=script.trim().replace(/^(npm|npx)\.cmd\b/i,'$1').replace(/\s+/g,' ');
    const approved=[policy.qaCommand,...(policy.approvedCommands??[]),'npm test','npm run test','npm run lint','npm run typecheck','npm run build','npm run format:check'];
    if(!approved.includes(normalized))return false;
    return words.every(w=>!w.includes('/')&&!w.includes('\\')&&!w.startsWith('.')||!isProtectedPath(policy,w,cwd));
  }
  if(command==='git') {
    if(words.some(w=>w.startsWith(':')||w.startsWith(':/')))return false;
    if(words.some(w=>/^(?:-c|--git-dir|--work-tree|--exec-path|--no-index|--output|--ext-diff|--textconv)/.test(w)))return false;
    if(words.length===1&&words[0]==='--version')return true;
    if(['status','rev-parse','ls-files'].includes(words[0]))return words.every(w=>!w.includes('/')&&!w.includes('\\')&&!w.startsWith('.')||!isProtectedPath(policy,w,cwd));
    if(words[0]==='diff'&&words.length===2&&['--check','--stat','--numstat','--name-only'].includes(words[1]))return true;
    if(words[0]==='branch'&&words[1]==='--show-current'&&words.length===2)return true;
    // Names of stashed work (a task set aside); never the stashed content.
    if(words[0]==='stash'&&words[1]==='list'&&words.length===2)return true;
    // History without content: commit messages and file names, never a patch (it could show protected files).
    const REV=/^(?:HEAD(?:~\d{1,4}|\^{1,4})?|[a-f0-9]{7,40})(?:\.\.(?:HEAD(?:~\d{1,4}|\^{1,4})?|[a-f0-9]{7,40}))?$/;
    const LIST=new Set(['--oneline','--stat','--name-only','--name-status','--no-color','--decorate','--no-decorate']);
    if(words[0]==='log')return words.slice(1).every((w,i,all)=>LIST.has(w)||/^-\d{1,4}$/.test(w)||(w==='-n'&&/^\d{1,4}$/.test(all[i+1]??''))||(/^\d{1,4}$/.test(w)&&all[i-1]==='-n')||REV.test(w));
    if(words[0]==='show'&&words.slice(1).some(w=>['--stat','--name-only','--name-status'].includes(w)))return words.slice(1).every(w=>LIST.has(w)||REV.test(w))&&words.slice(1).filter(w=>REV.test(w)).length<=1;
    if(words[0]==='show'&&words.length===2&&/^(?:HEAD|[a-f0-9]{7,40}):/.test(words[1]))return safeRead(policy,words[1].slice(words[1].indexOf(':')+1),cwd);
    if(['add','commit'].includes(words[0])&&policy.allowGitCommit) {
      // QA commits only after engine scope verification; reject paths naming protected content.
      if(words[0]==='add')return words.length>1&&words.slice(1).filter(w=>w!=='--').every(w=>!w.startsWith('-')&&safeRead(policy,w,cwd));
      // commit [-q|--quiet] -m <message> [-m <message>…]; nothing else (no -a, --amend, paths or hook bypass).
      const rest=words.slice(1);let messages=0;
      for(let i=0;i<rest.length;i++){
        if(rest[i]==='-q'||rest[i]==='--quiet')continue;
        if(rest[i]==='-m'&&rest[i+1]?.trim()&&!rest[i+1].startsWith('-')){messages++;i++;continue;}
        return false;
      }
      return messages>0;
    }
    if(words[0]!=='diff')return false;
    const divider=words.indexOf('--');
    if(divider>=0&&divider<words.length-1)return words.slice(1,divider).every(w=>['HEAD','--cached','--staged','--check','--stat','--numstat','--name-only','--no-ext-diff','--no-color'].includes(w))&&words.slice(divider+1).every(w=>safeRead(policy,w,cwd));
    if(words.slice(1).some(w=>!['HEAD','--cached','--staged','--no-ext-diff','--no-color'].includes(w)))return false;
    try {const files=execFileSync('git',['ls-files','-z'],{cwd,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024,timeout:5000}).split('\0').filter(Boolean);return files.every(p=>!isProtectedPath(policy,p,cwd));}catch{return false;}
  }
  // Conservative grammar: no wrappers, expansion, scripts, response files, or write-capable flags.
  if(['pwd','get-location'].includes(command))return words.length===0;
  if(!['cat','type','get-content','head','tail','ls','dir','get-childitem','rg','grep','findstr','select-string','wc','test-path','resolve-path'].includes(command))return false;
  if(words.some(w=>w.startsWith('-')||w.startsWith('@')||w.includes('~')))return false;
  if(['rg','grep','findstr','select-string'].includes(command))words.shift();
  return (words.length?words:['.']).every(file=>safeRead(policy,file,cwd));
}

export function protectedActionReason(policy,action) {
  if(!policy.protectedPaths?.length)return null;
  const denied='Protected-path policy refused this tool call';
  // Output-only tools touch no files or processes.
  if(action.kind==='output')return null;
  const cwd=action.cwd||policy.workspace;
  if(isProtectedPath(policy,cwd))return denied;
  if(action.kind==='command')return action.commands?.length&&action.commands.every(command=>{
    if(typeof command==='string')return commandSafe(policy,command,cwd);
    if(typeof command?.command!=='string'||!Array.isArray(command.args)||command.args.some(arg=>typeof arg!=='string'||/[\s"']/.test(arg)))return false;
    return commandSafe(policy,[command.command,...command.args].join(' '),cwd);
  })?null:denied;
  if(action.kind==='unknown')return denied;
  const paths=[...(action.paths??[]),...pathsIn(action.input)];
  if(action.kind==='edit')return paths.length&&paths.every(file=>!isProtectedPath(policy,file,cwd))?null:denied;
  if(action.kind==='read'||/search|grep|glob|list|find/i.test(action.tool??''))return (paths.length?paths:['.']).every(file=>safeRead(policy,file,cwd))?null:denied;
  return paths.every(file=>!isProtectedPath(policy,file,cwd))?null:denied;
}

/** Assessment chooses the check command; it does not get to invent a shell program. */
export function assertSafeQaCommand({workspace,stateDir,command}) {
  const normalized=typeof command==='string'?command.trim():'';
  if(normalized==='node --version')return;
  const steps=normalized.split(/\s*&&\s*/);
  if(!steps.length||steps.some(step=>! /^(?:npm|npx)(?:\.cmd)?\s|^git\s/.test(step)))throw Error('QA command is not an approved project check');
  const policy={workspace,protectedPaths:protectedPathsFor({workspace,stateDir}),qaCommand:normalized,approvedCommands:steps.map(step=>step.replace(/^(npm|npx)\.cmd\b/i,'$1').replace(/\s+/g,' '))};
  if(protectedActionReason(policy,{kind:'command',tool:'qa-check',commands:[normalized]}))throw Error('QA command is unsafe or accesses protected paths; use a project npm script or a supported local check');
}
