import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexAuthEnv, codexProviderKeyEnv, tomlStrings } from '../src/codex-provider-env.mjs';
import { CODEX_AUTH_ENV, withoutSecrets } from '../src/secret-env.mjs';
import { redactText } from '../src/redact.mjs';
import { CloudImplementationWorker } from '../src/cloud-impl-worker.mjs';
import { CodexWorker } from '../src/codex-worker.mjs';
import { preflightCodex } from '../src/codex-command.mjs';

const keyEnv = (toml, env = {}) => codexProviderKeyEnv({ env: { CODEX_HOME: 'h', ...env }, read: () => toml });

test('a custom Codex provider keeps the variable its config names, for the active provider only', () => {
  const toml = `model = "gpt-5"
model_provider = "azure" # the active one

[model_providers.azure]
name = "Azure"
env_key = "AZURE_OPENAI_API_KEY"

[model_providers.azure.http_headers]
env_key = "NOT_THIS"

[model_providers.mistral]
env_key = "MISTRAL_API_KEY"
`;
  assert.equal(keyEnv(toml), 'AZURE_OPENAI_API_KEY');
  const env = { PATH: 'p', AZURE_OPENAI_API_KEY: 'az-secret-value', MISTRAL_API_KEY: 'mi-secret-value', GITHUB_TOKEN: 'gh-secret-value' };
  const keep = codexAuthEnv({ env, read: () => toml });
  assert.deepEqual(keep, [...CODEX_AUTH_ENV, 'AZURE_OPENAI_API_KEY']);
  assert.deepEqual(Object.keys(withoutSecrets(env, { keep })).sort(), ['AZURE_OPENAI_API_KEY', 'PATH']);
});

test('profiles, dotted keys and quoted names select the provider like Codex does', () => {
  assert.equal(keyEnv(`profile = "work"\nmodel_provider = "a"\n[profiles.work]\nmodel_provider = "b"\n[model_providers.a]\nenv_key = "A_KEY"\n[model_providers.b]\nenv_key = "B_KEY"\n`), 'B_KEY');
  assert.equal(keyEnv(`profile = "none"\nmodel_provider = "a"\n[model_providers.a]\nenv_key = "A_KEY"\n`), 'A_KEY');
  assert.equal(keyEnv(`model_provider = "my-azure"\nmodel_providers.my-azure.env_key = 'AZ_KEY'\n`), 'AZ_KEY');
  assert.equal(keyEnv(`model_provider = "x y"\n[model_providers."x y"]\nenv_key = "XY_KEY"\n`), 'XY_KEY');
  assert.equal(keyEnv(`model_provider = "a"\n[model_providers]\na.env_key = "A_KEY"\n`), 'A_KEY');
});

test('anything the reader does not understand, or a name it must not keep, keeps only Codex sign-in', () => {
  const read = (body) => `model_provider = "a"\n${body}`;
  assert.equal(keyEnv(read(`[model_providers]\na = { env_key = "INLINE_KEY" }\n`)), null, 'inline tables are not read');
  assert.equal(keyEnv(read(`[model_providers.a]\nenv_key = "BAD NAME"\n`)), null);
  assert.equal(keyEnv(read(`[model_providers.a]\nenv_key = "AGENT_DOCK_PROVIDER_KEY"\n`)), null);
  assert.equal(keyEnv(read(`[model_providers.a]\nenv_key = "agent_dock_log_key"\n`)), null);
  assert.equal(keyEnv(read(`[model_providers.a]\nenv_key = "ANTHROPIC_API_KEY"\n`)), null);
  assert.equal(keyEnv(read(`[[model_providers.a]]\nenv_key = "ARRAY_KEY"\n`)), null);
  assert.equal(keyEnv(read(`[model_providers.a]\nnote = """\nenv_key = "IN_STRING"\n"""\n`)), null, 'a multi-line string is not a key');
  assert.equal(keyEnv(`[model_providers.a]\nenv_key = "A_KEY"\n`), null, 'no provider selected: the built-in one');
  assert.equal(codexProviderKeyEnv({ env: { CODEX_HOME: 'h' }, read: () => { throw new Error('ENOENT'); } }), null);
  assert.deepEqual(codexAuthEnv({ env: {}, read: () => { throw new Error('ENOENT'); } }), CODEX_AUTH_ENV);
  assert.equal(tomlStrings('a = 1\nb = "x" # c\n').get('b'), 'x');
});

