import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDecisionLog, sendDecision, recordMac, crossCheck, DECISION_FIELDS } from "../src/guard/decision-log.mjs";
import { useActionLogKey } from "../src/action-log.mjs";
import { runHook } from "../src/guard/hook-runner.mjs";
import claude from "../src/guard/adapters/claude.mjs";
import { protectedPathsFor } from "../src/guard/protected-paths.mjs";

const temp = () => mkdtempSync(path.join(os.tmpdir(), "decision-log-"));
const entries = (stateDir) => readFileSync(path.join(stateDir, "action-log.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
/** Sends a raw line and returns the engine's answer. */
const raw = (address, line) => new Promise((resolve) => {
  let reply = "";
  const socket = net.connect(address, () => socket.write(line));
  socket.setEncoding("utf8");
  socket.on("data", (c) => { reply += c; });
  socket.on("end", () => resolve(reply));
  socket.on("error", () => resolve("error"));
});

test("a decision the hook sends is signed into the action log, in the engine's order", async (t) => {
  useActionLogKey("ab".repeat(32));
  t.after(() => useActionLogKey(null));
  const stateDir = temp(), log = await openDecisionLog({ stateDir, taskId: "T1" });
  t.after(() => log.close());
  assert.equal(log.signed, true);
  assert.equal(await sendDecision(log.policy(), { tool: "Bash", kind: "command", effect: "allow", reason: null, inputDigest: "d", callId: "toolu_1" }), true);
  assert.equal(await sendDecision(log.policy(), { tool: "Bash", kind: "command", effect: "stop", reason: "token=abc123def456ghi refused" }), true);
  const [first, second] = entries(stateDir);
  assert.equal(first.type, "guard-decision");
  assert.equal(first.taskId, "T1");
  assert.equal(first.callId, "toolu_1");
  assert.ok(first.mac, "signed with the action log key");
  assert.ok(second.seq > first.seq);
  assert.doesNotMatch(second.reason, /abc123def456ghi/, "the engine redacts the reason");
  assert.equal(log.received.length, 2);
});

test("a forged signature, another run's record or a replayed nonce is refused", async (t) => {
  const stateDir = temp(), log = await openDecisionLog({ stateDir });
  t.after(() => log.close());
  const record = Object.fromEntries(DECISION_FIELDS.map((k) => [k, null]));
  Object.assign(record, { runId: log.runId, nonce: "a".repeat(32), tool: "Bash", effect: "allow" });
  assert.match(await raw(log.address, `${JSON.stringify({ ...record, mac: "00".repeat(32) })}\n`), /refused bad signature/);
  const other = { ...record, runId: "f".repeat(32) };
  assert.match(await raw(log.address, `${JSON.stringify({ ...other, mac: recordMac(log.secret, other) })}\n`), /refused another run/);
  const good = `${JSON.stringify({ ...record, mac: recordMac(log.secret, record) })}\n`;
  assert.match(await raw(log.address, good), /^ok/);
  assert.match(await raw(log.address, good), /refused replayed/);
  assert.match(await raw(log.address, "x".repeat(9000)), /^$|error/, "an oversized line is cut off");
  assert.equal(log.received.length, 1);
});

test("with no engine to record it, an allowed call is refused (and a refusal stays one)", async () => {
  const stateDir = temp(), log = await openDecisionLog({ stateDir });
  await log.close();
  assert.equal(await sendDecision(log.policy(), { tool: "Bash", effect: "allow" }, { timeoutMs: 300 }), false);
  const workspace = temp(), policyPath = path.join(stateDir, "policy.json"), logPath = path.join(stateDir, "hook.ndjson");
  writeFileSync(policyPath, JSON.stringify({ workspace, protectedPaths: protectedPathsFor({ workspace, stateDir }), allowedPaths: [], protectionOnly: true, decisionLog: log.policy() }));
  const result = await runHook(claude, { policyPath, logPath, input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: path.join(workspace, "a.txt") }, cwd: workspace, tool_use_id: "toolu_9" }) });
  assert.match(result.stdout, /could not record this decision/);
});

test("with the engine listening, the hook's call goes through and carries its call id", async (t) => {
  const stateDir = temp(), log = await openDecisionLog({ stateDir });
  t.after(() => log.close());
  const workspace = temp(), policyPath = path.join(stateDir, "policy.json"), logPath = path.join(stateDir, "hook.ndjson");
  writeFileSync(policyPath, JSON.stringify({ workspace, protectedPaths: protectedPathsFor({ workspace, stateDir }), allowedPaths: [], protectionOnly: true, decisionLog: log.policy() }));
  const result = await runHook(claude, { policyPath, logPath, input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: path.join(workspace, "a.txt") }, cwd: workspace, tool_use_id: "toolu_9" }) });
  assert.equal(result.stdout.trim(), "{}");
  assert.deepEqual(log.received.map((r) => [r.callId, r.effect]), [["toolu_9", "allow"]]);
});

test("the cross-check names tool calls the CLI reported that the guard never recorded", () => {
  const claudeOut = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }, { type: "text", text: "x" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_2", name: "Read" }] } }),
  ].join("\n");
  assert.equal(crossCheck({ cli: "claude", stdout: claudeOut, received: [{ callId: "toolu_1" }, { callId: "toolu_2" }] }), null);
  assert.deepEqual(crossCheck({ cli: "claude", stdout: claudeOut, received: [{ callId: "toolu_1" }] }), { missing: 1, calls: 2, records: 1 });
  const codexOut = [
    JSON.stringify({ type: "item.started", item: { type: "command_execution" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution" } }),
    JSON.stringify({ type: "item.started", item: { type: "file_change" } }),
  ].join("\n");
  assert.equal(crossCheck({ cli: "codex", stdout: codexOut, received: [{ kind: "command", effect: "allow" }, { kind: "edit", effect: "allow" }] }), null);
  assert.deepEqual(crossCheck({ cli: "codex", stdout: codexOut, received: [{ kind: "edit", effect: "allow" }] }), { missing: 1, calls: 2, records: 1 });
  // A refused command starts no item, so it does not count for one that ran unrecorded.
  assert.deepEqual(crossCheck({ cli: "codex", stdout: codexOut, received: [{ kind: "command", effect: "stop" }, { kind: "edit", effect: "allow" }] }), { missing: 1, calls: 2, records: 2 });
  // A record of another tool (update_plan) never stands in for a missing command record.
  assert.deepEqual(crossCheck({ cli: "codex", stdout: codexOut, received: [{ kind: "inspect", tool: "update_plan", effect: "allow" }, { kind: "edit", effect: "allow" }] }), { missing: 1, calls: 2, records: 2 });
});
