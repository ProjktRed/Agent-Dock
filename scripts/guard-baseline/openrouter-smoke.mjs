#!/usr/bin/env node
// One bounded real OpenCode run. The forwarding server records usage, never credentials.
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPolicy } from '../../engine/src/guard/policy.mjs';
import { adapter } from '../../engine/src/guard/adapters/opencode.mjs';
import { launchOpenCode, preflightOpenCode, openCodeChildEnv } from '../../engine/src/opencode-cli-worker.mjs';
import { createProvider } from '../../engine/src/runtime/provider.mjs';

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('Set OPENROUTER_API_KEY in the environment before running this smoke.');
const command = process.env.OPENCODE_COMMAND || '/home/box/.local/bin/opencode';
const model = (process.env.OPENROUTER_SMOKE_MODEL || 'openrouter/z-ai/glm-5.3-flash').replace(/^openrouter\//, '');
const root = await mkdtemp(path.join(os.tmpdir(), 'agent-dock-openrouter-smoke-'));
const generations = new Map();
let modelRequests = 0;
const proxy = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (request.method === 'POST') {
      modelRequests++;
      if (modelRequests > 1) throw new Error('Smoke permits one model generation only');
      // Bound all generated output, including any auxiliary request the CLI makes.
      const parsed = JSON.parse(body);
      parsed.max_tokens = 128;
      if (parsed.stream) parsed.stream_options = { ...parsed.stream_options, include_usage: true };
      delete parsed.max_completion_tokens;
      chunks.length = 0;
      chunks.push(Buffer.from(JSON.stringify(parsed)));
    }
    const upstream = await fetch(`https://openrouter.ai/api/v1${request.url.replace(/^\/v1/, '')}`, {
      method: request.method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(request.method !== 'GET' ? { body: Buffer.concat(chunks) } : {}),
      signal: AbortSignal.timeout(60000),
    });
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
    let captured = '';
    for await (const chunk of upstream.body) {
      captured += Buffer.from(chunk).toString('utf8');
      response.write(chunk);
    }
    response.end();
    const frames = captured.startsWith('data:') || captured.includes('\ndata:')
      ? captured.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)) : [captured];
    for (const frame of frames) {
      if (frame === '[DONE]') continue;
      let payload; try { payload = JSON.parse(frame); } catch { continue; }
      if (payload.id) {
        const previous = generations.get(payload.id) || {};
        generations.set(payload.id, { ...previous, ...(payload.usage ? { usage: payload.usage } : {}) });
      }
    }
  } catch {
    // No exception text: provider errors can include HTTP headers or secrets.
    if (!response.headersSent) response.writeHead(502);
    response.end('OpenRouter forwarding failed');
  }
});
try {
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const workspace = path.join(root, 'workspace');
  const guardDir = path.join(root, 'state', 'opencode-guard');
  await mkdir(workspace, { recursive: true });
  await mkdir(guardDir, { recursive: true });
  await writeFile(path.join(workspace, 'probe.txt'), 'smoke\n');
  const provider = await createProvider({ provider: 'openrouter', model, providerApiKeyEnv: 'OPENROUTER_API_KEY', contextTokens: 32768, maxOutputTokens: 128, timeoutMs: 60000 });
  await provider.preflight();
  // Keep the descriptor's OpenRouter identity and env-key path; only transport passes through
  // loopback so the actual OpenRouter generation/usage response can be inspected.
  const providerDescriptor = { ...provider, baseUrl: `http://127.0.0.1:${proxy.address().port}/v1`, maxOutputTokens: 128 };
  const policy = await createPolicy({ id: 'openrouter-smoke', allowedPaths: ['probe.txt'], qaCommand: 'git diff --check' }, workspace);
  const policyPath = path.join(guardDir, 'policy.json');
  await writeFile(policyPath, JSON.stringify(policy));
  const guard = await adapter.install({ policy, policyPath, guardDir, providerDescriptor, model, steps: 1 });
  const env = openCodeChildEnv(process.env, guard, providerDescriptor.apiKeyEnv);
  await preflightOpenCode({ command, workspace, env, policyPath, handshake: guard.handshake, apiKeyEnv: providerDescriptor.apiKeyEnv });
  const result = await launchOpenCode({ command, workspace, providerDescriptor, model, timeoutSeconds: 90, steps: 1, guard, env, prompt: 'Reply with exactly OK. Do not use tools.' });
  assert.equal(result.exitCode, 0, 'OpenCode smoke must complete successfully');
  assert.equal(modelRequests, 1, 'Smoke permits one model generation only');
  assert.ok(generations.size > 0, 'A real OpenRouter generation must be observed');
  let totalCost = 0;
  for (const [id, record] of generations) {
    let cost = record.usage?.cost;
    if (typeof cost !== 'number') {
      // Generation accounting may trail the streaming response briefly. These are usage GETs,
      // not additional model generations.
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
        const payload = await response.json();
        if (response.ok && typeof payload.data?.total_cost === 'number') { cost = payload.data.total_cost; break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    assert.equal(typeof cost, 'number', 'OpenRouter must report a usage cost; no estimated cost is substituted');
    totalCost += cost;
    console.log(JSON.stringify({ generationId: id, costUSD: cost, usage: record.usage ?? null }));
  }
  console.log(JSON.stringify({ provider: 'openrouter', model, runs: 1, steps: 1, maxOutputTokens: 128, modelRequests, totalCostUSD: totalCost }));
} finally {
  await new Promise(resolve => proxy.close(resolve));
  await rm(root, { recursive: true, force: true });
}
