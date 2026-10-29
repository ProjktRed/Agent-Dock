import path from 'node:path';
import {realpathSync,lstatSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stripCheckOutputFilter} from './check-output-filter.mjs';
import { safeGitArgs } from '../git-safe.mjs';

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

/** The real location of a path that may not exist yet: its closest existing parent resolved. */
export function canonical(file) {
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
  return protectionChecker(policy)(file,cwd);
}

/**
 * isProtectedPath for many files checked together (a working tree's changed files): the workspace and each
 * rule's own location are resolved once, on the first call; each file is still resolved when it is checked.
 * Not for access decisions: a rule location that another process changes during the batch is missed. Used for
 * QA evidence (which changed files are under protected paths) and the workspace fingerprint, never by the hooks.
 */
export function protectionChecker(policy) {
  let rules=null;
  const prepare=()=>{
    const workspace=canonical(path.resolve(policy.workspace));
    const list=(policy.protectedPaths??[]).map(rule=>{
      const trimmed=rule.replaceAll('\\','/').replace(/\/+$/,'');
      if(!trimmed)return {all:true};
      if(!/[*?]/.test(trimmed)){const base=path.resolve(policy.workspace,trimmed);return {roots:[base,canonical(base)]};}
      const absolutePattern=normalize(path.resolve(policy.workspace,trimmed)).replaceAll('\\','/');
      // Relative basename patterns also cover nested .env files.
      const basename=!trimmed.includes('/')&&!path.isAbsolute(rule)?glob(normalize(trimmed)):null;
      // Resolve the non-glob prefix so an aliased workspace/root cannot bypass the pattern.
      const prefix=absolutePattern.slice(0,absolutePattern.search(/[*?]/));
      const slash=prefix.lastIndexOf('/');
      const canonicalFor=slash<0?null:prefix.slice(0,slash)
        ?(()=>{const m=glob(normalize(canonical(prefix.slice(0,slash))).replaceAll('\\','/')+absolutePattern.slice(slash));return ()=>m;})()
        :(absolute)=>glob(normalize(canonical(path.parse(absolute).root)).replaceAll('\\','/')+absolutePattern.slice(slash));
      return {matcher:glob(absolutePattern),basename,canonicalFor};
    });
    return {workspace,list};
  };
  return (file,cwd=policy.workspace)=>{
    if(typeof file!=='string'||!file.trim()||file.includes('\0'))return true;
    // Device namespaces, drive-relative names, NTFS streams and trailing-dot aliases are ambiguous.
    if(process.platform==='win32'&&(/^(?:\\\\[?.]\\|[a-z]:(?![\\/]))/i.test(file)||file.replace(/^[a-z]:/i,'').includes(':')||file.split(/[\\/]/).some(p=>p!=='.'&&p!=='..'&&/[. ]$/.test(p))))return true;
    try {
      rules??=prepare();
      const absolute=path.resolve(cwd||policy.workspace,file),resolved=canonical(absolute);
      const candidates=[absolute,resolved].map(normalize);
      const {workspace}=rules;
      for(const rule of rules.list) {
        if(rule.all)return true;
        if(rule.roots){if(rule.roots.some(root=>[absolute,resolved].some(file=>within(root,file))))return true;continue;}
        if(candidates.some(p=>rule.matcher.test(p.replaceAll('\\','/'))))return true;
        if(rule.basename&&[absolute,resolved].some(p=>within(workspace,p)&&path.relative(workspace,p).split(path.sep).some(part=>rule.basename.test(normalize(part)))))return true;
        if(rule.canonicalFor){const m=rule.canonicalFor(absolute);if(candidates.some(p=>m.test(p.replaceAll('\\','/'))))return true;}
      }
      return false;
    }catch{return true;}
  };
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

export function pathsIn(input,out=[]) {
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
// cmd.exe does not read ' as a quote, so a single-quoted message must also be safe unquoted there:
// no & | < > " ! and no line break. PowerShell also ends a quote at a curly one (U+2018-U+201F).
const COMMIT_MESSAGE='__AGENT_DOCK_COMMIT_MESSAGE__';
const quotedMessages=script=>script.replace(/(\s-m\s+)(?:"([^"$`%^\\\0‘-‟]*)"|'([^'$`%^\\\0&|<>"!\r\n‘-‟]*)')(?=\s|$)/g,(_,flag,dq,sq)=>((dq??sq).trim()?flag+COMMIT_MESSAGE:_));

// History may name commits only: git prints the contents of a blob given to show or log.
const HEAD_REV=/^HEAD(?:~\d{1,4}|\^{1,4})?$/;
function commitRevs(words,cwd) {
  for(const word of words)for(const rev of word.split('..')) {
    if(HEAD_REV.test(rev))continue;
    try{if(execFileSync('git',safeGitArgs(['cat-file','-t',rev]),{cwd,encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','ignore']}).trim()!=='commit')return false;}catch{return false;}
  }
  return true;
}

// Options a project check may not take: they write reports or build output somewhere, or load
// configuration and plugins from a path.
const CHECK_OUTPUT_OPTION=/^--?(?:o|out[\w.-]*|output[\w.-]*|cache-location|cache-file|declarationdir|tsbuildinfofile|generatetrace|plugin[\w-]*|rulesdir|resolve-plugins-relative-to|ignore-path)$/i;
// Options that rewrite the files a check is given (formatting, fixes, snapshots): each of those files,
// and everything under a folder, must be readable and outside protected paths.
const CHECK_REWRITE_OPTION=/^--?(?:write|fix[\w-]*|u|update[\w-]*)$/i;

// Read-only commands and the options each may take. A value is a number, an encoding, a search
// pattern or a path (checked like any other file). Anything else (wildcards, -Stream, -Wait, --pre,
// pattern files, findstr /s) is refused. PowerShell long options are matched without case.
const NUM=/^\d{1,7}$/,CONTEXT=/^\d{1,4}$/,ENCODING=/^[a-z0-9-]{1,20}$/i;
const PS_PATH={'-path':'path','-literalpath':'path'};
const GET_CONTENT={kind:'read',flags:['-raw','-force'],values:{...PS_PATH,'-totalcount':NUM,'-head':NUM,'-first':NUM,'-tail':NUM,'-last':NUM,'-readcount':NUM,'-encoding':ENCODING}};
const PS_LIST={kind:'list',flags:['-force','-name','-file','-directory','-hidden'],recursive:['-recurse','-depth'],values:{...PS_PATH,'-depth':NUM}};
const UNIX_SEARCH={kind:'search',short:'nilcwFvHhsSEr',flags:['-R','--line-number','--ignore-case','--files-with-matches','--count','--word-regexp','--fixed-strings','--invert-match','--no-heading','--heading','--with-filename','--no-filename','--column','--smart-case','--case-sensitive','--color=never'],
  values:{'-e':'pattern','--regexp':'pattern','-m':NUM,'--max-count':NUM,'-A':NUM,'-B':NUM,'-C':NUM,'--context':NUM}};
const READ_COMMANDS={
  cat:{...GET_CONTENT,short:'n'},type:GET_CONTENT,'get-content':GET_CONTENT,gc:GET_CONTENT,
  head:{kind:'read',values:{'-n':NUM,'-c':NUM}},tail:{kind:'read',values:{'-n':NUM,'-c':NUM}},
  wc:{kind:'read',short:'lwcm'},
  ls:{...PS_LIST,short:'la1hR',recursive:['-recurse','-depth','-r','-R']},dir:PS_LIST,'get-childitem':PS_LIST,gci:PS_LIST,
  'test-path':{kind:'exists',values:PS_PATH},'resolve-path':{kind:'exists',values:PS_PATH},
  rg:{...UNIX_SEARCH,flags:[...UNIX_SEARCH.flags,'--files']},grep:UNIX_SEARCH,
  findstr:{kind:'search',slash:['/i','/n','/l','/r','/v','/x','/b','/e','/m','/o']},
  'select-string':{kind:'search',flags:['-simplematch','-casesensitive','-list','-notmatch','-allmatches','-quiet','-raw'],values:{...PS_PATH,'-pattern':'pattern','-context':CONTEXT,'-encoding':ENCODING}},
};

function readCommandSafe(policy,command,words,cwd) {
  const spec=READ_COMMANDS[command];
  if(words.some(w=>w.startsWith('@')||w.includes('~')))return false;
  // PowerShell reads a,b as two paths, and env:NAME, variable:x, HKLM:… as provider paths (pwsh on Linux too).
  if(words.some(w=>w.includes(',')||(/^[A-Za-z][\w-]*:/.test(w)&&!/^[A-Za-z]:[\\/]/.test(w))))return false;
  // Values of -Path/-LiteralPath are files whatever their position; only a positional word can be the pattern.
  const files=[],named=[];let pattern=false,recursive=false;
  for(let i=0;i<words.length;i++) {
    const word=words[i];
    if(command==='findstr'&&word.startsWith('/')) {
      if(/^\/c:./i.test(word)){pattern=true;continue;}
      if(!spec.slash.includes(word.toLowerCase()))return false;
      continue;
    }
    if(!word.startsWith('-')||word==='-'){if(word==='-')return false;files.push(word);continue;}
    const key=/^-[a-z]{2,}$/i.test(word)?word.toLowerCase():word;
    if(spec.recursive?.includes(key)){recursive=true;if(key!=='-depth')continue;}
    if(spec.flags?.includes(key)){if(key==='--files')pattern=true,recursive=true;continue;}
    const kind=spec.values?.[key];
    if(kind) {
      const value=words[++i];if(value===undefined)return false;
      if(kind==='path')named.push(value);
      else if(kind==='pattern')pattern=true;
      else if(!kind.test(value))return false;
      continue;
    }
    // Short options may be combined: -rn, -la.
    if(spec.short&&/^-[A-Za-z0-9]{2,}$/.test(word)&&[...word.slice(1)].every(c=>spec.short.includes(c))){if(command==='ls'&&/[rR]/.test(word))recursive=true;continue;}
    if(spec.short&&/^-[A-Za-z0-9]$/.test(word)&&spec.short.includes(word[1]))continue;
    return false;
  }
  if(spec.kind==='search'&&!pattern){if(!files.length)return false;files.shift();}
  const targets=[...named,...files].length?[...named,...files]:['.'];
  if(spec.kind==='exists'||(spec.kind==='list'&&!recursive))return targets.every(file=>!/[*?\[\]{}]/.test(file)&&!isProtectedPath(policy,file,cwd));
  return targets.every(file=>safeRead(policy,file,cwd));
}

// PowerShell reads "a, b" as a list. A file read may name several files that way (each is checked like a
// single file); a comma inside quotes, or in any other command, is still refused below.
const LIST_READS=new Set(['get-content','gc','cat','type']);
function fileList(script) {
  if(process.platform!=='win32'||!script.includes(',')||script.includes('&')||!LIST_READS.has(script.trim().split(/\s+/)[0].toLowerCase()))return script;
  let out='',quote=null;
  for(let i=0;i<script.length;i++) {
    const c=script[i];
    if(quote){if(c===quote)quote=null;else if(c===',')return script;out+=c;continue;}
    if(c==='"'||c==="'"){quote=c;out+=c;continue;}
    // Every item is a file: "a,-Raw" is a file named -Raw to PowerShell, so an item like an option is refused.
    if(c===','){out=out.trimEnd();while(script[i+1]===' ')i++;if(/(?:^|\s)-\S*$/.test(out)||script[i+1]==='-'||!script[i+1])return script;out+=' ';continue;}
    out+=c;
  }
  return out;
}
// Version and location of an installed tool: prints a line, changes nothing. Found by the shell on PATH, never
// a file in the project (PowerShell and POSIX shells do not run programs from the current folder by name).
const VERSION_TOOLS=new Set(['node','rustc','cargo','python','python3','go','dotnet','deno','bun','pnpm','yarn','tsc']);

function commandSafe(policy,script,cwd) {
  script=stripCheckOutputFilter(script);
  if(typeof script==='string'&&/\bgit\s+commit\b/.test(script))script=quotedMessages(script);
  // Plain ASCII only outside a checked commit message: PowerShell reads several Unicode characters as
  // syntax (dashes as "-", curly quotes as quotes, other spaces as separators), and each review found
  // another. A file name that is not ASCII is refused too; the agent reads it another way.
  if(typeof script==='string'&&/[^\x20-\x7e]/.test(script))return false;
  // ";" runs commands one after another, like "&&" (Windows PowerShell 5.1 has no "&&"): every part must be safe.
  if(typeof script==='string'&&script.includes(';')&&!/[\r\n|]/.test(script)){
    const parts=script.split(';').map(p=>p.trim());
    if(parts.at(-1)==='')parts.pop();
    return parts.length>1&&parts.every(p=>p&&commandSafe(policy,p,cwd));
  }
  if(typeof script==='string')script=fileList(script);
  // PowerShell also reads an en dash, em dash or horizontal bar as the "-" of a parameter, curly quotes
  // (U+2018-U+201F) as quotes, and a,b as two arguments (a commit message's commas are masked above).
  if(typeof script!=='string'||/[\r\n`$%^<>;|\x00(){}\[\]!*?,\u2013\u2014\u2015\u2018-\u201f]/.test(script))return false;
  if(process.platform!=='win32'&&script.includes('\\'))return false;
  if(script.includes('&&'))return script.split('&&').every(part=>commandSafe(policy,part,cwd));
  if(script.includes('&'))return false;
  const text=script.trim(),parts=[];
  const token=/\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)(?=\s|$)/gy;
  while(token.lastIndex<text.length){const match=token.exec(text);if(!match)return false;parts.push(match[0].trim());}
  const words=parts.map(p=>p.replace(/^(['"])(.*)\1$/,'$2'));
  const command=words.shift()?.toLowerCase();if(!command)return false;
  if(words.length===1&&words[0]==='--version'&&VERSION_TOOLS.has(command.replace(/\.exe$/,'')))return true;
  if(['where.exe','get-command','gcm'].includes(command))return words.length===1&&/^[\w.-]{1,64}$/.test(words[0])&&!words[0].startsWith('-');
  // Approved project checks execute trusted project code, not arbitrary model-written shell.
  if(['npm','npm.cmd','npx','npx.cmd'].includes(command)) {
    if(command.startsWith('npm')&&!((words[0]==='run'&&/^[\w:-]+$/.test(words[1]??'')&&!words[1].startsWith('-'))||words[0]==='test'))return false;
    // npm consumes its own options unless script arguments follow an explicit separator.
    // In particular, --script-shell/--node-options must never be model-controlled.
    if(command.startsWith('npm')){const end=words[0]==='run'?2:1;if(words.length>end&&words[end]!=='--')return false;}
    // npx --no-install runs only what the project already has (plain npx may download a package).
    if(command.startsWith('npx')&&words[0]==='--no-install')words.shift();
    if(command.startsWith('npx')&&!['tsc','eslint','prettier','vitest','playwright'].includes(words[0]))return false;
    if(words.some(w=>/^--(?:prefix|cwd|config|require|import|eval|package|call|yes|script-shell|node-options|userconfig|globalconfig)(?:=|$)/i.test(w)))return false;
    if(words.some(w=>CHECK_OUTPUT_OPTION.test(w.split('=')[0])))return false;
    const rewrites=words.some(w=>CHECK_REWRITE_OPTION.test(w.split('=')[0]));
    const normalized=script.trim().replace(/^(npm|npx)\.cmd\b/i,'$1').replace(/\s+/g,' ');
    const approved=[policy.qaCommand,...(policy.approvedCommands??[]),'npm test','npm run test','npm run lint','npm run typecheck','npm run build','npm run format:check'];
    if(!approved.includes(normalized))return false;
    // Every argument and every --option=value may name a file; none may be protected.
    return words.slice(command.startsWith('npm')&&words[0]==='run'?2:1).flatMap(w=>{const value=w.match(/^-[^=]*=(.*)$/s);return value?[value[1]]:w.startsWith('-')?[]:[w];}).every(w=>!w||(rewrites?safeRead(policy,w,cwd):!isProtectedPath(policy,w,cwd)));
  }
  if(command==='git') {
    if(words.some(w=>w.startsWith(':')||w.startsWith(':/')))return false;
    if(words.some(w=>/^(?:-c|--git-dir|--work-tree|--exec-path|--no-index|--output|--ext-diff|--textconv)/.test(w)))return false;
    if(words.length===1&&words[0]==='--version')return true;
    if(['status','rev-parse','ls-files'].includes(words[0]))return words.every(w=>!w.includes('/')&&!w.includes('\\')&&!w.startsWith('.')||!isProtectedPath(policy,w,cwd));
    // Which files changed (worktree, staged, or against HEAD), never their content.
    const SUMMARY=['--check','--stat','--numstat','--name-only','--name-status'];
    if(words[0]==='diff'&&words.slice(1).some(w=>SUMMARY.includes(w))&&words.slice(1).every(w=>SUMMARY.includes(w)||['HEAD','--cached','--staged','--no-color','--no-ext-diff'].includes(w)))return true;
    if(words[0]==='branch'&&words[1]==='--show-current'&&words.length===2)return true;
    // Names of stashed work (a task set aside); never the stashed content.
    if(words[0]==='stash'&&words[1]==='list'&&words.length===2)return true;
    // History without content: commit messages and file names, never a patch (it could show protected files).
    const REV=/^(?:HEAD(?:~\d{1,4}|\^{1,4})?|[a-f0-9]{7,40})(?:\.\.(?:HEAD(?:~\d{1,4}|\^{1,4})?|[a-f0-9]{7,40}))?$/;
    const LIST=new Set(['--oneline','--stat','--name-only','--name-status','--no-color','--decorate','--no-decorate']);
    if(words[0]==='log')return words.slice(1).every((w,i,all)=>LIST.has(w)||/^-\d{1,4}$/.test(w)||(w==='-n'&&/^\d{1,4}$/.test(all[i+1]??''))||(/^\d{1,4}$/.test(w)&&all[i-1]==='-n')||REV.test(w))&&commitRevs(words.slice(1).filter(w=>REV.test(w)&&!/^\d{1,4}$/.test(w)),cwd);
    if(words[0]==='show'&&words.slice(1).some(w=>['--stat','--name-only','--name-status'].includes(w)))return words.slice(1).every(w=>LIST.has(w)||REV.test(w))&&words.slice(1).filter(w=>REV.test(w)).length<=1&&commitRevs(words.slice(1).filter(w=>REV.test(w)),cwd);
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
    try {const files=execFileSync('git',safeGitArgs(['ls-files','-z']),{cwd,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024,timeout:5000}).split('\0').filter(Boolean);return files.every(p=>!isProtectedPath(policy,p,cwd));}catch{return false;}
  }
  // Conservative grammar: no wrappers, expansion, scripts, response files, or write-capable flags.
  if(['pwd','get-location'].includes(command))return words.length===0;
  if(!Object.hasOwn(READ_COMMANDS,command))return false;
  return readCommandSafe(policy,command,words,cwd);
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
  // MCP and other unknown tools: refused whatever toolGuard says (guard plan 0b); Ask can still put one to you.
  if(action.kind==='unknown')return `${denied}: ${String(action.tool??'this tool').slice(0,100)} is not a tool the guard knows (MCP and unknown tools are refused)`;
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
