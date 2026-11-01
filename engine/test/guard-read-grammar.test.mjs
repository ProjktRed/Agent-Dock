import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {protectedActionReason,assertSafeQaCommand} from '../src/guard/protected-paths.mjs';
import codex from '../src/guard/adapters/codex.mjs';

async function workspace(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'guard-grammar-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'work');await mkdir(path.join(dir,'src'),{recursive:true});await mkdir(path.join(dir,'secrets'));
  execFileSync('git',['init','-q'],{cwd:dir});
  await writeFile(path.join(dir,'README.md'),'readme');await writeFile(path.join(dir,'src','Example.ts'),'export {}');
  await writeFile(path.join(dir,'.env'),'SECRET');await writeFile(path.join(dir,'secrets','config.json'),'SECRET');
  await writeFile(path.join(dir,'package.json'),'{}');
  return {root,dir,policy:{workspace:dir,protectedPaths:['.git/','.env*','secrets/'],qaCommand:'npm test'}};
}
const ok=(policy,command)=>protectedActionReason(policy,{kind:'command',tool:'Bash',commands:[command],cwd:policy.workspace})===null;

// Found in a live run (0.38.1): Codex on Windows reads with PowerShell options, and every read was refused.
test('read commands may take their read-only options',async t=>{
  const {policy}=await workspace(t);
  for(const command of ['Get-Content -Raw README.md','Get-Content -Path README.md','Get-Content README.md -TotalCount 200','Get-Content -LiteralPath README.md -Raw',
    'Get-Content -Raw -Encoding utf8 README.md','gc README.md -Tail 20','cat -n README.md','head -n 40 README.md','tail -n 5 src/Example.ts','wc -l README.md',
    'ls','ls -la','dir','Get-ChildItem','Get-ChildItem -Force','Get-ChildItem -Name src','Get-ChildItem -Path src -File','Test-Path README.md','Test-Path .',
    'Select-String -Path README.md -Pattern readme','Select-String -Pattern x -Path src/Example.ts -SimpleMatch','rg -n export src','grep -rn export src','findstr /i /n export src/Example.ts',
    'Get-ChildItem -Recurse src','rg --files src'])assert.equal(ok(policy,command),true,command);
});

test('read options cannot reach protected files, write, wait, run programs or search recursively past them',async t=>{
  const {policy}=await workspace(t);
  for(const command of ['Get-Content -Raw .env','Get-Content -Path .env','Get-Content -LiteralPath secrets/config.json','Get-Content README.md -Stream x','Get-Content README.md -Wait',
    'Get-Content -TotalCount x README.md','Get-Content -Encoding','cat -A README.md','tail -f README.md','ls .git','ls secrets','Get-ChildItem -Path .git','Get-ChildItem -Recurse',
    'Get-ChildItem -Path secrets -Recurse','ls -R','rg --files','rg --pre sh x src','rg -f .env src','grep -f .env src','rg x .','grep -r x .','findstr /s SECRET config.json',
    'findstr /d:secrets SECRET config.json','findstr /g:.env src/Example.ts','Select-String -Pattern x -Path .env','Select-String -Pattern x','Test-Path .env','Get-Content -Path:.env',
    'Get-ChildItem -Include x','cat - ','Get-Content -Raw README.md -Delimiter x',
    // Defensive review (0.39.0): with -Path named, the first positional word is the pattern, not a file.
    'Select-String -Path .env README.md','Select-String -LiteralPath secrets/config.json x','Get-Content \u2013Path .env','Get-Content \u2014Stream x README.md',
    'Get-Content README.md,.env','Get-Content -Path README.md,.env','git show HEAD:README.md,.env','npx eslint src,.env','type README.md,secrets/config.json','Get-Content env:PATH','Get-Content variable:x','Get-ChildItem HKCU:Software','Test-Path env:X',
    // Second defensive review (0.39.0): PowerShell reads curly quotes as quotes; the guard did not.
    'Get-Content “.env”','Get-Content ‘.env’','Get-Content -Raw „secrets/config.json”','cat ‛.env’',
    // Third review (0.39.0): no character outside plain ASCII at all (other spaces, look-alike letters, invisible marks).
    'Get-Content .env','Get-Content README.md','Get-Content README.md​','Get-Content еnv.txt','cat README.md\t.env','Get-Content РЕАДМЕ.md'])assert.equal(ok(policy,command),false,command);
});

