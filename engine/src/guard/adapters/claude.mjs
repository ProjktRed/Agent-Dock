import {fileURLToPath} from 'node:url';
import {toAction as codexAction} from './codex.mjs';

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
  const disallowed = ["Agent", "WebFetch", "WebSearch", "NotebookEdit", ...shell(GIT_WRITE)];
  return { allowed, disallowed };
}

export const adapter = {
  id: "claude",
  label: "Claude Code",
  stateSubdir: null,
  capabilities: {
    narrowsToolSchema: false, enumeratesCommands: false, postToolEvents: false,
    outOfProcessHooks: true, counters: false, editDiscipline: false,
  },
  toAction(event) {
    const tool=String(event?.tool_name??'');
    // Answer-only tools: --json-schema returns the result through StructuredOutput; TodoWrite only updates the session's plan.
    if(['StructuredOutput','TodoWrite'].includes(tool))return {kind:'output',tool,input:event.tool_input,cwd:event.cwd};
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
 * Settings › Experimental › sandboxed agent commands: Claude Code's own sandbox (Anthropic's sandbox runtime;
 * on Windows the srt-sandbox account) runs its shell commands with no network and writes only in the workspace.
 * It fails closed: no command runs unconfined when the sandbox cannot start, and none may ask to leave it.
 */
export const CLAUDE_SANDBOX=Object.freeze({enabled:true,failIfUnavailable:true,allowUnsandboxedCommands:false,network:{allowedDomains:[]}});

export function claudeProtectionSettings({policyFile,logFile,fast=false,nodePath=process.execPath,sandbox=false,timeout=30}) {
  // Native hooks run in a shell: reject characters that could alter the generated command.
  const parts=[nodePath,hookScript,policyFile,logFile];
  if(parts.some(p=>typeof p!=='string'||/["`$%\r\n]/.test(p)))throw Error('Unsafe path for Claude protection hook');
  return {fastMode:fast,...(sandbox?{sandbox:CLAUDE_SANDBOX}:{}),hooks:{PreToolUse:[{matcher:'.*',hooks:[{type:'command',command:parts.map(p=>'"'+p+'"').join(' '),timeout:Math.round(timeout)}]}]}};
}

export default adapter;
