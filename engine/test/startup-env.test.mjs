import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withoutSecrets } from '../src/secret-env.mjs';

const src = (name) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', name)).href;
const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12';
const NOTIFY = JSON.stringify({ project: 'Demo', webhook: 'https://example.com/hook-abcdef123456', telegram: { token: TOKEN, chatId: '42' } });

/** Runs a module script in a fresh engine process (startup-env.mjs acts once, on import). */
function engineScript(code, { env = {}, cwd } = {}) {
  const base = { ...process.env };
  delete base.NoDefaultCurrentDirectoryInExePath;
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd, env: { ...base, ...env }, encoding: 'utf8' });
}

test('notification settings stay in the engine: read once, gone from the environment children inherit', () => {
  const out = JSON.parse(engineScript(`
    import { engineOnlyEnv } from ${JSON.stringify(src('startup-env.mjs'))};
    import { redactText } from ${JSON.stringify(src('redact.mjs'))};
    import { notifyFromEnv } from ${JSON.stringify(src('notify.mjs'))};
    import { execFileSync } from 'node:child_process';
    notifyFromEnv(engineOnlyEnv());
    const child = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.AGENT_DOCK_NOTIFY ?? ""))'], { encoding: 'utf8' });
    console.log(JSON.stringify({ own: process.env.AGENT_DOCK_NOTIFY ?? null, child, held: engineOnlyEnv().AGENT_DOCK_NOTIFY ?? null, redacted: redactText('token ${TOKEN}') }));
  `, { env: { AGENT_DOCK_NOTIFY: NOTIFY } }));
  assert.equal(out.own, null);
  assert.equal(out.child, '');
  assert.equal(out.held, NOTIFY);
  assert.equal(out.redacted.includes(TOKEN), false);
});

test('check commands and worker shells never get Agent Dock notification or reviewer secrets', () => {
  const env = withoutSecrets({ PATH: 'p', AGENT_DOCK_NOTIFY: NOTIFY, agent_dock_supervisor_key: 'k', AGENT_DOCK_PROTECTED_PATHS: '[]' });
  assert.deepEqual(Object.keys(env).sort(), ['AGENT_DOCK_PROTECTED_PATHS', 'PATH']);
});

test('Windows: programs are resolved from PATH only, not from the current folder', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tool-lookup-'));
  try {
    // A program in the project folder with the name of a tool; it does not answer --version as git does.
    copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), path.join(dir, 'git.exe'));
    const out = engineScript(`
      import ${JSON.stringify(src('startup-env.mjs'))};
      import { execFileSync } from 'node:child_process';
      process.stdout.write(execFileSync('cmd.exe', ['/d', '/s', '/c', 'git --version'], { encoding: 'utf8' }));
    `, { cwd: dir });
    assert.match(out, /git version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
