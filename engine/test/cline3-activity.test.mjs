import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { collectClineProcess, normalizeClineEvent } from "../src/cline-cli-worker.mjs";

// Shapes emitted by Cline CLI 3.x (@cline/core translateToolStarted / translateToolFinished).
const tool = (toolName, input, type = "content_start", extra = {}) => ({ type: "agent_event", event: { type, contentType: "tool", toolName, toolCallId: "t1", input, ...extra } });

function fakeProcess(lines) {
  const child = new EventEmitter();
  child.pid = 7400;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  queueMicrotask(() => {
    for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
}

test("Cline 3 tools become file, command and search activity", () => {
  assert.deepEqual(normalizeClineEvent(tool("read_files", { files: [{ path: "src/a.ts", start_line: 1 }, { path: "src/b.ts" }, { path: "src/c.ts" }] })),
    { type: "cline-file-read", path: "src/a.ts", paths: ["src/a.ts", "src/b.ts", "src/c.ts"], action: "Reading src/a.ts, src/b.ts (+1)" });
  assert.deepEqual(normalizeClineEvent(tool("editor", { path: "src/App.tsx", old_text: "a", new_text: "b" })), { type: "cline-file-modified", path: "src/App.tsx", action: "Editing src/App.tsx" });
  assert.equal(normalizeClineEvent(tool("editor", { command: "view", path: "src/App.tsx" })).type, "cline-file-read");
  assert.deepEqual(normalizeClineEvent(tool("run_commands", { commands: ["npm run build", "npm test"] })), { type: "cline-command", commands: ["npm run build", "npm test"], action: "Running npm run build, npm test" });
  assert.equal(normalizeClineEvent(tool("search_codebase", { queries: ["characterCapabilitiesIpc"] })).action, "Searching for characterCapabilitiesIpc");
  assert.equal(normalizeClineEvent(tool("fetch_web_content", { url: "x" })).action, "Using fetch_web_content");
  assert.equal(normalizeClineEvent(tool("editor", {}, "content_end", { output: "ok" })), null, "a successful tool end adds nothing");
  assert.deepEqual(normalizeClineEvent(tool("editor", {}, "content_end", { error: "old_text not found" })), { type: "cline-tool-failed", tool: "editor", message: "old_text not found", action: "editor failed: old_text not found" });
});

test("a stretch of reasoning is one Thinking entry, and actions follow it", async () => {
  const events = [];
  const reasoning = { type: "agent_event", event: { type: "content_start", contentType: "reasoning", reasoning: "hmm" } };
  await collectClineProcess("cline", [], {
    spawnProcess: () => fakeProcess([reasoning, reasoning, reasoning, tool("read_files", { files: [{ path: "a.ts" }] }), reasoning, tool("run_commands", { commands: ["npm test"] }), { type: "run_result", finishReason: "completed", text: "done" }]),
    onEvent: (e) => events.push(e),
    diagnostic: () => {},
  });
  assert.deepEqual(events.map((e) => e.type), ["cline-thinking", "cline-file-read", "cline-thinking", "cline-command"]);
});

test("compaction notices become cline-compaction events instead of worker messages", async () => {
  const events = [];
  const say = (text) => ({ type: "agent_event", event: { type: "content_end", contentType: "text", text } });
  await collectClineProcess("cline", [], {
    spawnProcess: () => fakeProcess([say("auto-compacting"), say("auto-compacted"), say("auto-compaction-skipped"), say("Editing App.tsx now"), { type: "run_result", finishReason: "completed", text: "done" }]),
    onEvent: (e) => events.push(e),
    diagnostic: () => {},
  });
  assert.deepEqual(events.map((e) => e.type === "cline-compaction" ? `compaction:${e.phase}` : e.type), ["compaction:started", "compaction:completed", "compaction:skipped", "cline-message"]);
});

test("the Cline worker samples local token usage while it runs; the final sample follows", async () => {
  const { ClineCliWorker } = await import("../src/cline-cli-worker.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "cline-metrics-"));
  let calls = 0;
  const readMetrics = async () => { calls++; return { promptTokens: calls * 1000, generatedTokens: calls * 10, promptSeconds: calls, generationSeconds: calls }; };
  const events = [];
  const worker = new ClineCliWorker({ stateDir: dir, workspace: dir, readMetrics, metricsIntervalMs: 20, checkExternalBusy: async () => false,
    launch: async () => { await new Promise((r) => setTimeout(r, 90)); return { exitCode: 0, runResult: { finishReason: "completed" } }; } });
  await worker.run("x", { onEvent: (e) => events.push(e) });
  await rm(dir, { recursive: true, force: true });
  const samples = events.filter((e) => e.type === "cline-provider-metrics");
  assert.ok(samples.length >= 3, `expected partial samples plus a final one, got ${samples.length}`);
  assert.ok(samples.slice(0, -1).every((e) => e.partial === true));
  assert.equal(samples.at(-1).partial, undefined);
  assert.ok(new Set(samples.map((e) => e.runStartedAt)).size === 1, "one attempt id");
  assert.ok(samples.at(-1).promptTokens >= samples.at(-2).promptTokens);
});
