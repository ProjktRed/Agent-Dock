import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {launchSpec} from '../cmd-line.mjs';
import {CLAUDE_AUTH_ENV,withoutSecrets} from '../secret-env.mjs';
import {protectedPathsFor} from './protected-paths.mjs';
import {codexScopeHookArgs} from './adapters/codex.mjs';
import os from 'node:os';
import {claudeProtectionSettings,claudeSandbox,claudeSandboxProblem} from './adapters/claude.mjs';
import {assertNoRepoCliConfig} from './repo-config.mjs';
import {agentsSandboxed,HOME_SECRETS} from '../sandbox.mjs';
import {actionAsk,hookTimeoutSeconds} from './ask.mjs';
import {webAccess,codexWebSearchArgs} from '../web-access.mjs';
import {codexConfinement} from './codex-confinement.mjs';
import {codexAuthEnv} from '../codex-provider-env.mjs';
import {appendAction,actionLogKeyHex} from '../action-log.mjs';

/** Codex on Windows: its elevated sandbox (separate sandbox accounts and firewall rules) for every command. */
export const CODEX_WINDOWS_SANDBOX=Object.freeze(['-c','windows.sandbox="elevated"']);

// Read once per CLI: a sandboxed Claude run needs a Claude Code whose sandbox takes the read limits (0c).
const claudeVersions=new Map();
function claudeVersion(launcher){
  if(!launcher?.command)return null;
  const key=JSON.stringify([launcher.command,launcher.prefixArgs??[]]);
  if(!claudeVersions.has(key)){
    const launch=launchSpec(launcher.command,[...(launcher.prefixArgs??[]),'--version']);
    const result=spawnSync(launch.command,launch.args,{...launch.options,env:withoutSecrets(launcher.env??process.env,{keep:CLAUDE_AUTH_ENV}),windowsHide:true,encoding:'utf8',timeout:30_000});
    claudeVersions.set(key,result.status===0?String(result.stdout):null);
  }
  return claudeVersions.get(key);
}

/**
 * Codex types into a running command (write_stdin) without a hook call, and only a terminal keeps a command's input
 * open (without one Codex answers "stdin is closed for this session"): an approved `npm run check` whose script
 * started a shell took `cat .env` that way (kadono 0.40.1 probe). So Codex runs without terminals, and Codex's own
 * feature list must agree. A list that can't be read (an older or wrapped CLI) leaves it unconfirmed in the
 * attestation; one that shows terminals still on refuses the run. Answers are reused for ten minutes per CLI.
 */
export const CODEX_NO_TTY=Object.freeze(['-c','features.unified_exec_tty=false']);
const ttyChecks=new Map();
export function codexTtyCheck(launcher){
  if(!launcher?.command)return {ok:true,confirmed:false};
  const key=JSON.stringify([launcher.command,launcher.prefixArgs??[]]),cached=ttyChecks.get(key);
  if(cached&&Date.now()-cached.at<10*60_000)return cached.result;
  const launch=launchSpec(launcher.command,[...(launcher.prefixArgs??[]),...CODEX_NO_TTY,'features','list']);
  const run=spawnSync(launch.command,launch.args,{...launch.options,env:launcher.env??process.env,windowsHide:true,encoding:'utf8',timeout:30_000});
  const features=new Map(String(run.stdout??'').split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(f=>/^[a-z_]+$/.test(f[0]??'')&&/^(true|false)$/.test(f.at(-1))).map(f=>[f[0],f.at(-1)]));
  const result=run.status!==0||!features.size?{ok:true,confirmed:false}
    : features.get('unified_exec_tty')==='false'?{ok:true,confirmed:true}
    : features.has('unified_exec_tty')||features.get('unified_exec')==='true'?{ok:false}
    : {ok:true,confirmed:false};
  // A refusal is checked again next time (a Codex update may fix it).
  if(result.ok)ttyChecks.set(key,{at:Date.now(),result});
  return result;
}
/** Test hook: forget cached terminal checks. */
export function resetCodexTtyChecks(){ttyChecks.clear();}
export const CODEX_TTY_REFUSED='Agent Dock runs Codex without terminals, so Codex cannot type into a running command, but this Codex keeps them on (features.unified_exec_tty). Update Codex.';

