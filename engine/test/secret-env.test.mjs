import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_AUTH_ENV, CODEX_AUTH_ENV, registerSecretEnv, withoutSecrets } from '../src/secret-env.mjs';
import { claudeChildEnv } from '../src/claude-worker.mjs';

const env = { PATH: 'p', AGENT_DOCK_PROVIDER_KEY: 'app', OPENROUTER_API_KEY: 'or', openai_api_key: 'oa', ANTHROPIC_API_KEY: 'an', MY_PROVIDER_KEY: 'mine', GITHUB_TOKEN: 'gh' };

test('check commands and worker shells get no provider or CLI credentials', () => {
  registerSecretEnv('MY_PROVIDER_KEY');
  assert.deepEqual(withoutSecrets(env), { PATH: 'p' });
});

test('each orchestrator CLI keeps only its own sign-in variables', () => {
  assert.deepEqual(Object.keys(withoutSecrets(env, { keep: CODEX_AUTH_ENV, windows: true })).sort(), ['PATH', 'openai_api_key']);
  // Elsewhere openai_api_key is a different variable from the OPENAI_API_KEY Codex signs in with.
  assert.deepEqual(Object.keys(withoutSecrets(env, { keep: CODEX_AUTH_ENV, windows: false })).sort(), ['PATH']);
  assert.deepEqual(withoutSecrets({ OPENAI_API_KEY: 'mine', openai_api_key: 'other' }, { keep: CODEX_AUTH_ENV, windows: false }), { OPENAI_API_KEY: 'mine' });
  assert.deepEqual(Object.keys(withoutSecrets(env, { keep: CLAUDE_AUTH_ENV })).sort(), ['ANTHROPIC_API_KEY', 'PATH']);
  assert.equal(claudeChildEnv(env).AGENT_DOCK_PROVIDER_KEY, undefined);
  assert.equal(claudeChildEnv(env).ANTHROPIC_API_KEY, 'an');
});

test('any variable named like a credential is removed, not only the listed ones', () => {
  const secrets = ['GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENCODE_API_KEY', 'GOOGLE_APIKEY', 'GITHUB_TOKEN', 'GITHUB_PAT',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'SECRET_KEY_BASE', 'MY_SERVICE_PASSWORD', 'Some_Token', 'GCP_CREDENTIALS',
    'PGPASSWORD', 'MYSQL_PWD', 'REDISCLI_AUTH', 'DOCKER_AUTH_CONFIG', 'NPM_CONFIG__AUTH', 'NPM_CONFIG__AUTHTOKEN', 'CLIENTSECRET', 'NPM_CONFIG_OTP', 'MYAPIKEY',
    'GOOGLE_APPLICATION_CREDENTIALS_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'NPM_CONFIG_FOO_TOKEN_FILE', 'TOKEN_PATH', 'API-KEY', 'my.secret', 'HTTP_AUTHORIZATION', 'AUTHORIZATION'];
  const plain = ['PATH', 'HOME', 'KEYBOARD_LAYOUT', 'TOKENIZERS_PARALLELISM', 'NODE_OPTIONS', 'PATHEXT', 'SSH_AUTH_SOCK', 'MAX_TOKENS', 'PWD', 'OLDPWD', 'AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
    'NPM_CONFIG_ALWAYS_AUTH', 'PASSWORD_STORE_DIR', 'COTP', 'POTPOURRI', 'FOOTPRINT'];
  const all = Object.fromEntries([...secrets, ...plain].map((name) => [name, 'value-' + name]));
  assert.deepEqual(Object.keys(withoutSecrets(all)).sort(), [...plain].sort());
  // keep still hands a worker its own sign-in variable, whatever it is named.
  assert.equal(withoutSecrets(all, { keep: ['GEMINI_API_KEY'] }).GEMINI_API_KEY, 'value-GEMINI_API_KEY');
  assert.equal(withoutSecrets(all, { keep: ['gemini_api_key'], windows: true }).GEMINI_API_KEY, 'value-GEMINI_API_KEY');
});

test('check commands also lose indirect credentials (SSH agent, askpass helpers, npm user config); agents keep them', async () => {
  const { checkEnv } = await import('../src/secret-env.mjs');
  const env = { PATH: '/bin', SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_ASKPASS: 'helper', GIT_SSH_COMMAND: 'ssh -i k', npm_config_userconfig: '/home/u/.npmrc', NPM_CONFIG_CAFILE: 'ca.pem', OPENAI_API_KEY: 'x' };
  assert.deepEqual(checkEnv(env), { PATH: '/bin' });
  assert.equal(withoutSecrets(env).SSH_AUTH_SOCK, '/tmp/agent.sock', 'agents keep them until destination-bound grants exist');
  const { runShellCommand } = await import('../src/qa-packet.mjs');
  const before = process.env.GIT_ASKPASS;
  process.env.GIT_ASKPASS = 'probe-helper';
  try {
    const result = await runShellCommand(process.platform === 'win32' ? 'echo [%GIT_ASKPASS%]' : 'echo "[$GIT_ASKPASS]"', process.cwd());
    assert.doesNotMatch(result.stdout, /probe-helper/);
  } finally { if (before === undefined) delete process.env.GIT_ASKPASS; else process.env.GIT_ASKPASS = before; }
});
