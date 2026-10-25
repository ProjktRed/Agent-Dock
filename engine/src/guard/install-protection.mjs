import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {protectedPathsFor} from './protected-paths.mjs';
import {codexScopeHookArgs} from './adapters/codex.mjs';
import {claudeProtectionSettings} from './adapters/claude.mjs';
import {assertNoRepoCliConfig} from './repo-config.mjs';

/**
 * Policies and hooks live in trusted state, outside the agent's writable task scope. Codex gets its hook
 * only here, with hook review turned off, so a repository's own Codex hooks stop the call first.
 */
export async function installProtection({cli,workspace,stateDir,invocation,task,toolGuard=false,allowGitCommit=false,fast=false}) {
  if(cli==='codex')assertNoRepoCliConfig('codex',workspace);
  const policyFile=path.join(invocation,'scope-policy.json'),logFile=path.join(invocation,'scope-hook.ndjson');
  const policy={workspace,protectedPaths:protectedPathsFor({workspace,stateDir}),allowedPaths:task?.allowedPaths??[],qaCommand:task?.qaCommand??'',toolGuard,allowGitCommit,protectionOnly:cli==='claude'||!task};
  await writeFile(policyFile,JSON.stringify(policy),{mode:0o600});
  return cli==='codex'?codexScopeHookArgs({policyFile,logFile}):['--settings',JSON.stringify(claudeProtectionSettings({policyFile,logFile,fast}))];
}
