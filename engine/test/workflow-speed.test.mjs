import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectClineProcess } from '../src/cline-cli-worker.mjs';
import { runNodeLoop } from '../src/node-loop.mjs';
import { DashboardState } from '../src/dashboard-state.mjs';
import { compactCorrections, correctionInstructions, packetForPrompt, qaEnvironmentFailure } from '../src/recovery-policy.mjs';
import { buildCorrectionPrompt } from '../src/workflow.mjs';

// A Cline process that writes the given lines, then keeps running until it is killed.
function hangingProcess(lines) {
  const child = new EventEmitter();
  child.pid = 7400;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
  };
  queueMicrotask(() => { for (const line of lines) child.stdout.write(`${line}\n`); });
  return child;
}
const agentEvent = (event) => JSON.stringify({ type: 'agent_event', event });
const say = (text) => agentEvent({ type: 'say', say: 'text', text });
const tool = (file) => agentEvent({ type: 'say', say: 'tool', text: JSON.stringify({ tool: 'read_file', path: file }) });

test('a worker repeating the same step is ended early, like a timeout', async () => {
  const events = [];
  const step = 'Let me try a different approach - I will add the comment to the whole expression';
  const result = await collectClineProcess('fake', [], {
    spawnProcess: () => hangingProcess([say(step), tool('a.ts'), say(step), tool('a.ts'), say(step), tool('a.ts'), say(step)]),
    onEvent: (e) => events.push(e), repeatLimit: 4,
  });
  assert.equal(result.exitCode, 124);
  assert.equal(result.runResult.finishReason, 'timeout');
  assert.match(result.runResult.text, /repeated the same step 4 times/);
  assert.equal(events.filter((e) => e.type === 'cline-stalled').length, 1);
});

test('a worker that goes silent after starting is ended; silence before its first output is not', async () => {
  const result = await collectClineProcess('fake', [], {
    spawnProcess: () => hangingProcess([say('Reading the task')]), stallMs: 50,
  });
  assert.equal(result.runResult.finishReason, 'timeout');
  assert.match(result.runResult.text, /No worker output/);
  // Silent from the start (a local model reading a long prompt): only the test ends it, after 4× stallMs.
  const quiet = await collectClineProcess('fake', [], {
    spawnProcess: () => { const child = hangingProcess([]); setTimeout(child.kill, 200); return child; },
    stallMs: 50, requireRunResult: false,
  });
  assert.equal(quiet.runResult, undefined, 'not reported as stalled');
});

const task = { id: 'E', name: 'Env', prompt: 'Task skill: implement\nAdd x', allowedPaths: ['src/x.js'], qaCommand: 'npm test' };
const packet = (attempt) => ({ task, baselineSha: 'base', attempt, diff: { text: 'diff', bytes: 4 }, changedFiles: ['src/x.js'], clineSummary: { exitCode: 0, text: 'done' }, qaEvidence: { command: { command: 'npm test', exitCode: 0 }, categories: { tests: 'PASS', scopeCheck: 'PASS' }, scope: { status: 'PASS' } } });
const sandboxFailure = { status: 'fail', output: 'BLOCKED: Both command attempts failed before execution with helper_unknown_error: setup refresh had errors.' };

async function loop(t, reviews) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'env-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = new DashboardState({ stateDir: root });
  await state.initialize({ task, workspace: root });
  const counts = { evidence: 0, reviews: 0 };
  const result = await runNodeLoop({ workspace: root, stateDir: root, initialTask: task, stopAfterTask: true, codex: { activeCount: 0 },
    worker: { withExclusive: (fn) => fn(), run: async (_p, hooks) => { await hooks.onStart({ pid: 1 }); return { exitCode: 0 }; } },
    baseline: async () => ({ head: 'base' }), verify: async () => {}, reconcile: async () => {},
    prepareQa: async (input) => { counts.evidence++; return packet(input.attempt); },
    review: async () => reviews[counts.reviews++] ?? sandboxFailure,
    assessCorrection: () => assert.fail('an environment failure is not a correction for the worker'),
    readControl: () => state.readControl(), onEvent: (e) => state.record(e), pollMs: 1 });
  return { result, counts };
}

test('QA that cannot run its tools is retried once instead of becoming a correction', async (t) => {
  const { result, counts } = await loop(t, [sandboxFailure, { status: 'pass', output: 'verified', commit: 'abc' }]);
  assert.equal(result.status, 'passed');
  assert.deepEqual(counts, { evidence: 2, reviews: 2 });
});

test('a second environment failure stops with an explanation, not a worker correction', async (t) => {
  const { result, counts } = await loop(t, [sandboxFailure, sandboxFailure]);
  assert.equal(result.status, 'blocked');
  assert.match(result.output, /environment problem, not the code/);
  assert.equal(counts.reviews, 2);
});

test('environment failures are told apart from code failures', () => {
  const ok = packet(1);
  assert.equal(qaEnvironmentFailure(sandboxFailure, ok), true);
  assert.equal(qaEnvironmentFailure({ status: 'fail', output: 'npm is not recognized as an internal or external command' }, ok), true);
  assert.equal(qaEnvironmentFailure({ status: 'fail', output: 'Expected 5, received 4' }, ok), false);
  assert.equal(qaEnvironmentFailure({ status: 'fail', output: 'Permission denied while writing src/x.js' }, ok), false);
  assert.equal(qaEnvironmentFailure(sandboxFailure, { qaEvidence: { command: { exitCode: 1 } } }), false, 'own checks failed too');
  assert.equal(qaEnvironmentFailure({ ...sandboxFailure, status: 'pass' }, ok), false);
});

test('reasoning prompts carry each correction once, without the repeated task', () => {
  const prompt = buildCorrectionPrompt(task, 'QA said no', 1, 'Fix the owner field only.');
  assert.equal(correctionInstructions(prompt), 'Fix the owner field only.');
  const [entry] = compactCorrections([{ id: 'c1', source: 'assessment', attempt: 2, attempted: true, prompt }]);
  assert.deepEqual(entry, { id: 'c1', source: 'assessment', attempt: 2, attempted: true, instructions: 'Fix the owner field only.' });
  const compact = packetForPrompt(packet(1));
  assert.equal(compact.task, undefined);
  assert.equal(compact.diff, undefined);
  assert.equal(compact.qaEvidence.command.exitCode, 0);
});
