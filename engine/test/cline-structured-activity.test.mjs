import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { collectClineProcess } from "../src/cline-cli-worker.mjs";
import { DashboardState } from "../src/dashboard-state.mjs";
import { dashboardView } from "../ui/view-model.js";

function fakeProcess(lines) {
  const child = new EventEmitter();
  child.pid = 7312;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  queueMicrotask(() => {
    for (const line of lines) child.stdout.write(`${line}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
}

function timedFakeProcess(steps) {
  const child = new EventEmitter();
  child.pid = 7313;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  queueMicrotask(async () => {
    for (const { line, waitMs = 0 } of steps) {
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      child.stdout.write(`${line}\n`);
    }
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
}

const agentEvent = (event) => JSON.stringify({ type: "agent_event", event });
const toolEvent = (tool) => agentEvent({ type: "say", say: "tool", text: JSON.stringify(tool) });
const final = JSON.stringify({ type: "run_result", finishReason: "completed", text: "done" });

test("real-style structured command and file events reach dashboard state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cline-events-"));
  const state = new DashboardState({ stateDir: root });
  await state.initialize({ task: { id: "events", name: "Events", prompt: "work" }, workspace: root, maxAttempts: 2 });
  try {
    await collectClineProcess("fake", [], {
      spawnProcess: () => fakeProcess([
        toolEvent({ tool: "execute_command", command: "npm.cmd test" }),
        toolEvent({ tool: "read_file", path: "src/read.js" }),
        toolEvent({ tool: "write_to_file", path: "src/write.js" }),
        toolEvent({ tool: "search_files", path: "src", regex: "needle" }),
        agentEvent({ type: "say", say: "text", text: "Applying the focused fix" }),
        final,
      ]),
      onEvent: (event) => state.record({ ...event, attempt: 1 }),
    });

    const events = await state.readEvents(20);
    assert.ok(events.some((event) => event.type === "cline-command" && event.commands?.[0] === "npm.cmd test"));
    assert.ok(events.some((event) => event.type === "cline-file-read" && event.path === "src/read.js"));
    assert.ok(events.some((event) => event.type === "cline-file-modified" && event.path === "src/write.js"));
    assert.ok(events.some((event) => event.type === "cline-search" && event.path === "src" && event.query === "needle"));
    assert.ok(events.some((event) => event.type === "cline-message" && event.message === "Applying the focused fix"));

    const live = await state.readLive();
    const view = dashboardView({ ...live, events });
    assert.equal(view.activity.currentAction, "Applying the focused fix");
    assert.equal(view.activity.lastCommand, "npm.cmd test");
    assert.equal(view.activity.lastFileRead, "src/read.js");
    assert.equal(view.activity.lastFileModified, "src/write.js");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recent Cline event view stays bounded and does not persist raw transcript fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cline-events-bounded-"));
  const state = new DashboardState({ stateDir: root });
  await state.initialize({ task: { id: "events", name: "Events", prompt: "work" }, workspace: root, maxAttempts: 2 });
  try {
    const lines = Array.from({ length: 70 }, (_, index) => agentEvent({ type: "say", say: "text", text: `Progress ${index}`, rawTranscript: "must not persist" }));
    lines.push(final);
    await collectClineProcess("fake", [], {
      spawnProcess: () => fakeProcess(lines),
      onEvent: (event) => state.record({ ...event, attempt: 1 }),
    });
    const recent = await state.readEvents();
    assert.equal(recent.length, 50);
    assert.equal(recent.at(-1).message, "Progress 69");
    assert.equal(JSON.stringify(recent).includes("rawTranscript"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed and unknown Cline events are ignored without breaking completion", async () => {
  const events = [];
  const completed = await collectClineProcess("fake", [], {
    spawnProcess: () => fakeProcess([
      "{not-json",
      JSON.stringify({ type: "agent_event", event: { type: "unknown", secret: "ignored" } }),
      final,
    ]),
    onEvent: (event) => events.push(event),
  });
  assert.equal(completed.exitCode, 0);
  assert.deepEqual(events, []);
});

test("documented agent_event text is forwarded even when its subtype is new", async () => {
  const events = [];
  await collectClineProcess("fake", [], {
    spawnProcess: () => fakeProcess([
      agentEvent({ type: "assistant_update", text: "Checking the focused lifecycle boundary" }),
      final,
    ]),
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events, [{
    type: "cline-message",
    message: "Checking the focused lifecycle boundary",
    action: "Checking the focused lifecycle boundary",
  }]);
});

test("assistant_update token deltas coalesce in arrival order and final text is not duplicated", async () => {
  const events = [];
  await collectClineProcess("fake", [], {
    spawnProcess: () => fakeProcess([
      agentEvent({ type: "assistant_update", text: "Let me " }),
      agentEvent({ type: "assistant_update", text: "read " }),
      agentEvent({ type: "assistant_update", text: "the file" }),
      agentEvent({ type: "say", say: "text", text: "Let me read the file" }),
      final,
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(events.filter((event) => event.type === "cline-message"), [{
    type: "cline-message", message: "Let me read the file", action: "Let me read the file",
  }]);
  const newestFirst = events.slice().reverse();
  assert.equal(newestFirst[0].message, "Let me read the file");
});

test("delta punctuation and whitespace are preserved exactly", async () => {
  const events = [];
  await collectClineProcess("fake", [], {
    spawnProcess: () => fakeProcess([
      agentEvent({ type: "assistant_update", text: "Hello" }),
      agentEvent({ type: "assistant_update", text: "," }),
      agentEvent({ type: "assistant_update", text: " world" }),
      agentEvent({ type: "assistant_update", text: "!" }),
      final,
    ]),
    onEvent: (event) => events.push(event),
  });
  assert.equal(events.at(-1).message, "Hello, world!");
});

test("structured events create message boundaries without reversing multiple messages", async () => {
  const events = [];
  await collectClineProcess("fake", [], {
    spawnProcess: () => fakeProcess([
      agentEvent({ type: "assistant_update", text: "Older " }),
      agentEvent({ type: "assistant_update", text: "message" }),
      toolEvent({ tool: "execute_command", command: "npm.cmd test" }),
      agentEvent({ type: "assistant_update", text: "Newer " }),
      agentEvent({ type: "assistant_update", text: "message" }),
      final,
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(events.map((event) => [event.type, event.message ?? event.commands?.[0]]), [
    ["cline-message", "Older message"],
    ["cline-command", "npm.cmd test"],
    ["cline-message", "Newer message"],
  ]);
  assert.deepEqual(events.slice().reverse().filter((event) => event.type === "cline-message").map((event) => event.message), [
    "Newer message", "Older message",
  ]);
});

test("inactivity while Cline is active does not emit a partial message", async () => {
  const events = [];
  const pending = collectClineProcess("fake", [], {
    spawnProcess: () => timedFakeProcess([
      { line: agentEvent({ type: "assistant_update", text: "Still " }) },
      { line: agentEvent({ type: "assistant_update", text: "working" }) },
      { line: final, waitMs: 40 },
    ]),
    onEvent: (event) => events.push(event),
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(events, []);
  await pending;
  assert.deepEqual(events.filter((event) => event.type === "cline-message").map((event) => event.message), ["Still working"]);
});

test("Latest Message uses coalesced text and malformed delta fragments remain harmless", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cline-events-latest-"));
  const state = new DashboardState({ stateDir: root });
  await state.initialize({ task: { id: "events", name: "Events", prompt: "work" }, workspace: root, maxAttempts: 2 });
  try {
    await collectClineProcess("fake", [], {
      spawnProcess: () => fakeProcess([
        agentEvent({ type: "assistant_update", text: "Full " }),
        agentEvent({ type: "assistant_update", text: 42 }),
        JSON.stringify({ type: "agent_event", event: null }),
        agentEvent({ type: "assistant_update", text: "message" }),
        final,
      ]),
      onEvent: (event) => state.record({ ...event, attempt: 1 }),
    });
    const events = await state.readEvents();
    const view = dashboardView({ ...(await state.readLive()), events });
    assert.equal(view.activity.latestMessage, "Full message");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actual Cline content_start text fragments emit one message at content_end", async () => {
  const events = [];
  const lines = [
    { type: "content_start", contentType: "text", text: "Let", accumulated: "Let" },
    { type: "content_start", contentType: "text", text: " me", accumulated: "Let me" },
    { type: "content_start", contentType: "text", text: " try", accumulated: "Let me try" },
    { type: "content_start", contentType: "text", text: " a", accumulated: "Let me try a" },
    { type: "content_start", contentType: "text", text: " simpler", accumulated: "Let me try a simpler" },
    { type: "usage", inputTokens: 1, outputTokens: 5 },
    { type: "content_end", contentType: "text", text: "Let me try a simpler" },
  ];
  await collectClineProcess("fake", [], {
    spawnProcess: () => fakeProcess([...lines.map(agentEvent), final]),
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events.filter((event) => event.type === "cline-message").map((event) => event.message), ["Let me try a simpler"]);
});

test("actual Cline text survives inactivity and separate messages retain arrival order around tools", async () => {
  const events = [];
  await collectClineProcess("fake", [], {
    spawnProcess: () => timedFakeProcess([
      { line: agentEvent({ type: "content_start", contentType: "text", text: "Older", accumulated: "Older" }) },
      { line: agentEvent({ type: "content_start", contentType: "text", text: " message", accumulated: "Older message" }), waitMs: 15 },
      { line: agentEvent({ type: "content_end", contentType: "text", text: "Older message" }) },
      { line: toolEvent({ tool: "read_file", path: "src/file.js" }) },
      { line: agentEvent({ type: "content_start", contentType: "text", text: "Newer", accumulated: "Newer" }) },
      { line: agentEvent({ type: "content_end", contentType: "text", text: "Newer message" }) },
      { line: final },
    ]),
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events.map((event) => [event.type, event.message ?? event.path]), [
    ["cline-message", "Older message"],
    ["cline-file-read", "src/file.js"],
    ["cline-message", "Newer message"],
  ]);
  assert.deepEqual(events.slice().reverse().filter((event) => event.type === "cline-message").map((event) => event.message), ["Newer message", "Older message"]);
});

test("actual Cline final text reaches Latest Message once through dashboard state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cline-content-start-"));
  const state = new DashboardState({ stateDir: root });
  await state.initialize({ task: { id: "events", name: "Events", prompt: "work" }, workspace: root, maxAttempts: 2 });
  try {
    await collectClineProcess("fake", [], {
      spawnProcess: () => fakeProcess([
        agentEvent({ type: "content_start", contentType: "text", text: "Full", accumulated: "Full" }),
        agentEvent({ type: "content_start", contentType: "text", text: " sentence.", accumulated: "Full sentence." }),
        agentEvent({ type: "content_end", contentType: "text", text: "Full sentence." }),
        final,
      ]),
      onEvent: (event) => state.record({ ...event, attempt: 1 }),
    });
    const events = await state.readEvents();
    const view = dashboardView({ ...(await state.readLive()), events });
    assert.equal(events.filter((event) => event.type === "cline-message").length, 1);
    assert.equal(view.activity.latestMessage, "Full sentence.");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actual Cline accumulated text preserves repeated fragments", async () => {
  const events = [];
  await collectClineProcess("fake", [], {
    spawnProcess: () => fakeProcess([
      agentEvent({ type: "content_start", contentType: "text", text: "ha", accumulated: "ha" }),
      agentEvent({ type: "content_start", contentType: "text", text: "ha", accumulated: "haha" }),
      agentEvent({ type: "content_end", contentType: "text", text: "haha" }),
      final,
    ]),
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events.filter((event) => event.type === "cline-message").map((event) => event.message), ["haha"]);
});

test("old persisted fragments remain historical and do not change new message coalescing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cline-old-events-"));
  const state = new DashboardState({ stateDir: root });
  await state.initialize({ task: { id: "events", name: "Events", prompt: "work" }, workspace: root, maxAttempts: 2 });
  try {
    await state.appendEvent({ type: "cline-message", message: "Old" });
    await state.appendEvent({ type: "cline-message", message: "fragment" });
    await collectClineProcess("fake", [], {
      spawnProcess: () => fakeProcess([
        agentEvent({ type: "content_start", contentType: "text", text: "New", accumulated: "New" }),
        agentEvent({ type: "content_start", contentType: "text", text: " sentence", accumulated: "New sentence" }),
        agentEvent({ type: "content_end", contentType: "text", text: "New sentence" }),
        final,
      ]),
      onEvent: (event) => state.record(event),
    });
    const events = await state.readEvents();
    assert.deepEqual(events.filter((event) => event.type === "cline-message").map((event) => event.message), ["Old", "fragment", "New sentence"]);
    assert.equal(dashboardView({ ...(await state.readLive()), events }).activity.latestMessage, "New sentence");
  } finally { await rm(root, { recursive: true, force: true }); }
});
