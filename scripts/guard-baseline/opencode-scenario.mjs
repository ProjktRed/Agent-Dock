#!/usr/bin/env node
// Real OpenCode v2 + scripted OpenAI-compatible stub. Run outside the offline sandbox.
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startStub } from './stub-llamacpp.mjs';
import { TASK, SEED_FILES } from './scenarios.mjs';
import { createPolicy } from '../../engine/src/guard/policy.mjs';
import { readGuardOutcome } from '../../engine/src/guard/state.mjs';
import { adapter, SENTINEL_BASE_URL } from '../../engine/src/guard/adapters/opencode.mjs';
import { handleGuardEvent } from '../../engine/src/guard/adapters/cline.mjs';
import { canRecoverOperational } from '../../engine/src/blocked-resolver.mjs';
import { stopMessage } from '../../engine/src/guard/reasons.mjs';
import { launchOpenCode, preflightOpenCode, openCodeChildEnv, collectOpenCodeProcess } from '../../engine/src/opencode-cli-worker.mjs';

// Semantic equivalence is explicit: effect and exact Cline reason, never byte-equal artifacts.
const command = process.env.OPENCODE_COMMAND || '/home/box/.local/bin/opencode';
const syntheticKey = 'synthetic-provider-key-must-not-persist';
const root = await mkdtemp(path.join(os.tmpdir(), 'agent-dock-opencode-scenario-'));
const cases = [
  { name: 'in-scope-edit', tool: 'write', input: ws => ({ path: path.join(ws, 'src/inscope/new.ts'), content: 'export const NEW = 1;\n' }), clineTool: 'editor', clineInput: ws => ({ path: path.join(ws, 'src/inscope/new.ts'), new_text: 'export const NEW = 1;\n' }) },
  { name: 'out-of-scope-edit', tool: 'edit', input: ws => ({ path: path.join(ws, 'src/beta.ts'), oldString: 'BETA_VERSION = 1', newString: 'BETA_VERSION = 2' }), clineTool: 'editor', clineInput: ws => ({ path: path.join(ws, 'src/beta.ts'), old_text: 'BETA_VERSION = 1', new_text: 'BETA_VERSION = 2' }), blocked: true },
  ...['git push origin main', 'bash -c \"git push origin main\"', 'git -C . push origin main'].map((command, index) => ({ name: `unsafe-command-${index + 1}`, tool: 'shell', input: () => ({ command, description: 'Unsafe command probe' }), clineTool: 'run_commands', clineInput: () => ({ commands: [command] }), blocked: true })),
  { name: 'unapproved-command', tool: 'shell', input: () => ({ command: 'npm run deploy', description: 'Unapproved command probe' }), clineTool: 'run_commands', clineInput: () => ({ commands: ['npm run deploy'] }), blocked: true },
  { name: 'provider-key-shell-redaction', tool: 'shell', input: () => ({ command: 'npm run check', description: 'Approved provider-key redaction probe' }), clineTool: 'run_commands', clineInput: () => ({ commands: ['npm run check'] }), credentialRedaction: true },
];
try {
  for (const probe of cases) {
    const workspace = path.join(root, probe.name, 'workspace');
    const guardDir = path.join(root, probe.name, 'state', 'opencode-guard');
    await mkdir(guardDir, { recursive: true });
    for (const [file, content] of Object.entries(SEED_FILES)) {
      await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
      const seeded = file === 'package.json' ? JSON.stringify({ ...JSON.parse(content), scripts: { ...JSON.parse(content).scripts, deploy: `node -e \"require('fs').writeFileSync('deploy-ran','yes')\"`, ...(probe.credentialRedaction ? { check: `node -e \"console.log(process.env.AGENT_DOCK_STUB_KEY ?? 'KEY_WAS_STRIPPED')\"` } : {}) } }) : content;
      await writeFile(path.join(workspace, file), seeded);
    }
    execFileSync('git', ['init', '-q', workspace]);
    // A project config that would permit everything must be ignored by the worker.
    await mkdir(path.join(workspace, '.opencode'), { recursive: true });
    await writeFile(path.join(workspace, '.opencode', 'opencode.json'), JSON.stringify({ permissions: [{ tool: '*', effect: 'allow' }] }));
    const scenario = { name: probe.name, model: 'stub-model', turns: [
      { toolCalls: [{ name: probe.tool, arguments: probe.input(workspace) }] },
      { content: 'Done.', finish: 'stop' },
    ] };
    const stub = await startStub({ scenario });
    try {
      const policy = await createPolicy(TASK, workspace);
      const policyPath = path.join(guardDir, 'policy.json');
      await writeFile(policyPath, JSON.stringify(policy));
      const providerDescriptor = { id: 'openai', baseUrl: stub.baseUrl, model: 'stub-model', apiKeyEnv: 'AGENT_DOCK_STUB_KEY', contextTokens: 32768, maxOutputTokens: 256 };
      const guard = await adapter.install({ policy, policyPath, guardDir, providerDescriptor, model: 'stub-model', steps: 3 });
      const installedPolicy = await readGuardOutcome(policyPath);
      const env = openCodeChildEnv({ ...process.env, AGENT_DOCK_STUB_KEY: syntheticKey }, guard, providerDescriptor.apiKeyEnv);
      await preflightOpenCode({ command, workspace, env, policyPath, handshake: guard.handshake, apiKeyEnv: providerDescriptor.apiKeyEnv });
      let result, failure;
      try { result = await launchOpenCode({ command, workspace, providerDescriptor, model: 'stub-model', timeoutSeconds: 90, steps: 3, guard, prompt: TASK.prompt + guard.instructions, env }); }
      catch (error) { failure = error; }
      const outcome = await readGuardOutcome(policyPath);
      assert.equal(outcome.runtimeReady, true, 'Plugin must register hooks');
      assert.ok(stub.scriptedTurnsUsed() > 0, 'Must execute a real scripted model turn');
      const clinePath = path.join(guardDir, 'cline-policy.json');
      await writeFile(clinePath, JSON.stringify(await createPolicy(TASK, workspace)));
      const control = await handleGuardEvent(clinePath, { hookName: 'tool_call', tool_call: { name: probe.clineTool, input: probe.clineInput(workspace) } });
      if (probe.blocked) {
        assert.equal(outcome.stopped, true, 'Guard must persist the denial');
        const cline = await readGuardOutcome(clinePath);
        assert.equal(outcome.reason, cline.reason, 'OpenCode and Cline must deny with the same reason');
        const recoverable = (label, reason) => canRecoverOperational({ headMatches: true, unexpectedPaths: [], currentDiff: { truncated: false }, failure: { reason: stopMessage(label, reason) } });
        assert.equal(recoverable('OpenCode', outcome.reason), recoverable('Cline', cline.reason), 'Operational recovery verdict must match Cline');
        assert.equal(await readFile(path.join(workspace, 'src/beta.ts'), 'utf8'), SEED_FILES['src/beta.ts']);
        await assert.rejects(access(path.join(workspace, 'deploy-ran')), { code: 'ENOENT' }, 'Unapproved command must not execute');
      } else {
        assert.ifError(failure);
        assert.equal(result.exitCode, 0);
        assert.equal(outcome.stopped, false);
        assert.equal(control.cancel, false);
        if (probe.credentialRedaction) {
          assert.ok(result.events.some(event => event.type === 'tool_use'), 'Approved shell tool must execute');
          assert.ok(!JSON.stringify(result.events).includes(syntheticKey), 'Captured tool events must not expose provider key');
          const sessionID = result.events.find(event => typeof event.sessionID === 'string')?.sessionID;
          assert.ok(sessionID, 'Completed run must expose its persisted session ID');
          const rawSession = await collectOpenCodeProcess(command, ['session', 'export', '--standalone', sessionID], { cwd: workspace, env, timeoutMs: 30_000 });
          assert.equal(rawSession.exitCode, 0, 'Session export must succeed');
          assert.ok(rawSession.stdout.includes('KEY_WAS_STRIPPED'), 'Persisted tool output must show the approved command ran without the key');
          assert.ok(!rawSession.stdout.includes(syntheticKey), 'Raw persisted session storage must not contain provider key');
          assert.ok(stub.requests.length > 0, 'Provider calls must still reach the local OpenAI-compatible stub');
        } else {
          assert.equal(await readFile(path.join(workspace, 'src/inscope/new.ts'), 'utf8'), 'export const NEW = 1;\n');
        }
      }
      console.log(JSON.stringify({ scenario: probe.name, effect: probe.blocked ? 'blocked' : 'allowed', reason: outcome.reason }));
      // Remove the plugin after preparing a fresh policy: preflight must refuse before a model call.
      await writeFile(policyPath, JSON.stringify({ ...installedPolicy, runtimeReady: false, stopped: false, reason: null }));
      await rm(guard.pluginPath);
      const before = stub.requests.length;
      await assert.rejects(preflightOpenCode({ command, workspace, env, policyPath, handshake: guard.handshake, apiKeyEnv: providerDescriptor.apiKeyEnv }), /plugin|guard|active|initializ/i);
      assert.equal(stub.requests.length, before, 'Disabled plugin must spend zero model requests');
      // Bypass the worker preflight to exercise the independent in-process sentinel.
      // The fork retries failed connections indefinitely. This observer records the
      // unchanged endpoint and first real error, then stops retries; it cannot unlock it.
      const requestPath = path.join(guardDir, 'disabled-request.json'), errorPath = path.join(guardDir, 'disabled-error.json');
      await writeFile(path.join(path.dirname(guard.pluginPath), 'disabled-observer.js'), `import {writeFile} from 'node:fs/promises';\nexport default {id:'agent-dock.disabled-observer',async setup(ctx){\nawait ctx.session.hook('model.request',event=>writeFile(${JSON.stringify(requestPath)},JSON.stringify({baseURL:event.baseURL})));\nawait ctx.session.hook('retry',async event=>{await writeFile(${JSON.stringify(errorPath)},JSON.stringify(event.error));event.decision={retry:false};});\n}};\n`);
      const forced = await collectOpenCodeProcess(command, ['run', '--standalone', '--format', 'json', '-m', `${guard.providerID}/${guard.model}`, '--agent', 'agent-dock', '--auto', 'Disabled plugin probe'], { cwd: workspace, env, timeoutMs: 10_000, apiKeyEnv: providerDescriptor.apiKeyEnv });
      assert.notEqual(forced.runResult.finishReason, 'completed', 'Disabled plugin must never complete a forced run');
      assert.ok(forced.events.some(event => event.type === 'error'), 'Forced run must report a provider error');
      assert.equal(JSON.parse(await readFile(requestPath, 'utf8')).baseURL, SENTINEL_BASE_URL, 'Disabled plugin must leave the sentinel locked');
      assert.match(await readFile(errorPath, 'utf8'), /connect|refused|ECONNREFUSED|fetch/i, 'Must record a real sentinel connection failure');
      assert.equal((await readGuardOutcome(policyPath)).runtimeReady, false, 'Disabled plugin cannot satisfy its handshake');
      assert.equal(stub.requests.length, before, 'Sentinel must block model requests even without preflight');
      console.log(JSON.stringify({ scenario: 'plugin-disabled', effect: 'refused', modelRequests: 0 }));
    } finally { await stub.close(); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
