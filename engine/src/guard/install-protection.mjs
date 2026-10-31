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
import {appendAction} from '../action-log.mjs';

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
 * Guard plan stage 2: what confines this run, checked at its start and written to the action log. Codex: its
 * permissions profile, probed (codex-confinement.mjs). Claude with sandboxed commands: Claude Code's own status for
 * the run's settings; a sandbox it reports as unavailable refuses the run (Claude would refuse it anyway).
 */
async function attest(stateDir,cli,attestation,onAttestation){
  const entry={cli,...attestation};
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
    const args=[...codexScopeHookArgs({policyFile,logFile,timeout:hookTimeoutSeconds(policy.ask)}),...windows,...codexWebSearchArgs(policy.webAccess),
      '-c','shell_environment_policy.ignore_default_excludes=false','-c',`shell_environment_policy.exclude=${JSON.stringify(keys)}`];
    // codexMode ("write" or "read"): this call's sandbox too, in place of the caller's plain --sandbox.
    if(!codexMode)return args;
    const confinement=await codexConfinement({mode:codexMode,stateDir,launcher,extraArgs:[...codexExtraArgs,...windows],writable:writableDirs,required:sandbox});
    await attest(stateDir,cli,{hook:'requested',...confinement.attestation,...(windows.length?{windowsSandbox:'elevated'}:{})},onAttestation);
    return [...args,...confinement.args];
  }
  const settings=claudeProtectionSettings({policyFile,logFile,fast,timeout:hookTimeoutSeconds(policy.ask),
    sandbox:sandbox&&claudeSandbox({workspace,protectedPaths:policy.protectedPaths,homeSecrets:HOME_SECRETS,home:os.homedir(),allowGitCommit})});
  if(onAttestation||sandbox){
    const status=sandbox?claudeSandboxStatus(launcher,JSON.stringify(settings),workspace):null;
    // `available`/`installed` describe the native Windows install only; supported, enabled and no unavailableReason
    // are what say the sandbox will confine these commands.
    if(status&&(status.supported===false||status.enabled!==true||status.unavailableReason))throw new Error(`Agent Dock is set to sandbox agents' commands (Settings › Experimental), but Claude Code reports its sandbox as unavailable: ${String(status.unavailableReason??status.reasons?.[0]??'no reason given').slice(0,300)}`);
    await attest(stateDir,cli,{hook:'requested',sandbox:sandbox?'claude-sandbox':'none',readLimits:Boolean(sandbox),probe:sandbox?(status?'Claude Code reports it enabled (its limits are not tested)':'not reported by this Claude Code'):'not run'},onAttestation);
  }
  return ['--settings',JSON.stringify(settings)];
}