/**
 * Policies and hooks live in trusted state, outside the agent's writable task scope. Codex gets its hook
 * only here, with hook review turned off, so a repository's own Codex hooks stop the call first.
 */
// Claude Code's own report of its sandbox for these settings (`claude sandbox status`), or null when it has none.
function claudeSandboxStatus(launcher,settings,workspace){
  if(!launcher?.command)return null;
  const launch=launchSpec(launcher.command,[...(launcher.prefixArgs??[]),'--settings',settings,'sandbox','status']);
  const result=spawnSync(launch.command,launch.args,{...launch.options,cwd:workspace,env:withoutSecrets(launcher.env??process.env,{keep:CLAUDE_AUTH_ENV}),windowsHide:true,encoding:'utf8',timeout:30_000});
  try{return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));}catch{return null;}
}

/**
 * Claude Code's subprocess scrub (claudeChildEnv) brings its own sandbox on Linux and macOS, even for runs that aren't
 * sandboxed, and when that sandbox can't start (bubblewrap or socat missing) every command fails while the run
 * reports success (kadono 0.40.1 probe). So outside Windows the scrub stays on only when Claude Code reports its
 * sandbox able to run; otherwise a run signed in without a key in its environment goes without it, a run with one is
 * refused (installProtection), and the attestation says which. A status it can't report keeps the scrub
 * (claudeSandboxFailure catches a failed start).
 * Runs with sandboxed commands are checked at their start anyway. Answers are reused for ten minutes per CLI.
 */
const scrubChecks=new Map();
export function claudeScrubProblem(launcher,workspace,platform=process.platform){
  if(platform==='win32'||!launcher?.command||agentsSandboxed())return null;
  const key=JSON.stringify([launcher.command,launcher.prefixArgs??[]]),cached=scrubChecks.get(key);
  if(cached&&Date.now()-cached.at<10*60_000)return cached.problem;
  const status=claudeSandboxStatus(launcher,JSON.stringify({sandbox:{enabled:true}}),workspace);
  const problem=status&&(status.supported===false||status.unavailableReason)?String(status.unavailableReason??'not supported here').slice(0,300):null;
  scrubChecks.set(key,{at:Date.now(),problem});
  return problem;
}

/**
 * Guard plan stage 2: what confines this run, checked at its start and written to the action log. Codex: its
 * permissions profile, probed (codex-confinement.mjs). Claude with sandboxed commands: Claude Code's own status for
 * the run's settings; a sandbox it reports as unavailable refuses the run (Claude would refuse it anyway).
 */
async function attest(stateDir,cli,attestation,onAttestation,decisionLog){
  const entry={cli,...attestation,...(decisionLog?{decisionLog:actionLogKeyHex()?'signed':'unsigned (no action log key)'}:{})};
  await appendAction(stateDir,{type:'attestation',...entry}).catch(()=>{});
  await onAttestation?.(entry);
}

