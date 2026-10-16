import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexWorker, CodexUsageLimitError, roleOptions } from "../src/codex-worker.mjs";
import { RoleRoutedOrchestrator } from "../src/mixed-orchestrator.mjs";
import { parseLoopOptions } from "../src/loop-options.mjs";
import { runRecoverableCodex } from "../src/node-loop.mjs";

const limit = () => new CodexUsageLimitError({ message: "usage limit", retryAt: "later" });
const worker = result => ({ activeCount: 0, assertIdle: async () => {}, assess: result, review: result, assessCorrection: result, reassessManualReview: result, resolveBlocked: result });

test("backup flags parse independently and Resolver inherits the Assessment backup", () => {
  const options = parseLoopOptions(["--assessment-backup-cli", "claude", "--assessment-backup-model", "opus", "--assessment-backup-effort", "high", "--assessment-backup-fast", "false"]);
  assert.deepEqual(options.roleBackups, { assessment: { cli: "claude", model: "opus", effort: "high", fast: false }, resolver: { cli: "claude", model: "opus", effort: "high", fast: false } });
  for (const args of [["--qa-backup-cli", "cline"], ["--qa-backup-cli", "codex"], ["--qa-backup-model", "opus"], ["--qa-backup-cli", "claude", "--qa-backup-fast", "yes"], ["--qa-backup-cli", "claude", "--qa-backup-effort", "turbo"]]) {
    assert.throws(() => parseLoopOptions(args), /backup/);
  }
});

test("each routed operation retries only a usage limit, once, with identical inputs", async () => {
  const input = { objective: "x", previous: null }, context = { task: "T" };
  for (const [method, role] of [["assess", "assessment"], ["assessCorrection", "assessment"], ["review", "qa"], ["reassessManualReview", "elevate"], ["resolveBlocked", "resolver"]]) {
    const events = [], calls = [];
    const primary = worker(async (...args) => { calls.push(["primary", args]); throw limit(); });
    const backup = worker(async (...args) => { calls.push(["backup", args]); return { status: "done" }; });
    const routed = new RoleRoutedOrchestrator({ [role]: primary }, { backups: { [role]: backup }, clis: { [role]: "codex" }, backupConfigs: { [role]: { cli: "claude", model: "sonnet" } }, onEvent: async e => events.push(e) });
    assert.deepEqual(await routed[method](input, context), { status: "done" });
    assert.deepEqual(calls, [["primary", [input, context]], ["backup", [input, context]]]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "orchestrator-fallback");
    assert.equal(events[0].role, role);
    assert.equal(events[0].model, "sonnet");
  }
});

test("ordinary errors never trigger backups and exhausted backups surface the final limit", async () => {
  const ordinary = new Error("invalid JSON"), exhausted = limit();
  let backupCalls = 0;
  const backup = worker(async () => { backupCalls++; throw exhausted; });
  const primary = worker(async () => { throw ordinary; });
  const router = new RoleRoutedOrchestrator({ qa: primary }, { backups: { qa: backup } });
  await assert.rejects(router.review({}), error => error === ordinary);
  assert.equal(backupCalls, 0);
  primary.review = async () => { throw limit(); };
  await assert.rejects(router.review({}), error => error === exhausted);
  assert.equal(backupCalls, 1);
  backup.activeCount = 1;
  assert.equal(router.activeCount, 1);
});

test("backup worker uses local model/effort/speed without changing primary role defaults", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "backup-options-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = roleOptions("qa");
  const backup = new CodexWorker({ workspace: dir, stateDir: dir, roleOverrides: { qa: { model: "gpt-backup", effort: "high", fast: true } } });
  let options;
  backup.invoke = async (_prompt, _sandbox, opts) => { options = opts; return { status: "pass" }; };
  await backup.review({});
  assert.equal(options.model, "gpt-backup");
  assert.equal(options.reasoningEffort, "high");
  assert.equal(options.fast, true);
  assert.deepEqual(roleOptions("qa"), before);
});

test("both CLIs exhausted wait and Resume retries only the saved operation", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "backup-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let generation = 0, primaryCalls = 0, backupCalls = 0;
  const input = { task: { id: "T" }, attempt: 1 };
  const primary = worker(async () => { primaryCalls++; throw limit(); });
  const backup = worker(async actual => { backupCalls++; assert.deepEqual(actual, input); if (backupCalls === 1) throw limit(); return { status: "pass" }; });
  const router = new RoleRoutedOrchestrator({ qa: primary }, { backups: { qa: backup } });
  const operation = await runRecoverableCodex({ stateDir: dir, operation: "qa", inputs: input, invoke: value => router.review(value), readControl: async () => ({ resumeGeneration: generation }), pollMs: 1,
    emit: async type => { if (type === "waiting-for-codex") { assert.ok(generation < 1, "resume must reach the backup result"); generation++; } } });
  assert.equal(operation.result.status, "pass");
  assert.equal(primaryCalls, 2);
  assert.equal(backupCalls, 2);
});
