import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runNodeLoop } from '../src/node-loop.mjs';
import { DashboardState } from '../src/dashboard-state.mjs';
import { buildRolePrompt, parseRoleResult, parseRoles, roleGuidanceText } from '../src/workflow-roles.mjs';
import { DEFAULT_TUNING, TUNING, parseTuning, taskSizingText, useTuning } from '../src/engine-tuning.mjs';
import { CloudImplementationWorker, buildImplementationArgs, claudeImplementationTools } from '../src/cloud-impl-worker.mjs';
import { parseImplementation } from '../src/loop-options.mjs';

const task = { id:'W', name:'Roles', prompt:'Task skill: implement\nAdd x', allowedPaths:['src/x.js'], qaCommand:'npm test' };
const packet = ({attempt,workerResult}) => ({task,baselineSha:'base',attempt,diff:{text:'diff '+attempt,bytes:6},changedFiles:['src/x.js'],clineSummary:{exitCode:workerResult.exitCode,text:'changed x'},qaEvidence:{command:{command:'npm test',exitCode:0},categories:{tests:'PASS',scopeCheck:'PASS'}}});
const correction = n => ({status:'correction',preserve:[],rootProblem:'r'+n,previousStrategyFailure:'',newStrategy:'s'+n,nextWorkerInstructions:'Fix '+n,neededEvidence:[],failureReason:''});
const role = (fields) => ({ id:'r1', name:'Reviewer', stage:'before-qa', cli:'claude', instructions:'Check naming.', ...fields });

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-roles-'));
  t.after(() => { useTuning(); return rm(root, { recursive: true, force: true }); });
  const state = new DashboardState({ stateDir: root }); await state.initialize({ task, workspace: root });
  return { root, state };
}
const baseLoop = (root, state, extra) => ({ workspace:root, stateDir:root, initialTask:task, stopAfterTask:true, codex:{activeCount:0},
  baseline:async()=>({head:'base'}), verify:async()=>{}, reconcile:async()=>{}, prepareQa:async input=>packet(input),
  readControl:()=>state.readControl(), onEvent:e=>state.record(e), pollMs:1, ...extra });

test('roles file validation: ids, stages, CLIs; gate only applies before QA; disabled roles dropped', () => {
  const parsed = parseRoles([role({ gate:true }), role({ id:'r2', stage:'after-pass', gate:true }), role({ id:'r3', enabled:false })]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].gate, true);
  assert.equal(parsed[1].gate, false);
  assert.throws(() => parseRoles([role({ stage:'whenever' })]), /stage must be/);
  assert.throws(() => parseRoles([role({ cli:'cline' })]), /cli must be codex or claude/);
  assert.throws(() => parseRoles([role(), role()]), /duplicate id/);
  assert.throws(() => parseRoles([role({ instructions:' ' })]), /instructions are required/);
  assert.throws(() => parseRoleResult('{"verdict":"maybe","summary":"","findings":[],"guidance":""}'), /verdict/);
});

