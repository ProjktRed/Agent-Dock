import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runNodeLoop } from '../src/node-loop.mjs';
import { DashboardState } from '../src/dashboard-state.mjs';
import { qaRetryAvailability } from '../src/recovery-policy.mjs';

const task = { id:'Q', name:'Retry QA', prompt:'Task skill: implement\nAdd x', allowedPaths:['src/x.js'], qaCommand:'npm test' };
const packet = (attempt, scope = 'PASS') => ({ task, baselineSha:'base', attempt, diff:{ text:'diff', bytes:4 }, changedFiles:['src/x.js'], clineSummary:{ exitCode:0, text:'done' }, qaEvidence:{ command:{ command:'npm test', exitCode:0 }, categories:{ tests:'PASS', scopeCheck:scope }, scope:{ status:scope } } });
// What a QA that could not run any command leaves behind: a blocked task with a finished, in-scope attempt.
const blockedRecovery = (extra = {}) => ({ version:1, baselineSha:'base', attempt:3, phase:'blocked', prompt:'p', history:[], correctionCount:2, correctionHistory:[], elevations:[], lastElevationCount:0,
  userAttention:false, workerResult:{ exitCode:0, runResult:{ finishReason:'completed', text:'done' } }, qaPacket:packet(3),
  failure:{ status:'manual-review', output:'helper_unknown_error: setup refresh had errors', manualReviewCause:'malformed-state' }, blockedReason:'helper_unknown_error', ...extra });

async function setup(t, recovery) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qa-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = new DashboardState({ stateDir: root });
  await state.initialize({ task, workspace: root });
  await writeFile(path.join(root, 'current-task.json'), JSON.stringify({ ...task, automation:{ recovery } }));
  return { root, state };
}
const loop = (root, state, extra) => runNodeLoop({ workspace:root, stateDir:root, objective:'x', stopAfterTask:true, codex:{ activeCount:0 },
  worker:{ withExclusive:fn=>fn(), run:()=>assert.fail('the finished attempt must not be implemented again') },
  baseline:async()=>({ head:'base' }), verify:async()=>{}, reconcile:async()=>{},
  readControl:()=>state.readControl(), onEvent:e=>state.record(e), pollMs:1, ...extra });

test('Retry QA is offered only for a finished, clean, in-scope attempt', () => {
  assert.equal(qaRetryAvailability(blockedRecovery()).available, true);
  assert.match(qaRetryAvailability(blockedRecovery({ phase:'worker' })).reason, /not blocked/);
  assert.match(qaRetryAvailability(blockedRecovery({ qaPacket:packet(3, 'FAIL') })).reason, /outside its approved paths/);
  assert.match(qaRetryAvailability(blockedRecovery({ workerResult:{ exitCode:1 } })).reason, /did not finish cleanly/);
  assert.match(qaRetryAvailability(blockedRecovery({ qaPacket:packet(2) })).reason, /no evidence yet/);
  assert.equal(qaRetryAvailability(null).available, false);
});

test('Retry QA collects fresh evidence and QA reviews the same attempt; without it the block stays with the Resolver', async t => {
  const { root, state } = await setup(t, blockedRecovery());
  let evidence = 0, reviews = 0;
  await state.setControl('retry-qa');
  const result = await loop(root, state, {
    prepareQa:async input=>{ evidence++; assert.equal(input.attempt, 3); return packet(3); },
    review:async()=>{ reviews++; return { status:'pass', output:'verified', commit:'abc' }; },
    assessCorrection:()=>assert.fail('no correction'), elevate:()=>assert.fail('no elevation'),
  });
  assert.equal(result.status, 'passed');
  assert.equal(evidence, 1, 'fresh check results before QA');
  assert.equal(reviews, 1);
  const activity = (await state.readLive());
  assert.equal(activity.blockedReason ?? null, null);

  const second = await setup(t, blockedRecovery());
  const stays = await loop(second.root, second.state, {
    codex:{ activeCount:0, resolveBlocked:async()=>{ return { status:'blocked', preserve:[], rootProblem:'x', previousStrategyFailure:'', newStrategy:'', nextWorkerInstructions:'', neededEvidence:[], failureReason:'still blocked' }; } },
    review:()=>assert.fail('QA must not run without Retry QA'), prepareQa:()=>assert.fail('no evidence without Retry QA'),
  });
  assert.equal(stays.status, 'blocked');
});

test('Retry QA is refused when the attempt cannot be reviewed', async t => {
  const { state } = await setup(t, blockedRecovery({ qaPacket:packet(3, 'FAIL') }));
  await assert.rejects(state.setControl('retry-qa'), /Retry QA unavailable: The change is outside its approved paths/);
});
