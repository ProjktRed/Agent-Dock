import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { appendAction, actionLogKeyHex, canonical } from "../action-log.mjs";
import { redactText } from "../redact.mjs";

/**
 * Guard plan stage 1: every guard decision the engine acknowledges is in the action log, in the order the
 * engine received it. Each implementation run opens a local endpoint (a named pipe on Windows, a socket in
 * the temp folder elsewhere) and puts its address and a random secret in the run's policy file, which lives
 * in protected state. The hook (its own process per tool call) sends one signed line per decision and waits
 * for "ok"; with no "ok" an allowed call is refused (hook-runner.mjs). The engine assigns the order (the
 * action log's sequence) and checks the signature, the run and that the nonce is new. Entries are signed with
 * the action log's key when the app holds one; without it they are hash-chained only, and the attestation
 * says so.
 *
 * Limit (documented): the hook runs as the same OS user as the agent. Without an attested sandbox a
 * compromised CLI could read the secret and forge or skip records; the log proves what the engine received.
 */
const LINE_LIMIT = 8 * 1024, CONNECTIONS = 32, READ_MS = 5_000;
export const DECISION_FIELDS = ["runId", "nonce", "tool", "kind", "effect", "reason", "inputDigest", "callId", "asked", "class", "agrees", "parseComplete"];

export const recordMac = (secret, record) => createHmac("sha256", Buffer.from(secret, "hex")).update(canonical(record)).digest("hex");
export const inputDigest = (input) => createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");

/** Opens a run's endpoint. close() ends it (and removes the socket file); received lists accepted records. */
export async function openDecisionLog({ stateDir, taskId = null }) {
  const runId = randomBytes(16).toString("hex"), secret = randomBytes(32).toString("hex");
  const address = process.platform === "win32" ? `\\\\.\\pipe\\agent-dock-${randomBytes(12).toString("hex")}` : path.join(os.tmpdir(), `adk-${randomBytes(8).toString("hex")}.sock`);
  const seen = new Set(), received = [];
  let open = 0;
  const server = net.createServer((socket) => {
    if (++open > CONNECTIONS) { socket.destroy(); open--; return; }
    socket.setEncoding("utf8");
    let buffer = "", done = false;
    const timer = setTimeout(() => socket.destroy(), READ_MS);
    socket.on("close", () => { clearTimeout(timer); open--; });
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > LINE_LIMIT) { done = true; socket.destroy(); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      done = true;
      const answer = await accept(buffer.slice(0, end)).then(() => "ok\n", (error) => `refused ${String(error.message).slice(0, 200)}\n`);
      socket.end(answer);
    });
  });
  async function accept(line) {
    const message = JSON.parse(line);
    const record = Object.fromEntries(DECISION_FIELDS.map((k) => [k, message[k] ?? null]));
    const expected = Buffer.from(recordMac(secret, record), "hex"), given = Buffer.from(String(message.mac ?? ""), "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("bad signature");
    if (record.runId !== runId) throw new Error("another run");
    if (typeof record.nonce !== "string" || !/^[0-9a-f]{32}$/.test(record.nonce) || seen.has(record.nonce)) throw new Error("replayed or malformed nonce");
    seen.add(record.nonce);
    const entry = { type: "guard-decision", taskId, ...record, reason: redactText(String(record.reason ?? "").slice(0, 500)) || null };
    // Awaited directly (not the dashboard's best-effort path): "ok" means the entry is in the log.
    await appendAction(stateDir, entry);
    received.push(entry);
  }
  if (process.platform !== "win32") await rm(address, { force: true });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  return {
    runId, address, secret, received, signed: Boolean(actionLogKeyHex()),
    /** What the policy file carries for the hook. */
    policy: () => ({ runId, address, secret }),
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(address, { force: true }).catch(() => {});
    },
  };
}

/** The hook's side: sends one decision and resolves true only on the engine's "ok" (5 s, one retry). */
export async function sendDecision(log, fields, { timeoutMs = READ_MS, attempts = 2 } = {}) {
  const record = Object.fromEntries(DECISION_FIELDS.map((k) => [k, fields[k] ?? null]));
  record.runId = log.runId;
  record.nonce = randomBytes(16).toString("hex");
  const line = `${JSON.stringify({ ...record, mac: recordMac(log.secret, record) })}\n`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ok = await new Promise((resolve) => {
      let reply = "";
      const socket = net.connect(log.address);
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(line));
      socket.on("data", (chunk) => { reply += chunk; });
      socket.on("end", () => { clearTimeout(timer); resolve(reply.startsWith("ok")); });
      socket.on("error", () => { clearTimeout(timer); resolve(false); });
    });
    if (ok) return true;
  }
  return false;
}

/**
 * Tool calls the CLI's own output shows, for the end-of-run cross-check: Claude Code's stream-json tool_use
 * blocks (with their ids) and Codex --json items that run something (commands, patches, MCP calls). Bounded:
 * at most 100,000 lines, each parsed only if it looks like JSON.
 */
export function streamToolCalls(stdout) {
  const ids = new Set();
  const codex = { command_execution: 0, file_change: 0, mcp_tool_call: 0 };
  for (const line of String(stdout).split("\n").slice(0, 100_000)) {
    if (!line.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const block of event?.message?.content ?? []) if (block?.type === "tool_use" && typeof block.id === "string") ids.add(block.id);
    const item = event?.item;
    if (event?.type === "item.started" && Object.hasOwn(codex, item?.type)) codex[item.type]++;
  }
  return { ids: [...ids], codex };
}

/**
 * Compares the stream with what was received. Claude: tool_use ids with no record. Codex (no shared ids):
 * per kind of call, fewer records than calls (commands, file changes, MCP calls; records of other tools such
 * as update_plan never make up for a missing one). Returns null when they agree, else a short note.
 */
export function crossCheck({ cli, stdout, received }) {
  const calls = streamToolCalls(stdout);
  if (cli === "claude") {
    const recorded = new Set(received.map((r) => r.callId).filter(Boolean));
    const missing = calls.ids.filter((id) => !recorded.has(id));
    return missing.length ? { missing: missing.length, calls: calls.ids.length, records: received.length } : null;
  }
  // Only allowed calls start an item in Codex's output; a refused one must not stand in for a missing record.
  const allowed = received.filter((r) => r.effect === "allow");
  const recorded = {
    command_execution: allowed.filter((r) => r.kind === "command").length,
    file_change: allowed.filter((r) => r.kind === "edit").length,
    mcp_tool_call: allowed.filter((r) => String(r.tool ?? "").startsWith("mcp__")).length,
  };
  const missing = Object.keys(calls.codex).reduce((sum, type) => sum + Math.max(0, calls.codex[type] - recorded[type]), 0);
  const total = Object.values(calls.codex).reduce((a, b) => a + b, 0);
  return missing ? { missing, calls: total, records: received.length } : null;
}
