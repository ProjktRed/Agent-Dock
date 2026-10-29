import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareQaPacket, runDeterministicCommand, qaCategories } from "../src/qa-packet.mjs";

test("validation chains expose executed and short-circuited steps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-chain-"));
  try {
    const result = await runDeterministicCommand("git --version && git definitely-invalid-subcommand && git --version", root);
    assert.equal(result.steps.length, 3);
    assert.equal(result.steps[0].status, "PASS");
    assert.equal(result.steps[1].status, "FAIL");
    assert.equal(result.steps[2].status, "NOT RUN");
    assert.notEqual(result.exitCode, 0);
    assert.deepEqual(qaCategories("npm.cmd test && npm.cmd run typecheck && npm.cmd run lint", { steps: [
      { command: "npm.cmd test", status: "PASS" }, { command: "npm.cmd run typecheck", status: "FAIL" }, { command: "npm.cmd run lint", status: "NOT RUN" },
    ] }), { tests: "PASS", typecheck: "FAIL", lint: "NOT RUN", build: "NOT RUN" });
    assert.deepEqual(qaCategories("npm.cmd test && npm.cmd run typecheck && npm.cmd run lint", { steps: [
      { command: "npm.cmd test", status: "PASS" }, { command: "npm.cmd run typecheck", status: "PASS" }, { command: "npm.cmd run lint", status: "PASS" },
    ] }), { tests: "PASS", typecheck: "PASS", lint: "PASS", build: "NOT RUN" });
    assert.equal(qaCategories('npm.cmd test && echo "ambiguous && input"', { exitCode: 0 }).tests, "INCONCLUSIVE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

function git(workspace, ...args) {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}

test("QA packet contains only bounded review context and deterministic evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-packet-"));
  const stateDir = path.join(root, ".state");
  try {
    git(root, "init");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    await writeFile(path.join(root, "result.txt"), "before\n");
    git(root, "add", "result.txt");
    git(root, "commit", "-m", "baseline");
    const baselineSha = git(root, "rev-parse", "HEAD");
    await writeFile(path.join(root, "result.txt"), "after\n");

    const packet = await prepareQaPacket({
      workspace: root,
      stateDir,
      task: {
        id: "TASK-1",
        name: "Bounded task",
        prompt: "Change result.txt only",
        acceptanceCriteria: ["result.txt contains after"],
        qaCommand: "node --version",
        allowedPaths: ["result.txt"],
      },
      attempt: 2,
      baselineSha,
      workerResult: {
        exitCode: 0,
        output: "SECRET FULL CLINE TRANSCRIPT THAT MUST NOT APPEAR",
        runResult: { type: "run_result", finishReason: "completed", text: "Changed result.txt" },
      },
    });

    assert.deepEqual(Object.keys(packet), [
      "task", "acceptanceCriteria", "baselineSha", "diff", "changedFiles",
      "clineSummary", "attempt", "qaEvidence",
    ]);
    assert.deepEqual(packet.task, { id: "TASK-1", name: "Bounded task", objective: "Change result.txt only", allowedPaths: ["result.txt"] });
    assert.deepEqual(packet.acceptanceCriteria, ["result.txt contains after"]);
    assert.equal(packet.baselineSha, baselineSha);
    assert.deepEqual(packet.changedFiles, ["result.txt"]);
    assert.match(packet.diff.text, /after/);
    assert.equal(packet.clineSummary.text, "Changed result.txt");
    assert.equal(packet.clineSummary.exitCode, 0);
    assert.equal(packet.attempt, 2);
    assert.equal(packet.qaEvidence.command.exitCode, 0);
    assert.match(packet.qaEvidence.command.summary, /^v\d+/);
    assert.equal(packet.qaEvidence.categories.tests, "NOT RUN");
    assert.equal(packet.qaEvidence.categories.typecheck, "NOT RUN");
    assert.equal(packet.qaEvidence.categories.lint, "NOT RUN");
    assert.equal(packet.qaEvidence.categories.build, "NOT RUN");
    assert.equal(packet.qaEvidence.categories.scopeCheck, "PASS");
    assert.doesNotMatch(JSON.stringify(packet), /SECRET FULL CLINE TRANSCRIPT/);

    assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, "qa-packet.json"), "utf8")), packet);
    assert.equal((await readdir(stateDir)).some((name) => name.startsWith("qa-packet.json.")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recognized test command maps only tests and preserves failure evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-packet-fail-"));
  try {
    git(root, "init");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    await writeFile(path.join(root, "result.txt"), "before\n");
    git(root, "add", "result.txt");
    git(root, "commit", "-m", "baseline");
    const packet = await prepareQaPacket({
      workspace: root,
      stateDir: path.join(root, ".state"),
      task: { id: "T", name: "T", prompt: "T", acceptanceCriteria: [], qaCommand: "npm.cmd test -- --fake", allowedPaths: ["result.txt"] },
      attempt: 1,
      baselineSha: git(root, "rev-parse", "HEAD"),
      workerResult: { exitCode: 0, runResult: { finishReason: "completed", text: "done" } },
      runCommand: async () => ({ exitCode: 7, stdout: "", stderr: "assertion failed", durationMs: 19 }),
    });
    assert.equal(packet.qaEvidence.categories.tests, "FAIL");
    assert.equal(packet.qaEvidence.categories.typecheck, "NOT RUN");
    assert.deepEqual(packet.qaEvidence.command, {
      command: "npm.cmd test -- --fake", exitCode: 7, durationMs: 19, summary: "assertion failed", truncated: false,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scope violations are explicit and only approved files enter the scoped diff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-packet-scope-"));
  try {
    git(root, "init");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    await writeFile(path.join(root, "result.txt"), "before\n");
    await writeFile(path.join(root, "outside.txt"), "before\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "baseline");
    await writeFile(path.join(root, "result.txt"), "allowed\n");
    await writeFile(path.join(root, "outside.txt"), "forbidden\n");
    const packet = await prepareQaPacket({
      workspace: root, stateDir: path.join(root, ".state"),
      task: { id: "T", name: "T", prompt: "T", acceptanceCriteria: [], qaCommand: "npm run generic-check", allowedPaths: ["result.txt"] },
      attempt: 1, baselineSha: git(root, "rev-parse", "HEAD"),
      workerResult: { exitCode: 0, runResult: { finishReason: "completed", text: "done" } },
      runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }),
    });
    assert.deepEqual(packet.changedFiles, ["outside.txt", "result.txt"]);
    assert.equal(packet.qaEvidence.categories.scopeCheck, "FAIL");
    assert.deepEqual(packet.qaEvidence.scope.unexpectedPaths, ["outside.txt"]);
    assert.match(packet.diff.text, /result\.txt/);
    assert.doesNotMatch(packet.diff.text, /forbidden/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a scope failure names the first paths and counts the rest', async () => {
  const { listPaths } = await import('../src/qa-packet.mjs');
  const paths = Array.from({ length: 10_000 }, (_, i) => `node_modules/f${i}.js`);
  const text = listPaths(paths);
  assert.ok(text.length < 1_000);
  assert.match(text, /node_modules\/f0\.js, .* and 9980 more$/);
  assert.equal(listPaths(['a', 'b']), 'a, b');
});
