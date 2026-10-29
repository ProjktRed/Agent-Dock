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
export async function installProtection({cli,workspace,stateDir,invocation,task,toolGuard=false,allowGitCommit=false,fast=false,launcher=null,decisionLog=null}) {
  if(cli==='codex')assertNoRepoCliConfig('codex',workspace);
  // Every Claude run (implementation, roles, QA): no sandboxed run on a CLI or platform that can't confine it.
  if(cli==='claude'&&agentsSandboxed()){
    const problem=claudeSandboxProblem({version:claudeVersion(launcher)});
    if(problem)throw new Error(`Agent Dock is set to sandbox agents' commands (Settings › Experimental): ${problem}`);
  }
  const policyFile=path.join(invocation,'scope-policy.json'),logFile=path.join(invocation,'scope-hook.ndjson');
  const policy={workspace,protectedPaths:protectedPathsFor({workspace,stateDir}),allowedPaths:task?.allowedPaths??[],qaCommand:task?.qaCommand??'',toolGuard,allowGitCommit,protectionOnly:cli==='claude'||!task,taskId:task?.id??null,ask:actionAsk(),webAccess:webAccess()&&!allowGitCommit,...(decisionLog?{decisionLog}:{})};
  await writeFile(policyFile,JSON.stringify(policy),{mode:0o600});
  // Settings › Experimental: agents' own commands sandboxed (Codex already confines them on Linux and macOS).
  const sandbox=agentsSandboxed();
  return cli==='codex'
    ?[...codexScopeHookArgs({policyFile,logFile,timeout:hookTimeoutSeconds(policy.ask)}),...(sandbox&&process.platform==='win32'?CODEX_WINDOWS_SANDBOX:[]),...codexWebSearchArgs(policy.webAccess)]
    :['--settings',JSON.stringify(claudeProtectionSettings({policyFile,logFile,fast,timeout:hookTimeoutSeconds(policy.ask),
      sandbox:sandbox&&claudeSandbox({workspace,protectedPaths:policy.protectedPaths,homeSecrets:HOME_SECRETS,home:os.homedir(),allowGitCommit})}))];
}