test('role prompt is read-only and carries the user instructions and input', () => {
  const text = buildRolePrompt(parseRoles([role({ gate:true })])[0], { task });
  assert.match(text, /You are Reviewer, a custom workflow role/);
  assert.match(text, /read-only: do not edit/);
  assert.match(text, /Return changes-needed only for concrete/);
  assert.match(text, /Check naming\./);
  assert.match(text, /INPUT: \{"task"/);
  assert.equal(roleGuidanceText([{ name:'A', result:{ guidance:'' } }]), '');
});

test('guidance before implementation reaches every worker prompt; a gate sends work back before QA; reports are written after pass', async t => {
  const { root, state } = await setup(t);
  const roles = parseRoles([
    role({ id:'plan', name:'Planner', stage:'before-implementation' }),
    role({ id:'gate', name:'Gatekeeper', stage:'before-qa', gate:true }),
    role({ id:'notes', name:'Notes', stage:'after-pass' }),
  ]);
  const calls = [], prompts = []; let qaCalls = 0, assessments = 0, gateCalls = 0;
  const runRole = async (r, input) => {
    calls.push(r.id);
    if (r.id === 'plan') return { verdict:'pass', summary:'', findings:[], guidance:'Export x as a named function.' };
    if (r.id === 'gate') return ++gateCalls === 1
      ? { verdict:'changes-needed', summary:'x is unexported', findings:['src/x.js: export x'], guidance:'' }
      : { verdict:'pass', summary:'ok', findings:[], guidance:'' };
    assert.equal(input.commit, 'abc');
    return { verdict:'pass', summary:'Added x.', findings:[], guidance:'' };
  };
  const result = await runNodeLoop(baseLoop(root, state, { roles, runRole,
    worker:{ withExclusive:fn=>fn(), run:async(prompt,hooks)=>{ prompts.push(prompt); assert.equal(hooks.task.id,'W'); await hooks.onStart({pid:1}); return { exitCode:0 }; } },
    review:async input=>{ qaCalls++; assert.equal(input.roleReviews[0].role,'Gatekeeper'); return { status:'pass', output:'verified', commit:'abc' }; },
    assessCorrection:async input=>{ assessments++; assert.match(input.failure.reason, /Gatekeeper requested changes/); return correction(1); },
    elevate:()=>assert.fail('no elevation'),
  }));
  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['plan','gate','gate','notes']);
  assert.equal(qaCalls, 1, 'QA is skipped for the attempt the gate rejected');
  assert.equal(assessments, 1);
  assert.equal(prompts.length, 2);
  for (const p of prompts) assert.match(p, /Planner: Export x as a named function\./);
  const reports = (await readFile(path.join(root, 'role-reports.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(reports[0].role, 'Notes'); assert.equal(reports[0].summary, 'Added x.');
});

test('an advisory role that fails is recorded and skipped; a gate that fails blocks', async t => {
  const { root, state } = await setup(t);
  const run = roles => runNodeLoop(baseLoop(root, state, { roles, runRole:async()=>{ throw new Error('CLI missing'); },
    worker:{ withExclusive:fn=>fn(), run:async()=>({ exitCode:0 }) },
    review:async()=>({ status:'pass', output:'ok', commit:'c' }), assessCorrection:()=>assert.fail(), elevate:()=>assert.fail() }));
  assert.equal((await run(parseRoles([role({ stage:'before-implementation' })]))).status, 'passed');
  const errors = (await state.readLive()).roleResults.filter(r => r.error);
  assert.equal(errors.length, 1);
  const { root: root2, state: state2 } = await setup(t);
  const blocked = await runNodeLoop(baseLoop(root2, state2, { roles:parseRoles([role({ gate:true })]), runRole:async()=>{ throw new Error('CLI missing'); },
    worker:{ withExclusive:fn=>fn(), run:async()=>({ exitCode:0 }) }, review:()=>assert.fail('unreviewed change reached QA'), assessCorrection:()=>assert.fail(), elevate:()=>assert.fail() }));
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.output, /Gatekeeper|Reviewer could not run/);
});

test('Retry QA after changed evidence reruns its second-opinion gate for the same attempt', async t => {
  const { root, state } = await setup(t);
  let gateCalls = 0, qaCalls = 0;
  const options = baseLoop(root, state, {
    roles: parseRoles([role({ id:'second-opinion-qa', name:'Second-opinion QA', gate:true })]),
    runRole: async () => { gateCalls++; return { verdict:'pass', summary:'checked', findings:[], guidance:'' }; },
    worker: { withExclusive:fn=>fn(), run:async()=>({exitCode:0}) },
    prepareQa: async input => ({ ...packet(input), diff:{text:qaCalls===0?'first-content':'fixed-content',bytes:12}, qaEvidence:{ ...packet(input).qaEvidence, scope:{status:'PASS'} } }),
    review: async () => { qaCalls++; return qaCalls <= 2 ? { status:'manual-review', manualReviewCause:'missing-permissions', output:'helper_unknown_error: tool failed before execution' } : {status:'pass',output:'accepted',commit:'abc'}; },
  });
  const first = await runNodeLoop(options);
  assert.equal(first.status,'blocked');
  await state.setControl('retry-qa');
  const resumed = await runNodeLoop({...options,initialTask:null});
  assert.equal(resumed.status,'passed');
  assert.ok(gateCalls >= 2, 'a cached pass for old content must not skip the second opinion');
});

test('tuning: defaults reproduce the fixed engine; flags validate', () => {
  assert.deepEqual(parseTuning({}), DEFAULT_TUNING);
  assert.equal(parseTuning({ 'elevation-after':'5' }).elevationAfter, 5);
  assert.throws(() => parseTuning({ 'elevation-after':'0' }), /at least 1/);
  assert.equal(parseTuning({ 'max-corrections':'0' }).maxCorrections, 0);
  assert.match(taskSizingText(DEFAULT_TUNING), /one file per task where possible.*under about 200 lines/);
  assert.match(taskSizingText({ ...DEFAULT_TUNING, taskMaxFiles:3, taskMaxNewLines:400 }), /at most 3 files per task.*about 400 lines/);
});

test('elevation threshold and correction limit come from tuning', async t => {
  const { root, state } = await setup(t);
  useTuning({ elevationAfter:1 });
  let elevations = 0, qa = 0;
  const result = await runNodeLoop(baseLoop(root, state, {
    worker:{ withExclusive:fn=>fn(), run:async(_p,hooks)=>{ await hooks.onStart({pid:2}); return { exitCode:0 }; } },
    review:async()=>++qa===3 ? { status:'pass', output:'ok', commit:'c' } : { status:'fail', output:'still wrong' },
    assessCorrection:async()=>correction(qa), elevate:async()=>{ elevations++; return { ...correction(9), status:'strategy-revised' }; },
  }));
  assert.equal(result.status, 'passed');
  assert.equal(elevations, 1, 'elevated after one correction instead of three');

  const second = await setup(t);
  useTuning({ maxCorrections:2, elevationAfter:10 });
  let assessments = 0;
  const limited = await runNodeLoop(baseLoop(second.root, second.state, {
    worker:{ withExclusive:fn=>fn(), run:async(_p,hooks)=>{ await hooks.onStart({pid:3}); return { exitCode:0 }; } },
    review:async()=>({ status:'fail', output:'still wrong' }),
    assessCorrection:async()=>correction(++assessments), elevate:()=>assert.fail(),
  }));
  assert.equal(limited.status, 'user-attention');
  assert.equal(assessments, 2);
  const live = await second.state.readLive();
  assert.equal(live.stage, 'USER_ATTENTION');
  assert.match(live.userAttentionReason, /Correction limit reached \(2/);
  assert.equal(TUNING.maxCorrections, 2);
});

test('cloud implementation: Claude tools are scoped to the task with the tool guard; Codex uses the QA sandbox', () => {
  const guarded = claudeImplementationTools({ task, toolGuard:true });
  assert.ok(guarded.allowed.includes('Edit(./src/x.js)'));
  assert.ok(guarded.allowed.includes('Write(./src/x.js)'));
  assert.ok(guarded.allowed.includes('Bash(npm test:*)'));
  assert.ok(!guarded.allowed.includes('Edit'));
  assert.ok(guarded.disallowed.includes('Bash(git commit:*)'));
  const open = claudeImplementationTools({ task, toolGuard:false });
  assert.ok(open.allowed.includes('Bash') && open.allowed.includes('Edit(./src/x.js)'), 'tool guard off opens the shell, not file edits');
  assert.ok(!open.allowed.includes('Edit') && !open.allowed.includes('Write'));
  assert.ok(open.disallowed.includes('Bash(git reset:*)'));
  const codex = buildImplementationArgs({ cli:'codex', model:'gpt-6.1-sol', effort:'high', fast:true, workspace:'/w', outputFile:'/o', task, toolGuard:true });
  assert.deepEqual(codex.slice(0, 2), ['exec', '--ephemeral']);
  assert.ok(codex.includes('--approve-for-me'));
  assert.ok(codex.includes('service_tier="priority"'));
  assert.ok(!codex.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.deepEqual(parseImplementation({}), { cli:'cline', model:null, effort:null, fast:false });
  assert.throws(() => parseImplementation({ 'implementation-cli':'ollama' }), /must be one of/);
});

test('cloud implementation worker returns the final message as its summary and never runs twice at once', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-impl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spawned = [];
  const spawnProcess = (command, args) => {
    const child = new EventEmitter();
    child.pid = 4242; child.exitCode = null;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: (text) => {
      spawned.push({ command, args, text });
      setImmediate(() => { child.stdout.emit('data', JSON.stringify({ type:'result', is_error:false, result:'Implemented x; npm test passed.' }) + '\n'); child.exitCode = 0; child.emit('close', 0); });
    } });
    return child;
  };
  const worker = new CloudImplementationWorker({ cli:'claude', stateDir:root, workspace:root, command:'claude', model:'sonnet', spawnProcess });
  let started = null;
  const result = await worker.withExclusive(async () => {
    assert.equal(await worker.withExclusive(async () => 'second'), null, 'a second implementation waits');
    return worker.run('Add x', { task, onStart: async ({ pid }) => { started = pid; } });
  });
  assert.equal(started, 4242);
  assert.equal(result.exitCode, 0);
  assert.equal(result.runResult.finishReason, 'completed');
  assert.equal(result.runResult.text, 'Implemented x; npm test passed.');
  assert.match(spawned[0].text, /You are the implementation worker[\s\S]*Do not commit[\s\S]*Add x/);
  assert.ok(spawned[0].args.includes('Edit(./src/x.js)'));
});

test('a Claude implementation reports the protection hook refusals in Activity, as Codex does', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-deny-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { readdirSync, writeFileSync } = await import('node:fs');
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.pid = 7; child.exitCode = null;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: () => setImmediate(() => {
      // The real hook appends one line per decision next to the prompt.
      const invocation = path.join(root, 'codex', readdirSync(path.join(root, 'codex'))[0]);
      writeFileSync(path.join(invocation, 'scope-hook.ndjson'), JSON.stringify({ tool:'Read', allowed:false, reason:'Protected-path policy refused this tool call' }) + '\n' + JSON.stringify({ tool:'Edit', allowed:true, reason:null }) + '\n');
      child.stdout.emit('data', JSON.stringify({ type:'result', is_error:false, result:'Done.' }) + '\n'); child.exitCode = 0; child.emit('close', 0);
    }) });
    return child;
  };
  const events = [];
  const worker = new CloudImplementationWorker({ cli:'claude', stateDir:root, workspace:root, command:'claude', model:'haiku', spawnProcess });
  const result = await worker.run('Add x', { task, onEvent: async (e) => events.push(e) });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(events.filter(e => e.type === 'implementation-scope-blocked'), [{ type:'implementation-scope-blocked', tool:'Read', reason:'Protected-path policy refused this tool call' }]);
});