export async function installProtection({cli,workspace,stateDir,invocation,task,toolGuard=false,allowGitCommit=false,fast=false,launcher=null,decisionLog=null,codexMode=null,codexExtraArgs=[],writableDirs=[],onAttestation=null}) {
  if(cli==='codex')assertNoRepoCliConfig('codex',workspace);
  // Every Claude run (implementation, roles, QA): no sandboxed run on a CLI or platform that can't confine it.
  if(cli==='claude'&&agentsSandboxed()){
    const problem=claudeSandboxProblem({version:claudeVersion(launcher)});
    if(problem)throw new Error(`Agent Dock is set to sandbox agents' commands (Settings › Experimental): ${problem}`);
  }
  const policyFile=path.join(invocation,'scope-policy.json'),logFile=path.join(invocation,'scope-hook.ndjson');
  const policy={workspace,protectedPaths:protectedPathsFor({workspace,stateDir}),allowedPaths:task?.allowedPaths??[],qaCommand:task?.qaCommand??'',toolGuard,allowGitCommit,protectionOnly:cli==='claude'||!task,taskId:task?.id??null,ask:actionAsk(),webAccess:webAccess()&&!allowGitCommit,...(decisionLog?{decisionLog}:{}),
    // Opt-in (developers, probes): the run's tool calls kept redacted next to its hook log, for the stage 5 corpus.
    ...(process.env.AGENT_DOCK_GUARD_CORPUS==='1'?{corpus:path.join(invocation,'guard-corpus.ndjson')}:{})};
  await writeFile(policyFile,JSON.stringify(policy),{mode:0o600});
  // Settings › Experimental: agents' own commands sandboxed (Codex already confines them on Linux and macOS).
  const sandbox=agentsSandboxed();
  if(cli==='codex'){
    const windows=sandbox&&process.platform==='win32'?[...CODEX_WINDOWS_SANDBOX]:[];
    // The commands Codex runs don't get Codex's own keys (its default shell policy passes everything on): its
    // usual *KEY*/*SECRET*/*TOKEN* exclusions apply, plus the sign-in variables by name (a custom provider's too).
    const keys=codexAuthEnv({env:launcher?.env??process.env});
    // write_stdin (input to a running command) never reaches the hook, and Codex 0.160 keeps it even with unified
    // exec off: no terminals (codexTtyCheck), and the guard refuses commands that would read code from input
    // (stdin-commands.mjs).
    const tty=codexTtyCheck(launcher);
    if(!tty.ok)throw new Error(CODEX_TTY_REFUSED);
    const args=[...codexScopeHookArgs({policyFile,logFile,timeout:hookTimeoutSeconds(policy.ask)}),...CODEX_NO_TTY,...windows,...codexWebSearchArgs(policy.webAccess),
      '-c','shell_environment_policy.ignore_default_excludes=false','-c',`shell_environment_policy.exclude=${JSON.stringify(keys)}`];
    // codexMode ("write" or "read"): this call's sandbox too, in place of the caller's plain --sandbox.
    if(!codexMode)return args;
    const confinement=await codexConfinement({mode:codexMode,stateDir,launcher,extraArgs:[...codexExtraArgs,...windows],writable:writableDirs,required:sandbox});
    await attest(stateDir,cli,{hook:'requested',...confinement.attestation,terminals:tty.confirmed?'off':'off (requested; this Codex did not list it)',...(windows.length?{windowsSandbox:'elevated'}:{})},onAttestation,decisionLog);
    return [...args,...confinement.args];
  }
  const settings=claudeProtectionSettings({policyFile,logFile,fast,timeout:hookTimeoutSeconds(policy.ask),
    sandbox:sandbox&&claudeSandbox({workspace,protectedPaths:policy.protectedPaths,homeSecrets:HOME_SECRETS,home:os.homedir(),allowGitCommit})});
  // Without the scrub the only credentials Claude's commands could see are its own sign-in variables (claudeChildEnv
  // removes every other one): a run that has them is refused rather than handing them out (release review 0.40.2).
  const scrubProblem=claudeScrubProblem(launcher,workspace);
  if(scrubProblem&&CLAUDE_AUTH_ENV.some(name=>launcher?.env?.[name]))throw new Error(`Claude Code's sandbox can't start here (${scrubProblem}), and without it the commands Claude runs would see your Anthropic key. Install bubblewrap and socat, or sign Claude Code in with /login instead of an API key.`);
  if(onAttestation||sandbox){
    const status=sandbox?claudeSandboxStatus(launcher,JSON.stringify(settings),workspace):null;
    // `available`/`installed` describe the native Windows install only; supported, enabled and no unavailableReason
    // are what say the sandbox will confine these commands.
    if(status&&(status.supported===false||status.enabled!==true||status.unavailableReason))throw new Error(`Agent Dock is set to sandbox agents' commands (Settings › Experimental), but Claude Code reports its sandbox as unavailable: ${String(status.unavailableReason??status.reasons?.[0]??'no reason given').slice(0,300)}`);
    await attest(stateDir,cli,{hook:'requested',sandbox:sandbox?'claude-sandbox':'none',readLimits:Boolean(sandbox),probe:sandbox?(status?'Claude Code reports it enabled (its limits are not tested)':'not reported by this Claude Code'):'not run',
      envScrub:scrubProblem?`off: Claude Code's sandbox can't start here (${scrubProblem})`:'on'},onAttestation,decisionLog);
  }
  return ['--settings',JSON.stringify(settings)];
}
