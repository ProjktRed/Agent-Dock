import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdLine, launchSpec } from '../src/cmd-line.mjs';

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
