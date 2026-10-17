import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkToolUse, patchPaths, shellAllowed, shellScript } from '../src/guard/adapters/codex.mjs';

const workspace = path.resolve('/repo');
const policy = { workspace, allowedPaths: ['src/x.js', 'test/x.test.js'], qaCommand: 'npx vitest run test/x.test.js', toolGuard: true };
const patch = (...files) => ['*** Begin Patch', ...files.map((f) => `*** Update File: ${f}\n@@\n-a\n+b`), '*** End Patch'].join('\n');

test('patches may only touch the task paths, in any input shape', () => {
  assert.equal(checkToolUse(policy, { tool_name: 'apply_patch', tool_input: { command: patch('src/x.js') }, cwd: workspace }), null);
  assert.equal(checkToolUse(policy, { tool_name: 'apply_patch', tool_input: ['apply_patch', patch('test/x.test.js')], cwd: workspace }), null);
  assert.match(checkToolUse(policy, { tool_name: 'apply_patch', tool_input: { input: patch('src/x.js', 'package.json') }, cwd: workspace }), /Outside the task's approved paths: package.json/);
  assert.match(checkToolUse(policy, { tool_name: 'apply_patch', tool_input: { command: patch('../other/x.js') }, cwd: workspace }), /Outside/);
  assert.match(checkToolUse(policy, { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: src/y.js\n+x\n*** End Patch' }, cwd: workspace }), /src\/y\.js/);
  assert.match(checkToolUse(policy, { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/x.js\n*** Move to: src/z.js\n*** End Patch' }, cwd: workspace }), /src\/z\.js/);
  assert.match(checkToolUse(policy, { tool_name: 'apply_patch', tool_input: { command: 'not a patch' }, cwd: workspace }), /must be a patch/);
  assert.deepEqual(patchPaths({ command: patch('a', 'b') }), ['a', 'b']);
});

test('with the tool guard on, the shell runs only checks and read-only commands', () => {
  const run = (command) => checkToolUse(policy, { tool_name: 'Bash', tool_input: { command }, cwd: workspace });
  assert.equal(run('npx vitest run test/x.test.js'), null);
  assert.match(run(['powershell.exe', '-Command', 'Get-Content src/x.js | Select-String foo']), /Tool guard/);
  assert.equal(run(['bash', '-lc', 'git status && git diff -- src/x.js']), null);
  assert.equal(run('rg "export" src'), null);
  assert.match(run('echo hi > src/other.js'), /Tool guard/);
  assert.match(run('node -e "require(\'fs\').writeFileSync(\'a\',\'b\')"'), /Tool guard/);
  assert.match(run('git commit -am x'), /Tool guard/);
  assert.match(run('Set-Content package.json x'), /Tool guard/);
  assert.match(run('find . -name x -delete'), /Tool guard/);
  assert.match(run('cat $(ls)'), /Tool guard/);
  assert.equal(checkToolUse({ ...policy, toolGuard: false }, { tool_name: 'Bash', tool_input: { command: 'npm install' } }), null);
  assert.ok(checkToolUse(policy, { tool_name: 'mcp__fs__write', tool_input: { path: 'x' } }));
  assert.match(checkToolUse(policy, { tool_name: 'mcp__browser__navigate', tool_input: { url: 'x' } }), /MCP/);
  assert.equal(shellScript({ command: ['cmd.exe', '/c', 'dir'] }), 'dir');
  assert.equal(shellAllowed('npm test 2>&1', ''), false);
  assert.equal(shellAllowed('npm test 2>&1 | tail -20', ''), true);
});

test('patch scope applies even with the tool guard off', () => {
  assert.match(checkToolUse({ ...policy, toolGuard: false }, { tool_name: 'apply_patch', tool_input: { command: patch('README.md') }, cwd: workspace }), /Outside/);
});

test('the hook script blocks with exit 2 and logs every decision', async (t) => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scope-hook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policyFile = path.join(dir, 'policy.json'), logFile = path.join(dir, 'log.ndjson');
  await writeFile(policyFile, JSON.stringify({ ...policy, workspace: dir }));
  const hook = path.resolve('src/codex-scope-hook.mjs');
  const call = (event) => spawnSync(process.execPath, [hook, policyFile, logFile], { input: JSON.stringify(event), encoding: 'utf8' });
  const ok = call({ tool_name: 'apply_patch', tool_input: { command: patch('src/x.js') }, cwd: dir });
  assert.equal(ok.status, 0);
  const bad = call({ tool_name: 'apply_patch', tool_input: { command: patch('package.json') }, cwd: dir });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Outside the task's approved paths: package.json/);
  const broken = spawnSync(process.execPath, [hook, policyFile, logFile], { input: 'not json', encoding: 'utf8' });
  assert.equal(broken.status, 2, 'unreadable input is blocked');
  const log = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map((d) => d.allowed), [true, false, false]);
});
