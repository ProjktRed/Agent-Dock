import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliLauncher, cmdLine, launchSpec, resolveProgram } from '../src/cmd-line.mjs';

const ARGS = ['plain', 'two words', 'a&b', 'p|q', '<in>', '100%', '%PATH%', '^c', '!x!', '(p)', 'model_reasoning_effort="high"', 'tail\\', 'q\\"x', '', '& echo MARKER', 'C:\\dir with space\\'];

// An npm-style shim: the batch file passes its arguments on with %*, as codex.cmd does.
function shim(root) {
  const dir = path.join(root, 'npm dir');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'print.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  writeFileSync(path.join(dir, 'tool.cmd'), '@ECHO off\r\nSETLOCAL\r\n"%~dp0\\..\\node.exe" "%~dp0\\print.js" %*\r\n'.replace('"%~dp0\\..\\node.exe"', `"${process.execPath}"`));
  return dir;
}

test('cmd.exe passes every argument through unchanged, to a program and to a batch file', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cmd-line-'));
  try {
    const dir = shim(root);
    for (const [program, args] of [[process.execPath, [path.join(dir, 'print.js'), ...ARGS]], [path.join(dir, 'tool.cmd'), ARGS]]) {
      const launch = launchSpec('cmd.exe', ['/d', '/s', '/c', program, ...args]);
      const out = spawnSync(launch.command, launch.args, { ...launch.options, encoding: 'utf8' });
      assert.doesNotMatch(out.stdout + out.stderr, /^MARKER/m);
      assert.deepEqual(JSON.parse(out.stdout), program.endsWith('.cmd') ? ARGS : args.slice(1));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bare program name gets no argument that only one kind of program could receive safely', () => {
  assert.throws(() => cmdLine('codex', ['a&b']), /cannot pass/i);
  assert.throws(() => cmdLine('codex', ['x="y"']), /cannot pass/i);
  assert.throws(() => cmdLine('codex.cmd', ['line\nbreak']), /line break/);
  assert.throws(() => cmdLine('co"dex', []), /quote/);
  assert.equal(cmdLine('codex', ['exec', 'C:\\my project']), '^"codex^" ^"exec^" ^"C:\\my^ project^"');
});

test('other launchers are spawned as they are', () => {
  assert.deepEqual(launchSpec('C:\\bin\\codex.exe', ['exec', 'a&b']), { command: 'C:\\bin\\codex.exe', args: ['exec', 'a&b'], options: {} });
});

test('a bare name resolves through PATH and PATHEXT on Windows, and a batch file runs through cmd.exe', () => {
  const files = new Set(['C:\\npm\\claude.cmd', 'C:\\bin\\tool.exe']);
  const env = { Path: 'C:\\empty;"C:\\npm";C:\\bin', PATHEXT: '.exe;.cmd', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  const options = { platform: 'win32', env, fileExists: (file) => files.has(file) };
  assert.equal(resolveProgram('claude', options), 'C:\\npm\\claude.cmd');
  assert.equal(resolveProgram('tool', options), 'C:\\bin\\tool.exe');
  assert.equal(resolveProgram('missing', options), 'missing');
  assert.equal(resolveProgram('.\\claude', options), '.\\claude', 'a path is never searched');
  assert.deepEqual(cliLauncher('claude', options), { command: 'C:\\Windows\\system32\\cmd.exe', prefixArgs: ['/d', '/s', '/c', 'C:\\npm\\claude.cmd'] });
  assert.deepEqual(cliLauncher('tool', options), { command: 'C:\\bin\\tool.exe', prefixArgs: [] });
  assert.equal(cliLauncher('claude', { ...options, env: { ...env, ComSpec: 'C:\\other.exe' } }).command, 'cmd.exe', 'ComSpec only when it is cmd.exe');
  assert.deepEqual(cliLauncher('claude', { ...options, platform: 'linux' }), { command: 'claude', prefixArgs: [] });
});

test('an npm-style claude.cmd found on PATH starts through cmd.exe with its arguments intact', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cmd-line-'));
  try {
    const dir = shim(root);
    writeFileSync(path.join(dir, 'claude.cmd'), readFileSync(path.join(dir, 'tool.cmd')));
    const launcher = cliLauncher('claude', { env: { PATH: dir, PATHEXT: '.exe;.cmd' } });
    assert.equal(launcher.prefixArgs.at(-1), path.join(dir, 'claude.cmd'));
    const args = ['--setting-sources', 'user', '--json-schema', JSON.stringify({ type: 'object', required: ['a&b'] }), ...ARGS];
    const launch = launchSpec(launcher.command, [...launcher.prefixArgs, ...args]);
    const out = spawnSync(launch.command, launch.args, { ...launch.options, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.stdout), args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
