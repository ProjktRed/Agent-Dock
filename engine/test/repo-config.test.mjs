import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {repoCliConfigProblems,assertNoRepoCliConfig} from '../src/guard/repo-config.mjs';
import {installProtection} from '../src/guard/install-protection.mjs';
import {launchCline} from '../src/cline-cli-worker.mjs';

// Live smoke run (0.39.0): Codex ran a trusted repository's own .codex hooks unreviewed, because Agent
// Dock starts it with --dangerously-bypass-hook-trust. Cline runs .clinerules/hooks with no review.
async function repo(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'repo-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'work');await mkdir(path.join(dir,'.git'),{recursive:true});
  return {root,dir};
}

test('a repository with its own Codex hooks is found, in either file and in a parent up to the git root',async t=>{
  const {root,dir}=await repo(t);
  assert.deepEqual(repoCliConfigProblems('codex',dir),[]);
  await mkdir(path.join(dir,'.codex'));
  await writeFile(path.join(dir,'.codex','config.toml'),'# hooks are mentioned only in this comment\nmodel = "gpt-x"\n');
  assert.deepEqual(repoCliConfigProblems('codex',dir),[],'a config without hooks is fine');
  await writeFile(path.join(dir,'.codex','config.toml'),'[[hooks.SessionStart]]\nmatcher = ".*"\n');
  assert.deepEqual(repoCliConfigProblems('codex',dir),['.codex/config.toml']);
  await writeFile(path.join(dir,'.codex','config.toml'),'hooks = { Stop = [] }\n');
  assert.deepEqual(repoCliConfigProblems('codex',dir),['.codex/config.toml']);
  await writeFile(path.join(dir,'.codex','hooks.json'),'{}');
  assert.deepEqual(repoCliConfigProblems('codex',dir).sort(),['.codex/config.toml','.codex/hooks.json']);
  // A workspace inside the repository: the repository root's hooks count; anything above the git root does not.
  const sub=path.join(dir,'packages','app');await mkdir(sub,{recursive:true});
  assert.deepEqual(repoCliConfigProblems('codex',sub).sort(),['../../.codex/config.toml','../../.codex/hooks.json']);
  await mkdir(path.join(root,'.codex'));await writeFile(path.join(root,'.codex','hooks.json'),'{}');
  assert.equal(repoCliConfigProblems('codex',dir).length,2,'above the git root is not part of the project');
});

test('a Codex call never starts over repository hooks; Claude Code is not affected',async t=>{
  const {root,dir}=await repo(t);
  await mkdir(path.join(dir,'.codex'));await writeFile(path.join(dir,'.codex','hooks.json'),'{}');
  const invocation=path.join(root,'inv');await mkdir(invocation);
  await assert.rejects(installProtection({cli:'codex',workspace:dir,stateDir:path.join(root,'state'),invocation}),/own Codex hooks \(\.codex\/hooks\.json\).*not started/);
  const claude=await installProtection({cli:'claude',workspace:dir,stateDir:path.join(root,'state'),invocation});
  assert.equal(claude[0],'--settings');
});

test('Cline never starts over repository hooks in .clinerules/hooks',async t=>{
  const {root,dir}=await repo(t);
  assert.deepEqual(repoCliConfigProblems('cline',dir),[]);
  await mkdir(path.join(dir,'.clinerules','hooks'),{recursive:true});
  assert.deepEqual(repoCliConfigProblems('cline',dir),[],'an empty hooks folder runs nothing');
  await writeFile(path.join(dir,'.clinerules','hooks','PreToolUse.ps1'),'exit 0');
  assert.throws(()=>assertNoRepoCliConfig('cline',dir),/own Cline hooks \(\.clinerules\/hooks\)/);
  const clineJs=path.join(root,'cline.js');await writeFile(clineJs,'');
  await assert.rejects(launchCline({clineJs,workspace:dir,prompt:'x'}),/own Cline hooks/);
});
