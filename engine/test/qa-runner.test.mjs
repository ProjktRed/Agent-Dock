import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureGitBaseline, runQaCommand } from "../src/qa-runner.mjs";

test("QA passes only when the configured command exits zero", async () => {
  const pass = await runQaCommand({
    task: { qaCommand: "node -e \"console.log('QA PASS')\"" },
    workspace: process.cwd(),
    workerResult: { exitCode: 0, output: "implemented" },
  });
  const fail = await runQaCommand({
    task: { qaCommand: "node -e \"console.error('actual defect'); process.exit(7)\"" },
    workspace: process.cwd(),
    workerResult: { exitCode: 0, output: "implemented" },
  });

  assert.equal(pass.pass, true);
  assert.match(pass.output, /QA PASS/);
  assert.equal(fail.pass, false);
  assert.match(fail.output, /actual defect/);
});

test("a failed Cline process cannot be accepted even if QA would pass", async () => {
  const result = await runQaCommand({
    task: { qaCommand: "node -e \"process.exit(0)\"" },
    workspace: process.cwd(),
    workerResult: { exitCode: 2, output: "model request failed" },
  });

  assert.equal(result.pass, false);
  assert.match(result.output, /model request failed/);
});

test("QA rejects changes outside the Codex-approved paths", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "qa-paths-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "proof.txt"), "CORRECTED\n");
  await writeFile(path.join(workspace, "surprise.txt"), "unexpected\n");

  const result = await runQaCommand({
    task: { qaCommand: "node -e \"process.exit(0)\"", allowedPaths: ["proof.txt"] },
    workspace,
    workerResult: { exitCode: 0, output: "implemented" },
  });

  assert.equal(result.pass, false);
  assert.match(result.output, /surprise\.txt/);
  await rm(workspace, { recursive: true, force: true });
});

test("Codex refuses to start from a dirty baseline", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "qa-baseline-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  await writeFile(path.join(workspace, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "base"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "dirty.txt"), "existing work\n");

  await assert.rejects(() => captureGitBaseline(workspace), /clean git workspace/);
  await rm(workspace, { recursive: true, force: true });
});

test("QA rejects a commit made by Cline", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "qa-head-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  await writeFile(path.join(workspace, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "base"], { cwd: workspace, stdio: "ignore" });
  const baseline = await captureGitBaseline(workspace);
  await writeFile(path.join(workspace, "proof.txt"), "work\n");
  execFileSync("git", ["add", "proof.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "cline commit"], { cwd: workspace, stdio: "ignore" });

  const result = await runQaCommand({
    task: { qaCommand: "node -e \"process.exit(0)\"", allowedPaths: ["proof.txt"] },
    workspace,
    baselineHead: baseline.head,
    workerResult: { exitCode: 0, output: "implemented" },
  });

  assert.equal(result.pass, false);
  assert.match(result.output, /HEAD changed/);
  await rm(workspace, { recursive: true, force: true });
});

test("QA checks both sides of a staged rename", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "qa-rename-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  await writeFile(path.join(workspace, "unapproved.txt"), "base\n");
  execFileSync("git", ["add", "unapproved.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "base"], { cwd: workspace, stdio: "ignore" });
  const baseline = (await captureGitBaseline(workspace)).head;
  execFileSync("git", ["mv", "unapproved.txt", "proof.txt"], { cwd: workspace });

  const result = await runQaCommand({
    task: { qaCommand: "node -e \"process.exit(0)\"", allowedPaths: ["proof.txt"] },
    workspace,
    baselineHead: baseline,
    workerResult: { exitCode: 0, output: "implemented" },
  });

  assert.equal(result.pass, false);
  assert.match(result.output, /unapproved\.txt/);
  await rm(workspace, { recursive: true, force: true });
});

test("QA rechecks paths after the test command runs", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "qa-post-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  await writeFile(path.join(workspace, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "base"], { cwd: workspace, stdio: "ignore" });
  const baseline = (await captureGitBaseline(workspace)).head;

  const result = await runQaCommand({
    task: {
      qaCommand: "node -e \"require('fs').writeFileSync('surprise.txt','x')\"",
      allowedPaths: ["proof.txt"],
    },
    workspace,
    baselineHead: baseline,
    workerResult: { exitCode: 0, output: "implemented" },
  });

  assert.equal(result.pass, false);
  assert.match(result.output, /surprise\.txt/);
  await rm(workspace, { recursive: true, force: true });
});

// Second defensive review (0.39.0): under Windows' default execution policy PowerShell refuses npm.ps1.
test('Windows checks call npm and npx through their .cmd shims',async()=>{
  const {windowsShims}=await import('../src/qa-runner.mjs');
  assert.equal(windowsShims('npm test'),'npm.cmd test');
  assert.equal(windowsShims('npx vitest run; npm run lint'),'npx.cmd vitest run; npm.cmd run lint');
  for(const command of ['npm.cmd test','git status','npmx','my-npm test'])assert.equal(windowsShims(command),command);
});
