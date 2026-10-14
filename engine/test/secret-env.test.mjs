import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_AUTH_ENV, CODEX_AUTH_ENV, registerSecretEnv, withoutSecrets } from '../src/secret-env.mjs';
import { claudeChildEnv } from '../src/claude-worker.mjs';

const env = { PATH: 'p', AGENT_DOCK_PROVIDER_KEY: 'app', OPENROUTER_API_KEY: 'or', openai_api_key: 'oa', ANTHROPIC_API_KEY: 'an', MY_PROVIDER_KEY: 'mine', GITHUB_TOKEN: 'gh' };

test('check commands and worker shells get no provider or CLI credentials', () => {
  registerSecretEnv('MY_PROVIDER_KEY');
  assert.deepEqual(withoutSecrets(env), { PATH: 'p', GITHUB_TOKEN: 'gh' });
});

test('each orchestrator CLI keeps only its own sign-in variables', () => {
  assert.deepEqual(Object.keys(withoutSecrets(env, { keep: CODEX_AUTH_ENV })).sort(), ['GITHUB_TOKEN', 'PATH', 'openai_api_key']);
  assert.deepEqual(Object.keys(withoutSecrets(env, { keep: CLAUDE_AUTH_ENV })).sort(), ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'PATH']);
  assert.equal(claudeChildEnv(env).AGENT_DOCK_PROVIDER_KEY, undefined);
  assert.equal(claudeChildEnv(env).ANTHROPIC_API_KEY, 'an');
});
