import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexWorker } from "../src/codex-worker.mjs";
import { atomicWriteJson } from "../src/dashboard-state.mjs";
import { runNodeLoop } from "../src/node-loop.mjs";

const strictResult = (overrides = {}) => ({ status: "done", task: null, output: "", correction: "", commit: "", manualReviewCause: null, ...overrides });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeCodexProcess({ pid = 8123, onInput, onKill } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const originalEnd = child.stdin.end.bind(child.stdin);
  child.stdin.end = (input) => {
    onInput?.(String(input));
    originalEnd(input);
  };
  child.kill = () => { onKill?.(); queueMicrotask(() => child.emit("close", 1, "SIGTERM")); return true; };
  return child;
}

async function finishSuccessfulInvocation(child, args, value = strictResult()) {
  const outputFile = args[args.indexOf("--output-last-message") + 1];
  await writeFile(outputFile, JSON.stringify(value));
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
}

test("Codex PID persistence is awaited before the prompt is sent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pid-await-"));
  const gate = deferred();
  let inputSent = false;
  let child;
  let args;
  try {
    const codex = new CodexWorker({
      workspace: root,
      stateDir: root,
      spawnProcess: (_command, actualArgs) => { args = actualArgs; return child = fakeCodexProcess({ onInput: () => { inputSent = true; } }); },
      writeProcessState: async (file, value) => { await gate.promise; await atomicWriteJson(file, value); },
    });
    const invocation = codex.invoke("bounded");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inputSent, false);
    gate.resolve();
    while (!inputSent) await new Promise((resolve) => setImmediate(resolve));
    await finishSuccessfulInvocation(child, args);
    assert.equal((await invocation).status, "done");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persisted live Codex state blocks Cline until restart reconciliation confirms exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pid-restart-"));
  let clineRuns = 0;
  try {
    await atomicWriteJson(path.join(root, "codex-process.json"), { pid: 9911, startedAt: new Date().toISOString(), command: "codex.exe" });
    const codex = new CodexWorker({ workspace: root, stateDir: root, isProcessAlive: async () => true });
    const outcome = await runNodeLoop({
      workspace: root,
      stateDir: root,
      initialTask: { id: "pid", name: "PID", prompt: "work", qaCommand: "fake", allowedPaths: ["one.js"] },
      codex,
      worker: { withExclusive: async (fn) => fn(), run: async () => { clineRuns++; return { exitCode: 0 }; } },
      baseline: async () => ({ head: "base" }),
      readControl: async () => ({}),
      onEvent: async () => {},
    });
    assert.equal(outcome.status,"blocked");assert.match(outcome.output,/still alive/);
    assert.equal(clineRuns, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("confirmed Codex exit clears persisted process state safely", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pid-clear-"));
  let cleared = 0;
  try {
    await atomicWriteJson(path.join(root, "codex-process.json"), { pid: 9912, startedAt: new Date().toISOString(), command: "codex.exe" });
    const codex = new CodexWorker({
      workspace: root,
      stateDir: root,
      isProcessAlive: async () => false,
      clearProcessState: async (file) => { cleared++; await rm(file, { force: true }); },
    });
    await codex.assertIdle();
    assert.equal(cleared, 1);
    await assert.rejects(readFile(path.join(root, "codex-process.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("PID registration failure sends no prompt and cannot progress to Cline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pid-fail-"));
  let inputSent = false;
  let killed = false;
  let clineRuns = 0;
  let child;
  try {
    const codex = new CodexWorker({
      workspace: root,
      stateDir: root,
      spawnProcess: () => child = fakeCodexProcess({ onInput: () => { inputSent = true; }, onKill: () => { killed = true; } }),
      writeProcessState: async () => { throw new Error("disk unavailable"); },
    });
    const outcome = await runNodeLoop({
      workspace: root,
      stateDir: root,
      codex,
      assess: (input) => codex.assess(input),
      worker: { withExclusive: async (fn) => fn(), run: async () => { clineRuns++; return { exitCode: 0 }; } },
      baseline: async () => ({ head: "base" }),
      readControl: async () => ({}),
      onEvent: async () => {},
    });
    assert.equal(outcome.status,"blocked");assert.match(outcome.output,/register Codex process.*disk unavailable/i);
    assert.equal(inputSent, false);
    assert.equal(killed, true);
    assert.equal(clineRuns, 0);
  } finally { child?.stdout.destroy(); child?.stderr.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("unresolved persisted Codex liveness blocks workflow progression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pid-unresolved-"));
  try {
    await atomicWriteJson(path.join(root, "codex-process.json"), { pid: 9913, startedAt: new Date().toISOString(), command: "codex.exe" });
    const codex = new CodexWorker({ workspace: root, stateDir: root, isProcessAlive: async () => { throw new Error("permission denied"); } });
    await assert.rejects(codex.assertIdle(), /cannot reconcile.*permission denied/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("close racing registration completion clears PID state exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pid-race-"));
  let child;
  let args;
  let clears = 0;
  try {
    const codex = new CodexWorker({
      workspace: root,
      stateDir: root,
      spawnProcess: (_command, actualArgs) => {
        args = actualArgs;
        child = fakeCodexProcess({ onInput: () => {
          const outputFile = args[args.indexOf("--output-last-message") + 1];
          writeFileSync(outputFile, JSON.stringify(strictResult()));
          child.emit("close", 0, null);
        } });
        return child;
      },
      clearProcessState: async (file) => {
        clears++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await rm(file, { force: true });
      },
    });
    assert.equal((await codex.invoke("bounded")).status, "done");
    assert.equal(clears, 1);
  } finally { child?.stdout.destroy(); child?.stderr.destroy(); await rm(root, { recursive: true, force: true }); }
});
