import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {toAction as codexAction} from './codex.mjs';
import {webAccess,CLAUDE_WEB_TOOLS} from '../../web-access.mjs';

const shell = (prefixes) => prefixes.flatMap((p) => [`Bash(${p}:*)`, `PowerShell(${p}:*)`]);
const GIT_READ = ["git status", "git diff", "git log", "git show", "git rev-parse", "git ls-files"];
const GIT_WRITE = ["git commit", "git add", "git reset", "git checkout", "git switch", "git restore", "git stash", "git rebase", "git merge", "git push", "git tag", "git branch -d", "git branch -D", "git config"];
const CHECKS = ["npm test", "npm run test", "npm run typecheck", "npm run lint", "npx tsc", "npx eslint", "npx prettier"];

/** Claude Code enforces file scope through its own path-aware permissions. */
export function claudeImplementationTools({ task, toolGuard }) {
  const qa = task?.qaCommand?.trim();
  const paths = (task?.allowedPaths ?? []).map((p) => "./" + p.replaceAll("\\", "/").replace(/^\.\//, ""));
  const fileTools = ["Read", "Grep", "Glob", ...paths.flatMap((p) => [`Edit(${p})`, `Write(${p})`])];
  const allowed = toolGuard
    ? [...fileTools, ...shell([...GIT_READ, ...CHECKS, ...(qa ? [qa] : [])])]
    : [...fileTools, "Bash", "PowerShell"];
  const web = webAccess();
  const disallowed = ["Agent", ...(web ? [] : CLAUDE_WEB_TOOLS), "NotebookEdit", ...shell(GIT_WRITE)];
  return { allowed: web ? [...allowed, ...CLAUDE_WEB_TOOLS] : allowed, disallowed };
}

export const adapter = {
  id: "claude",
  label: "Claude Code",
  stateSubdir: null,
  maxHookInput: 2_000_000,
  capabilities: {
    narrowsToolSchema: false, enumeratesCommands: false, postToolEvents: false,
    outOfProcessHooks: true, counters: false, editDiscipline: false,
  },
  toAction(event) {
    const tool=String(event?.tool_name??'');
    // Answer-only tools: --json-schema returns the result through StructuredOutput; TodoWrite only updates the session's plan.
    if(['StructuredOutput','TodoWrite'].includes(tool))return {kind:'output',tool,input:event.tool_input,cwd:event.cwd};
    // Web access (Settings): the guard lets these through only when the policy says web access is on.
    if(['WebSearch','WebFetch'].includes(tool))return {kind:'web',tool,input:event.tool_input,cwd:event.cwd};
    if(['Edit','Write','NotebookEdit'].includes(tool))return {kind:'edit',tool,input:event.tool_input,paths:[event.tool_input?.file_path??event.tool_input?.notebook_path],patch:false,cwd:event.cwd};
    return codexAction(event);
  },
  toControl(decision) {
    return {exitCode:0,stdout:JSON.stringify(decision.effect==='allow'?{}:{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:decision.reason}})+'\n'};
  },
  reasons:{hookError:error=>'Protected-path hook failed: '+error.message},
  install({ task, toolGuard, model, effort, fast }) {
    const tools = claudeImplementationTools({ task, toolGuard });
    return { launchArgs: ["--permission-mode", "dontAsk",
      ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []),
      ...(fast ? ["--settings", JSON.stringify({ fastMode: true })] : []),
      "--allowedTools", ...tools.allowed, "--disallowedTools", ...tools.disallowed] };
  },
};

const hookScript=fileURLToPath(new URL('../../claude-protection-hook.mjs',import.meta.url));
/**
 * Settings › Experimental › sandboxed agent commands: Claude Code's own sandbox (macOS, Linux and WSL2; not native
 * Windows, where Agent Dock refuses the run instead) runs its shell commands with no network and writes only in the
 * workspace. It fails closed: no command runs unconfined when the sandbox cannot start, and none may ask to leave it.
 */
export const CLAUDE_SANDBOX=Object.freeze({enabled:true,failIfUnavailable:true,allowUnsandboxedCommands:false,network:{allowedDomains:[]}});
/** Oldest Claude Code whose sandbox takes the credentials rules below (guard plan 0c). */
export const CLAUDE_SANDBOX_MIN_VERSION='2.1.221';
// Sign-in files inside the hidden folders, denied by name as well (credentials.files) for commands.
const CREDENTIAL_FILES=['.git-credentials','.netrc','.npmrc','.pypirc','.aws/credentials','.codex/auth.json','.claude/.credentials.json','.docker/config.json','.config/gh/hosts.yml'];

/**
 * The sandbox for one run: commands can't read your sign-ins (homeSecrets under home) or the protected paths,
 * and can't write the protected paths. Plain paths are listed only when they exist (a deny on a missing path can
 * make the runtime create a placeholder); patterns are passed as they are. Git's folder stays writable when the
 * task may commit.
 */
export function claudeSandbox({workspace,protectedPaths=[],homeSecrets=[],home,allowGitCommit=false}) {
  const listed=rule=>{const p=path.resolve(workspace,rule.replace(/[\\/]+$/,''));return /[*?]/.test(rule)||existsSync(p)?[p]:[];};
  // Git must read its own folder for any command (status included); it stays unwritable unless the task commits.
  const isGit=rule=>/^\.git[\\/]?$/.test(rule);
  const protectedList=protectedPaths.filter(rule=>!isGit(rule)).flatMap(listed);
  const writeList=allowGitCommit?protectedList:protectedPaths.flatMap(listed);
  const secrets=homeSecrets.map(p=>path.join(home,p)).filter(p=>existsSync(p));
  return {...CLAUDE_SANDBOX,
    filesystem:{denyRead:[...new Set([...secrets,...protectedList])],denyWrite:[...new Set(writeList)]},
    credentials:{files:CREDENTIAL_FILES.map(p=>path.join(home,p)).filter(p=>existsSync(p)).map(p=>({path:p,mode:'deny'}))}};
}

/** Why Claude Code's sandbox can't confine this run, or null. */
export function claudeSandboxProblem({platform=process.platform,version}) {
  if(platform==='win32')return "Claude Code's sandbox does not run on native Windows. Run Agent Dock in WSL2 for sandboxed Claude runs, or turn the setting off for Claude.";
  const parts=v=>String(v??'').match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const have=parts(version),need=parts(CLAUDE_SANDBOX_MIN_VERSION);
  if(!have)return 'the Claude Code version could not be read';
  for(let i=0;i<3;i++){if(have[i]>need[i])return null;if(have[i]<need[i])return `Claude Code ${have.join('.')} is too old for the sandbox's read limits; update to ${CLAUDE_SANDBOX_MIN_VERSION} or later`;}
  return null;
}

export function claudeProtectionSettings({policyFile,logFile,fast=false,nodePath=process.execPath,sandbox=false,timeout=30}) {
  // sandbox: false, or the run's claudeSandbox(...) settings (true: the base settings, for callers without a policy).
  // Native hooks run in a shell: reject characters that could alter the generated command.
  const parts=[nodePath,hookScript,policyFile,logFile];
  if(parts.some(p=>typeof p!=='string'||/["`$%\r\n]/.test(p)))throw Error('Unsafe path for Claude protection hook');
  return {fastMode:fast,...(sandbox?{sandbox:sandbox===true?CLAUDE_SANDBOX:sandbox}:{}),hooks:{PreToolUse:[{matcher:'.*',hooks:[{type:'command',command:parts.map(p=>'"'+p+'"').join(' '),timeout:Math.round(timeout)}]}]}};
}

export default adapter;