test('a commit message may still contain any language; the rest of the command must be ASCII',async t=>{
  const {policy}=await workspace(t);
  const commit={...policy,allowGitCommit:true};
  assert.equal(ok(commit,'git commit -m "Добавить slugify — с тестами"'),true);
  assert.equal(ok(commit,"git commit -m 'Ajouter les tests é'"),true);
  assert.equal(ok(commit,'git commit -m "x" README.md '),false);
});

// S-03: a check's --option=value can name a protected file, and check output options write files.
test('check arguments are path-checked in --option=value form, and checks may not write reports or fixes',async t=>{
  const {dir,root}=await workspace(t);
  const qa=command=>{try{assertSafeQaCommand({workspace:dir,stateDir:path.join(root,'state'),command});return true;}catch{return false;}};
  for(const command of ['npx eslint --output-file=.env.local package.json','npx eslint --output-file .env.local package.json','npx vitest run --reporter=json --outputFile=.env.local',
    'npx vitest run --outputFile.json=report.json','npx eslint --fix .','npx prettier --write .','npx prettier --write secrets/config.json','npx tsc --outDir dist','npx vitest run -u .','npx eslint -o out.txt src',
    'npx eslint --config=secrets/x.js src','npx vitest run --root=secrets','npx tsc -p secrets','npm test -- --outputFile=.env','npm test -- secrets/x.test.js'])assert.equal(qa(command),false,command);
  for(const command of ['npm test','npm run test','npm run format:check','npx vitest run --reporter=json','npx tsc --noEmit','npx eslint src','npm test -- src/Example.ts','npx prettier --write src/Example.ts','npx eslint --fix src'])assert.equal(qa(command),true,command);
  // Smoke run (0.39.0): Assessment chose npx --no-install, the form that never downloads; it was refused.
  for(const command of ['npx --no-install prettier --check README.md','npx --no-install tsc --noEmit'])assert.equal(qa(command),true,command);
  for(const command of ['npx --no-install --yes prettier --check README.md','npx --no-install curl x','npx --no-install prettier --check .env'])assert.equal(qa(command),false,command);
});

// S-06: Linux file names differ by case, and a link inside the workspace can point outside it.
test('Codex patch scope compares real paths, by case where the file system does',async t=>{
  const {dir,root}=await workspace(t);
  const policy={workspace:dir,allowedPaths:['src/Example.ts','src/link/a.ts']};
  assert.equal(codex.approvedPath(policy,'src/Example.ts'),true);
  assert.equal(codex.approvedPath(policy,path.join(dir,'src','Example.ts')),true);
  assert.equal(codex.approvedPath(policy,'src/example.ts'),process.platform==='win32'||process.platform==='darwin');
  assert.equal(codex.approvedPath(policy,'src/link/a.ts'),true);
  await mkdir(path.join(root,'outside'));await symlink(path.join(root,'outside'),path.join(dir,'src','link'),'junction');
  assert.equal(codex.approvedPath(policy,'src/link/a.ts'),false);
});

// Smoke run (0.39.0): with "ask instead of refuse" on, these plainly read-only commands asked eight times in one task.
test('a read may list several files, changed-file summaries chain, and tool versions are readable',async t=>{
  const {policy}=await workspace(t);
  const win=process.platform==='win32';
  for(const command of ['Get-Content -LiteralPath package.json,README.md,src/Example.ts','Get-Content -LiteralPath package.json, README.md','gc "package.json", "README.md" -TotalCount 5'])assert.equal(ok(policy,command),win,command);
  for(const command of ['git rev-parse HEAD; git status --short; git diff --name-only; git diff --cached --name-only','git rev-parse HEAD; git status --short; git diff --stat; git diff --cached --stat',
    'git diff HEAD --name-status','git diff --staged --numstat','where.exe cargo','Get-Command cargo','rustc --version','cargo --version','node --version'])assert.equal(ok(policy,command),true,command);
  // Each listed file is checked; a comma anywhere else, inside quotes or next to an option is still refused.
  for(const command of ['Get-Content package.json,.env','Get-Content README.md, secrets/config.json','Get-Content "README.md,.env"','Get-Content README.md,-Stream','Get-Content -Raw,README.md',
    'Get-Content README.md,','Get-Content README.md,src && npx eslint src,README.md','Get-ChildItem src,secrets','npx eslint src,README.md','git diff --cached -- .env','git diff --cached HEAD~1',
    'git diff --stat --output=x','where.exe -R secrets x','where.exe a,b','Get-Command -Module x','rustc --version x','python -c x','cargo build --version','./node --version'])assert.equal(ok(policy,command),false,command);
});
