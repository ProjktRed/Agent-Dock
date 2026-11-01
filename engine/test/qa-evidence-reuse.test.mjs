import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertQaPacketFresh, prepareQaPacket } from "../src/qa-packet.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "repo"); await mkdir(workspace);
  git(workspace, "init"); git(workspace, "config", "user.name", "Test"); git(workspace, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(workspace, "a.txt"), "before\n");
  await writeFile(path.join(workspace, "input.txt"), "input\n");
  git(workspace, "add", "."); git(workspace, "commit", "-m", "base");
  await writeFile(path.join(workspace, "a.txt"), "after!\n");
  let runs = 0;
  return { workspace, stateDir: path.join(root, "state"), baselineSha: git(workspace, "rev-parse", "HEAD"), attempt: 1,
    task: { id: "T", name: "T", prompt: "Change a", allowedPaths: ["a.txt"], qaCommand: "npm test", acceptanceCriteria: ["works"] },
    workerResult: { exitCode: 0, runResult: { finishReason: "completed", text: "done" } },
    runCommand: async () => { runs++; return { exitCode: 0, stdout: "pass", stderr: "", durationMs: 1 }; }, count: () => runs };
}

test("unchanged successful evidence is reused within the same task attempt", async t => {
  const input = await fixture(t);
  const first = await prepareQaPacket(input);
  const second = await prepareQaPacket({ ...input, previousPacket: first });
  assert.equal(input.count(), 1);
  assert.equal(second.qaEvidence.reused, true);
  assert.equal(second.qaEvidence.command.summary, "pass");
  assert.ok(first.qaEvidence.fingerprint);
});

test("same-length edits, task criteria, command and attempt changes invalidate evidence", async t => {
  const input = await fixture(t);
  let packet = await prepareQaPacket(input);
  await writeFile(path.join(input.workspace, "a.txt"), "other!\n");
  packet = await prepareQaPacket({ ...input, previousPacket: packet });
  assert.equal(input.count(), 2);
  await prepareQaPacket({ ...input, previousPacket: packet, task: { ...input.task, acceptanceCriteria: ["different"] } });
  await prepareQaPacket({ ...input, previousPacket: packet, task: { ...input.task, qaCommand: "npm run build" } });
  await prepareQaPacket({ ...input, previousPacket: packet, attempt: 2 });
  assert.equal(input.count(), 5);
});

test("failed or inconclusive checks are rerun, never promoted by reuse", async t => {
  const input = await fixture(t);
  const failed = await prepareQaPacket({ ...input, runCommand: async () => ({ exitCode: 1, stdout: "failed", stderr: "", durationMs: 1 }) });
  await prepareQaPacket({ ...input, previousPacket: failed });
  assert.equal(input.count(), 1);
  const inconclusive = await prepareQaPacket({ ...input, task: { ...input.task, qaCommand: 'npm test && npm run typecheck' } });
  await prepareQaPacket({ ...input, task: { ...input.task, qaCommand: inconclusive.qaEvidence.command.command }, previousPacket: inconclusive });
  assert.equal(input.count(), 3);
});

test("freshness rejects same-length edits, repository inputs and HEAD changes before QA", async t => {
  const input = await fixture(t);
  const packet = await prepareQaPacket(input);
  await assertQaPacketFresh(input.workspace, packet);
  await writeFile(path.join(input.workspace, "a.txt"), "other!\n");
  await assert.rejects(assertQaPacketFresh(input.workspace, packet), /stale/);
  await writeFile(path.join(input.workspace, "a.txt"), "after!\n");
  await writeFile(path.join(input.workspace, "input.txt"), "other\n");
  await assert.rejects(assertQaPacketFresh(input.workspace, packet), /stale/);
  await writeFile(path.join(input.workspace, "input.txt"), "input\n");
  git(input.workspace, "commit", "--allow-empty", "-m", "new HEAD");
  await assert.rejects(assertQaPacketFresh(input.workspace, packet), /stale/);
});

test("the check command does not run when the scope check already failed", async t => {
  const input = await fixture(t);
  await writeFile(path.join(input.workspace, "outside.js"), "process.exit(0)\n");
  const packet = await prepareQaPacket(input);
  assert.equal(input.count(), 0);
  assert.equal(packet.qaEvidence.scope.status, "FAIL");
  assert.equal(packet.qaEvidence.scopeBeforeCommand, "FAIL");
  assert.equal(packet.qaEvidence.command.exitCode, null);
  assert.match(packet.qaEvidence.command.summary, /Not run: the scope check failed first/);
  assert.equal(packet.qaEvidence.categories.tests, "NOT RUN");
});