test('the provider key is hidden in logs even when its name does not look like a credential', () => {
  const env = { AZ_PROVIDER: 'zq8-unremarkable-value' };
  codexAuthEnv({ env, read: () => `model_provider = "a"\n[model_providers.a]\nenv_key = "AZ_PROVIDER"\n` });
  assert.equal(redactText('key zq8-unremarkable-value end').includes('zq8-unremarkable-value'), false);
  assert.equal(withoutSecrets(env).AZ_PROVIDER, undefined, 'every other child still loses it');
});

async function codexHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const use = (provider, envKey) => writeFile(path.join(home, 'config.toml'), `model_provider = "${provider}"\n[model_providers.${provider}]\nenv_key = "${envKey}"\n`);
  return { home, use };
}

function recordingSpawn(seen) {
  return (command, argv, options) => {
    seen.push(options.env);
    const child = new EventEmitter();
    child.pid = 78; child.exitCode = null; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { write() {}, end: () => setImmediate(() => { child.exitCode = 1; child.emit('close', 1); }) });
    return child;
  };
}

test('Codex implementation runs read the provider at each launch', async (t) => {
  const { home, use } = await codexHome(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-impl-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: 'p', CODEX_HOME: home, AZURE_OPENAI_API_KEY: 'az-value-123456', MISTRAL_API_KEY: 'mi-value-123456', GITHUB_TOKEN: 'gh-value-123456' };
  const seen = [];
  const worker = new CloudImplementationWorker({ cli: 'codex', stateDir: root, workspace: root, command: 'codex', env, spawnProcess: recordingSpawn(seen) });
  const task = { id: 't', name: 'T', prompt: 'x', qaCommand: 'node --version', allowedPaths: ['a.txt'] };
  await use('azure', 'AZURE_OPENAI_API_KEY');
  await worker.run('Add x', { task }).catch(() => {});
  await use('mistral', 'MISTRAL_API_KEY');
  await worker.run('Add x', { task }).catch(() => {});
  assert.equal(seen.length, 2);
  assert.equal(seen[0].AZURE_OPENAI_API_KEY, 'az-value-123456');
  assert.equal(seen[0].MISTRAL_API_KEY, undefined);
  assert.equal(seen[1].MISTRAL_API_KEY, 'mi-value-123456');
  assert.equal(seen[1].AZURE_OPENAI_API_KEY, undefined);
  assert.ok(seen.every((e) => e.GITHUB_TOKEN === undefined));
});

