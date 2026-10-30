import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { typedAction, TOOL_CLASSES, TOOL_REGISTRY } from "../src/guard/typed-action.mjs";
import { collectCorpus } from "../src/guard/corpus.mjs";
import { getAdapter } from "../src/guard/registry.mjs";
import { decide } from "../src/guard/decide.mjs";
import { protectedPathsFor } from "../src/guard/protected-paths.mjs";
import { runHook } from "../src/guard/hook-runner.mjs";
import claude from "../src/guard/adapters/claude.mjs";

const corpusFile = fileURLToPath(new URL("../fixtures/guard-corpus.ndjson", import.meta.url));
const corpus = readFileSync(corpusFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
// The fixture writes the workspace as /w; each test puts it in a real temporary folder.
const place = (value, workspace) => JSON.parse(JSON.stringify(value), (k, v) => (typeof v === "string" && /^\/w(\/|$)/.test(v) ? path.join(workspace, v.slice(2)) : v));

test("the registry only uses known classes, and the corpus covers every adapter and every class", () => {
  for (const tools of Object.values(TOOL_REGISTRY)) for (const value of Object.values(tools)) assert.ok(TOOL_CLASSES.includes(value), value);
  assert.deepEqual([...new Set(corpus.map((c) => c.adapter))].sort(), Object.keys(TOOL_REGISTRY).sort());
  assert.deepEqual([...new Set(corpus.map((c) => c.expect.class))].sort(), [...TOOL_CLASSES].sort());
});

test("every corpus call gets its typed class, agrees with today's guard where expected, and keeps its decision", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "typed-ws-"));
  for (const entry of corpus) {
    const adapter = getAdapter(entry.adapter), event = place(entry.event, workspace);
    const action = adapter.toAction(event), typed = typedAction(entry.adapter, action);
    const label = `${entry.adapter} ${typed.tool}`;
    assert.equal(typed.class, entry.expect.class, label);
    assert.equal(typed.agrees, entry.expect.agrees ?? true, `${label}: agrees`);
    if ("parseComplete" in entry.expect) assert.equal(typed.parseComplete, entry.expect.parseComplete, `${label}: parse`);
    if (entry.expect.effect) {
      // Claude's hook only protects paths (its tool lists do the rest); Codex's also keeps the task's scope.
      const policy = { workspace, protectedPaths: protectedPathsFor({ workspace }), allowedPaths: ["src/a.js"], qaCommand: "npm test", toolGuard: true, protectionOnly: entry.adapter === "claude", webAccess: false };
      assert.equal(decide(policy, action, { adapter }).effect, entry.expect.effect, `${label}: decision`);
    }
  }
});

test("the hook adds the typed class to the decision record and, opted in, keeps the call redacted for the corpus", async (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "typed-state-")), workspace = mkdtempSync(path.join(os.tmpdir(), "typed-ws-"));
  const policyPath = path.join(stateDir, "policy.json"), logPath = path.join(stateDir, "hook.ndjson"), corpusPath = path.join(stateDir, "run", "guard-corpus.ndjson");
  mkdirSync(path.dirname(corpusPath));
  writeFileSync(policyPath, JSON.stringify({ workspace, protectedPaths: protectedPathsFor({ workspace, stateDir }), allowedPaths: [], protectionOnly: true, corpus: corpusPath }));
  const call = (tool_input) => runHook(claude, { policyPath, logPath, input: JSON.stringify({ tool_name: "Bash", tool_input, cwd: workspace }) });
  await call({ command: "echo token=abcdef123456ghijkl" });
  await call({ command: "echo token=abcdef123456ghijkl" });
  await call({ command: "npm test" });
  const kept = readFileSync(corpusPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(kept.length, 3);
  assert.equal(kept[0].typed.class, "command");
  assert.doesNotMatch(kept[0].input, /abcdef123456ghijkl/, "redacted before it is kept");
  assert.equal((await collectCorpus(stateDir)).length, 2, "collected once per distinct call");
  const web = typedAction("claude", claude.toAction({ tool_name: "WebFetch", tool_input: { url: "https://api.example.com/d?access_token=AbCdEf1234567890xyz" } }));
  assert.doesNotMatch(web.url, /AbCdEf1234567890xyz/, "a token in the address is redacted");
});