test('Codex implementation runs with the engine-written scope hook and refuses tool use the hook never saw', async t => {
  const { codexScopeHookArgs, codexUsedTools } = await import('../src/cloud-impl-worker.mjs');
  const args = codexScopeHookArgs({ nodePath:'C:\node\node.exe', hookScript:'C:\e\hook.mjs', policyFile:'C:\s\p.json', logFile:'C:\s\l.ndjson' });
  assert.equal(args[0], '--dangerously-bypass-hook-trust');
  assert.match(args[2], /^hooks\.PreToolUse=\[\{matcher="\.\*",hooks=\[\{type="command",command="\\"C:\\node\\node\.exe\\" /);
  assert.equal(codexUsedTools('{"type":"item.completed","item":{"type":"file_change"}}'), true);
  assert.equal(codexUsedTools('{"type":"turn.completed"}'), false);

  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-impl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spawnProcess = (command, argv) => {
    const child = new EventEmitter();
    child.pid = 77; child.exitCode = null; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: () => setImmediate(() => {
      assert.ok(argv.includes('--dangerously-bypass-hook-trust'));
      child.stdout.emit('data', '{"type":"item.completed","item":{"type":"file_change"}}\n');
      child.exitCode = 0; child.emit('close', 0);
    }) });
    return child;
  };
  const worker = new CloudImplementationWorker({ cli:'codex', stateDir:root, workspace:root, command:'codex', spawnProcess });
  await assert.rejects(worker.run('Add x', { task }), /without the scope hook/);
  await assert.rejects(worker.run('Add x', { task:{ ...task, allowedPaths:[] } }), /allowed paths/);
});

test('read-only roles are told their sandbox, not the project, blocks writes', async () => {
  const { CodexWorker, READ_ONLY_SANDBOX } = await import('../src/codex-worker.mjs');
  const worker = Object.create(CodexWorker.prototype), prompts = [];
  worker.invoke = async (prompt) => { prompts.push(prompt); return { status:'done' }; };
  await worker.assess({ objective:'x' });
  await worker.assessCorrection({ task });
  await worker.reassessManualReview({ task });
  await worker.resolveBlocked({ task });
  assert.equal(prompts.length, 4);
  for (const p of prompts) assert.ok(p.includes(READ_ONLY_SANDBOX));
  assert.match(READ_ONLY_SANDBOX, /EPERM[\s\S]*Never treat it as a blocker/);
  assert.ok(buildRolePrompt(parseRoles([role()])[0], {}).includes(READ_ONLY_SANDBOX));
});

test('Retry after a blocked Assessment runs a fresh Assessment instead of replaying the stored verdict', async t => {
  const { root, state } = await setup(t);
  // What a blocked first run leaves behind: the completed Assessment receipt in live.json.
  await state.record({ type:'codex-finished', operationId:'old', codexOperation:{ version:2, operationId:'old', operation:'assessment', status:'completed', inputs:{}, context:{}, result:{ status:'manual-review', task:null, output:'old sandbox verdict', correction:'', commit:'', manualReviewCause:'EPERM' } } });
  assert.equal((await state.readLive()).codexOperation?.status, 'completed');
  const verdicts = [];
  const run = () => runNodeLoop({ workspace:root, stateDir:root, objective:'x', codex:{ activeCount:0 }, baseline:async()=>({ head:'base' }),
    worker:{ withExclusive:fn=>fn(), run:()=>assert.fail('no task') },
    assess:async()=>{ verdicts.push('fresh'); return { status:'manual-review', task:null, output:'fresh verdict '+verdicts.length, correction:'', commit:'', manualReviewCause:null }; },
    readControl:()=>state.readControl(), onEvent:e=>state.record(e), pollMs:1 });
  const first = await run();
  assert.equal(first.status, 'blocked');
  assert.equal(first.output, 'fresh verdict 1', 'the stored verdict was not replayed');
  assert.equal((await state.readLive()).codexOperation ?? null, null, 'the blocked receipt is consumed');
  const second = await run();
  assert.equal(second.output, 'fresh verdict 2', 'every Retry asks Assessment again');
});

test('a fixer makes its own requested fix once per attempt under the guard, and the fix is reviewed again before QA', async t => {
  const { root, state } = await setup(t);
  const roles = parseRoles([role({ id:'fixer', name:'Fixer', gate:true, fix:true }), role({ id:'plain', name:'Plain', stage:'after-pass', gate:true, fix:true })]);
  assert.deepEqual(roles.map(r => r.fix), [true, false], 'only a before-QA gate can fix');
  let gateCalls = 0, workerRuns = 0, qaCalls = 0; const fixPrompts = [];
  const runRole = async (r) => {
    if (r.id === 'plain') return { verdict:'pass', summary:'', findings:[], guidance:'' };
    return ++gateCalls === 1 ? { verdict:'changes-needed', summary:'x is unexported', findings:['src/x.js: export x'], guidance:'' } : { verdict:'pass', summary:'ok', findings:[], guidance:'' };
  };
  const fixWorkers = { fixer:{ run:async (prompt, hooks) => { fixPrompts.push(prompt); assert.equal(hooks.task.id, 'W'); await hooks.onEvent({ type:'implementation-cli-ready', cli:'claude' }); return { exitCode:0 }; } } };
  const result = await runNodeLoop(baseLoop(root, state, { roles, runRole, fixWorkers,
    worker:{ withExclusive:fn=>fn(), run:async(prompt,hooks)=>{ workerRuns++; await hooks.onStart({pid:1}); return { exitCode:0 }; } },
    review:async () => { qaCalls++; return { status:'pass', output:'verified', commit:'abc' }; },
    assessCorrection:()=>assert.fail('the fixer handles it, no correction'), elevate:()=>assert.fail('no elevation'),
  }));
  assert.equal(result.status, 'passed');
  assert.equal(workerRuns, 1, 'the implementation worker is not relaunched');
  assert.equal(fixPrompts.length, 1);
  assert.match(fixPrompts[0], /requested by the workflow role Fixer/);
  assert.match(fixPrompts[0], /src\/x\.js: export x/);
  assert.match(fixPrompts[0], /Change only these approved paths: src\/x\.js/);
  assert.match(fixPrompts[0], /Do not commit/);
  assert.equal(gateCalls, 2, 'the fixed change is reviewed again');
  assert.equal(qaCalls, 1);
  const types = (await readFile(path.join(root, 'activity.ndjson'), 'utf8')).trim().split('\n').map(l => JSON.parse(l).type);
  assert.ok(types.indexOf('role-fix-started') < types.indexOf('role-fix-finished'));
});

test('a fixer gets one try per attempt; a second rejection goes back to correction', async t => {
  const { root, state } = await setup(t);
  const roles = parseRoles([role({ id:'fixer', name:'Fixer', gate:true, fix:true })]);
  let gateCalls = 0, fixes = 0, assessments = 0;
  const runRole = async () => ++gateCalls <= 2 ? { verdict:'changes-needed', summary:'still wrong', findings:['src/x.js: fix'], guidance:'' } : { verdict:'pass', summary:'ok', findings:[], guidance:'' };
  const result = await runNodeLoop(baseLoop(root, state, { roles, runRole,
    fixWorkers:{ fixer:{ run:async () => { fixes++; throw new Error('usage limit'); } } },
    worker:{ withExclusive:fn=>fn(), run:async(prompt,hooks)=>{ await hooks.onStart({pid:1}); return { exitCode:0 }; } },
    review:async () => ({ status:'pass', output:'verified', commit:'abc' }),
    assessCorrection:async input=>{ assessments++; assert.match(input.failure.reason, /Fixer requested changes/); return correction(1); },
    elevate:()=>assert.fail('no elevation'),
  }));
  assert.equal(result.status, 'passed');
  assert.equal(fixes, 1, 'a failed fix is not retried for the same attempt');
  assert.equal(assessments, 1);
});
