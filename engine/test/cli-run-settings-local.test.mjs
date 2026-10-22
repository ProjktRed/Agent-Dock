import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildClineArgs } from "../src/cline-cli-worker.mjs";
import { OpenCodeCliWorker, openCodeRunArgs } from "../src/opencode-cli-worker.mjs";
import { setCliRunSettings } from "../src/cli-run-settings.mjs";

const base = { clineJs: "cline-js", workspace: "w", provider: "ollama", model: "m", timeoutSeconds: 60, prompt: "p" };

test("Cline gets the retries and compaction from CLIs › Settings, and Agent Dock's defaults otherwise", (t) => {
  t.after(() => setCliRunSettings(undefined));
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const plain = buildClineArgs(base);
  assert.deepEqual([flag(plain, "--retries"), flag(plain, "--compaction")], ["6", "agentic"]);
  setCliRunSettings(JSON.stringify({ cline: { retries: 3, compaction: "off", yolo: true } }));
  const set = buildClineArgs({ ...base, guardLaunchArgs: ["--config", "guard"] });
  assert.deepEqual([flag(set, "--retries"), flag(set, "--compaction")], ["3", "off"]);
  assert.equal(set.includes("--yolo"), false);
  assert.ok(set.indexOf("--retries") < set.indexOf("--config"), "the guard's flags come after");
});

test("OpenCode gets the variant flag and the step limit from CLIs › Settings", async (t) => {
  t.after(() => setCliRunSettings(undefined));
  const guard = { providerID: "local", model: "m" };
  assert.deepEqual(openCodeRunArgs(guard, "p"), ["run", "--standalone", "--format", "json", "-m", "local/m", "--agent", "agent-dock", "--auto", "p"]);
  setCliRunSettings(JSON.stringify({ opencode: { variant: "high", steps: 80 } }));
  assert.deepEqual(openCodeRunArgs(guard, "p").slice(6, 8), ["--variant", "high"]);
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-steps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providerDescriptor = { id: "ollama", model: "m", baseUrl: "http://127.0.0.1:11434/v1" };
  const worker = new OpenCodeCliWorker({ stateDir: root, workspace: root, providerDescriptor, launch: async (options) => options });
  const { guard: installed } = await worker.run("p", { task: { id: "t", allowedPaths: ["a.txt"], qaCommand: "npm test" } });
  assert.equal(JSON.parse(installed.env.OPENCODE_CONFIG_CONTENT).agents["agent-dock"].steps, 80);
  setCliRunSettings(undefined);
  const { guard: defaults } = await worker.run("p", { task: { id: "t", allowedPaths: ["a.txt"], qaCommand: "npm test" } });
  assert.equal(JSON.parse(defaults.env.OPENCODE_CONFIG_CONTENT).agents["agent-dock"].steps, 40);
});