test('Codex planning and QA runs keep the active provider key too', async (t) => {
  const { home, use } = await codexHome(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-role-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await use('azure', 'AZURE_OPENAI_API_KEY');
  const seen = [];
  const codex = new CodexWorker({ workspace: root, stateDir: root, command: 'codex', env: { PATH: 'p', CODEX_HOME: home, AZURE_OPENAI_API_KEY: 'az-value-123456', GITHUB_TOKEN: 'gh-value-123456' }, spawnProcess: recordingSpawn(seen) });
  await codex.invoke('{}', 'read-only').catch(() => {});
  assert.equal(seen[0]?.AZURE_OPENAI_API_KEY, 'az-value-123456');
  assert.equal(seen[0]?.GITHUB_TOKEN, undefined);
});

test('text inside multi-line strings is never read as configuration', () => {
  const base = `model_provider = "a"\n[model_providers.a]\n`;
  assert.equal(keyEnv(`${base}note = """\nliteral triple: \\"""\nenv_key = "FROM_STRING"\n"""\nenv_key = "A_KEY"\n`), 'A_KEY');
  assert.equal(keyEnv(`${base}args = [\n  """\nenv_key = "FROM_ARRAY"\n  """,\n]\n`), null);
  assert.equal(keyEnv(`${base}note = '''\nenv_key = "FROM_LITERAL"\n'''\nenv_key = "A_KEY"\n`), 'A_KEY');
  assert.equal(keyEnv(`${base}note = """one line"""\nenv_key = "A_KEY"\n`), 'A_KEY');
});

test('a Codex role run hides the provider key in the prompt it writes', async (t) => {
  const { home, use } = await codexHome(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-role-redact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await use('a', 'PLAIN_NAME_PROVIDER');
  const codex = new CodexWorker({ workspace: root, stateDir: root, command: 'codex', env: { PATH: 'p', CODEX_HOME: home, PLAIN_NAME_PROVIDER: 'vq7-plain-provider-value' }, spawnProcess: recordingSpawn([]) });
  await codex.invoke('use vq7-plain-provider-value please', 'read-only').catch(() => {});
  const [dir] = await readdir(path.join(root, 'codex'));
  assert.equal((await readFile(path.join(root, 'codex', dir, 'prompt.txt'), 'utf8')).includes('vq7-plain-provider-value'), false);
});

test('Codex preflight gets no unrelated credentials', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-preflight-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'fake-codex.mjs'), out = path.join(root, 'env.json');
  await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env)));\nconsole.log('codex-cli 0.0.0');\n`);
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.GITHUB_TOKEN = 'gh-preflight-value'; process.env.OPENAI_API_KEY = 'oa-preflight-value';
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  await preflightCodex({ command: process.execPath, prefixArgs: [script], displayCommand: 'fake codex' });
  const names = JSON.parse(await readFile(out, 'utf8')).map((n) => n.toUpperCase());
  assert.ok(!names.includes('GITHUB_TOKEN'));
  assert.ok(names.includes('OPENAI_API_KEY'));
});

test('a line that closes one multi-line string and opens another skips the second', () => {
  const base = `model_provider = "a"\n[model_providers.a]\n`;
  assert.equal(keyEnv(`${base}args = ["""one""", """\nenv_key = "UNRELATED_SECRET"\n"""]\nenv_key = "A_KEY"\n`), 'A_KEY');
});

test('a Codex implementation hides the provider key in the prompt it writes and sends', async (t) => {
  const { home, use } = await codexHome(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-impl-redact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await use('a', 'OTHER_PLAIN_PROVIDER');
  let sent = '';
  const spawnProcess = (command, argv, options) => {
    const child = recordingSpawn([])(command, argv, options);
    const end = child.stdin.end;
    child.stdin.end = (text) => { sent = String(text); end(); };
    return child;
  };
  const worker = new CloudImplementationWorker({ cli: 'codex', stateDir: root, workspace: root, command: 'codex', env: { PATH: 'p', CODEX_HOME: home, OTHER_PLAIN_PROVIDER: 'wx5-other-provider-value' }, spawnProcess });
  await worker.run('use wx5-other-provider-value', { task: { id: 't', name: 'T', prompt: 'x', qaCommand: 'node --version', allowedPaths: ['a.txt'] } }).catch(() => {});
  const [dir] = await readdir(path.join(root, 'codex'));
  assert.equal((await readFile(path.join(root, 'codex', dir, 'prompt.txt'), 'utf8')).includes('wx5-other-provider-value'), false);
  assert.ok(sent.length > 0);
  assert.equal(sent.includes('wx5-other-provider-value'), false);
});

test('a line that ends one multi-line string may open the next', () => {
  const base = `model_provider = "a"\n[model_providers.a]\n`;
  assert.equal(keyEnv(`${base}args = [\n"""first\n""", """\nenv_key = "WRONG_KEY"\n"""\n]\nenv_key = "RIGHT_KEY"\n`), 'RIGHT_KEY');
});

test('quotes inside other strings and comments do not open or close multi-line strings', () => {
  const base = `model_provider = "a"\n[model_providers.a]\n`;
  assert.equal(keyEnv(`${base}args = ['"""', """\nenv_key = "FROM_STRING"\n"""]\nenv_key = "A_KEY"\n`), 'A_KEY');
  assert.equal(keyEnv(`${base}note = """\ntext\n""" # delimiter is """\nenv_key = "A_KEY"\n`), 'A_KEY');
  assert.equal(keyEnv(`${base}note = """ends with quotes"""""\nenv_key = "A_KEY"\n`), 'A_KEY');
  assert.equal(keyEnv(`${base}note = """line \\\nenv_key = "CONTINUED"\n"""\nenv_key = "A_KEY"\n`), 'A_KEY');
  assert.equal(keyEnv(`${base}# a comment with """ in it\nenv_key = "A_KEY"\n`), 'A_KEY');
  assert.equal(keyEnv(`${base}x = "has \\" and ''' inside"\nenv_key = "A_KEY"\n`), 'A_KEY');
});

