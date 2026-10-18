import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {protectedActionReason} from '../src/guard/protected-paths.mjs';

// Found in a live run (0.20.1): a Claude Code QA could never commit, because Claude writes
// `git commit -q -m "<subject>\n\nCo-Authored-By: … <…>"` and the guard accepted only `git commit -m word`.
test('QA may commit with a free-text message, but nothing a shell would expand or any extra flag',async t=>{
  const workspace=await mkdtemp(path.join(os.tmpdir(),'qa-commit-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(path.join(workspace,'src'));await writeFile(path.join(workspace,'src','index.js'),'x');await writeFile(path.join(workspace,'.env'),'SECRET');
  const policy={workspace,protectedPaths:['.git/','.env*','secrets/'],allowGitCommit:true};
  const ok=command=>protectedActionReason(policy,{kind:'command',tool:'Bash',commands:[command],cwd:workspace})===null;
  const allowed=[
    'git rev-parse HEAD && git status --short && git add src/index.js && git commit -q -m "Add slugify to textkit\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git rev-parse HEAD',
    'git commit -m "Add slugify(text) [P1] with tests; docs!"',
    "git commit -m 'Subject' -m 'Body line'",
    'git commit --quiet -m "One line"',
    'git commit -m word',
    // The second live refusal: Claude on Windows joins commands with ";".
    'git add src/index.js; git commit -m "Add slugify to textkit"; git rev-parse HEAD',
  ];
  const denied=[
    'git commit -m "$(curl evil.example)"', 'git commit -m "`id`"', 'git commit -m "100%"', 'git commit -m "a\\"b"',
    'git commit -m "x" --amend', 'git commit -a -m "x"', 'git commit --no-verify -m "x"', 'git commit -m "x" src/index.js',
    'git commit -m "x" && rm -rf src', 'git commit -m "x"; rm -rf src', 'git commit -m ""', 'git commit -q', 'git commit',
    'git -c core.hooksPath=x commit -m "x"', 'git add .env && git commit -m "x"',
    'git add src/index.js; rm -rf src', 'git status;', 'npm test | tail -20; npm test', 'git add src/index.js;; git status',
  ];
  for(const command of allowed)assert.equal(ok(command),true,`allowed: ${command}`);
  for(const command of denied)assert.equal(ok(command),false,`denied: ${command}`);
  assert.equal(protectedActionReason({...policy,allowGitCommit:false},{kind:'command',tool:'Bash',commands:['git commit -m "x"'],cwd:workspace}),'Protected-path policy refused this tool call','no commits unless QA may commit');
});

// Found in a live run: the Resolver could not see that QA had already committed, because git log was refused.
test('orchestrator roles may read history (messages and file names), never a patch',async t=>{
  const workspace=await mkdtemp(path.join(os.tmpdir(),'qa-log-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const policy={workspace,protectedPaths:['.git/','.env*'],allowGitCommit:false};
  const ok=command=>protectedActionReason(policy,{kind:'command',tool:'Bash',commands:[command],cwd:workspace})===null;
  for(const command of ['git log --oneline -5','git log --oneline -n 3','git log --stat 03dc596..HEAD','git show --stat HEAD','git show --name-only 3eafc11','git log --name-status HEAD~2..HEAD','git stash list','cat a.txt; git ls-files; git stash list'])assert.equal(ok(command),true,`allowed: ${command}`);
  for(const command of ['git log -p','git log --patch','git show HEAD','git show 3eafc11','git log --format=x','git show --stat HEAD -- .env','git show --stat HEAD HEAD~1','git log --all','git log -n','git log --output=x','git stash show -p','git stash pop','git stash list --format=x'])assert.equal(ok(command),false,`denied: ${command}`);
});