test('what the reader does not handle drops the key rather than keeping another one', () => {
  assert.equal(keyEnv(`model_provider = "a"\n[model_providers.a]\nenv_key = "AZURE\\u005FKEY"\n`), null);
  assert.equal(keyEnv(`model_provider = "a]b"\n[model_providers."a]b"]\nenv_key = "AB_KEY"\n`), null);
  assert.equal(keyEnv(`model_provider = "a=b"\nmodel_providers."a=b".env_key = "AB_KEY"\n`), null);
});

test("an unreadable profile or provider setting keeps no provider key, never a fallback one", () => {
  const fallback = `model_provider = "fallback"
[model_providers.fallback]
env_key = "FALLBACK_KEY"
[model_providers.active]
env_key = "ACTIVE_KEY"
`;
  assert.equal(keyEnv(`profile = "wo\\u0072k"
${fallback}[profiles.work]
model_provider = "active"
`), null);
  assert.equal(keyEnv(`profile = "w]k"
${fallback}[profiles."w]k"]
model_provider = "active"
`), null);
  assert.equal(keyEnv(`profile = "work"
${fallback}[profiles]
work = { model_provider = "active" }
`), null);
  assert.equal(keyEnv(`profile = """work"""
${fallback}`), null);
  assert.equal(keyEnv(`${fallback}[model_providers.active.query_params]
api-version = "2025-01-01"
[model_providers.fallback]
request_max_retries = 4
`), "FALLBACK_KEY", "ordinary provider settings are fine");
  assert.equal(keyEnv(`model_provider = "azure"
[model_providers.azure]
env_key = "AZ_KEY"
query_params = { api-version = "2025-01-01" }
`), "AZ_KEY");
});

test("escaped keys keep no provider key; comments never count", () => {
  const fallback = `model_provider = "fallback"
[model_providers.fallback]
env_key = "FALLBACK_KEY"
[model_providers.active]
env_key = "ACTIVE_KEY"
`;
  assert.equal(keyEnv(`"pro\\u0066ile" = "work"
${fallback}[profiles.work]
model_provider = "active"
`), null);
  assert.equal(keyEnv(`${fallback}[profiles."wo\\u0072k"]
model_provider = "active"
`), null);
  assert.equal(keyEnv(`${fallback}[model_providers.fallback]
request_max_retries = 4 # model_provider retries
`), "FALLBACK_KEY");
});

test("an escaped key inside a provider or profile inline table keeps no provider key", () => {
  const fallback = `model_provider = "fallback"
[model_providers.fallback]
env_key = "FALLBACK_KEY"
[model_providers.active]
env_key = "ACTIVE_KEY"
`;
  assert.equal(keyEnv(`profile = "work"
${fallback}[profiles]
work = { "model_pro\\u0076ider" = "active" }
`), null);
  assert.equal(keyEnv(`${fallback}[mcp_servers.x]
command = "C:\\\\tools\\\\x.exe"
args = ["C:\\\\y"]
`), "FALLBACK_KEY", "Windows paths elsewhere are fine");
});

test("env_key may not name a system variable, and a duplicate key is never guessed between (kadono, 0.39.3)", () => {
  assert.equal(keyEnv(`model_provider = "a"\n[model_providers.a]\nenv_key = "PATH"\n`), null);
  assert.equal(keyEnv(`model_provider = "a"\n[model_providers.a]\nenv_key = "HOME"\n`), null);
  // The families too (release review 0.40.0: the pattern had lost its backslashes).
  for (const name of ["LC_ALL", "XDG_CONFIG_HOME", "PROCESSOR_ARCHITECTURE"]) assert.equal(keyEnv(`model_provider = "a"\n[model_providers.a]\nenv_key = "${name}"\n`), null, name);
  assert.equal(keyEnv(`model_provider = "a"\n[model_providers.a]\nenv_key = "GROQ_TOKEN"\n`), "GROQ_TOKEN");
  assert.equal(keyEnv(`model_provider = "a"\n[model_providers.a]\nenv_key = "A_KEY"\nenv_key = "B_KEY"\n`), null);
});
