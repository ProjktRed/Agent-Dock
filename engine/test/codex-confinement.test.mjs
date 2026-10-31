import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexConfinement, codexDeniedPaths, codexProfileArgs, resetCodexProbes, CODEX_PROFILE } from "../src/guard/codex-confinement.mjs";
import { CodexWorker } from "../src/codex-worker.mjs";

const fixture = fileURLToPath(new URL("../fixtures/fake-codex-process.mjs", import.meta.url));
const temp = (t, name) => mkdtemp(path.join(os.tmpdir(), name)).then((dir) => { t.after(() => rm(dir, { recursive: true, force: true })); return dir; });

test("the profile denies reads by path, keeps any path one TOML key and gives write roles their extra folders", () => {
  const args = codexProfileArgs({ mode: "write", denied: [path.resolve('C:\\Users\\a "b"\\.ssh')], writable: [path.resolve("/git/common")] });
  assert.deepEqual(args.filter((a) => a !== "-c").map((a) => a.split("=")[0]), [`permissions.${CODEX_PROFILE}.extends`, `permissions.${CODEX_PROFILE}.filesystem`, `permissions.${CODEX_PROFILE}.network.enabled`]);
  assert.ok(args.includes(`permissions.${CODEX_PROFILE}.extends=":workspace"`));
  const filesystem = args.find((a) => a.includes(".filesystem="));
  assert.ok(filesystem.includes(`${JSON.stringify(path.resolve('C:\\Users\\a "b"\\.ssh'))}="deny"`), "quotes and backslashes are escaped");
  assert.ok(filesystem.includes(`${JSON.stringify(path.resolve("/git/common"))}="write"`));
  assert.ok(args.includes(`permissions.${CODEX_PROFILE}.network.enabled=false`));
  const read = codexProfileArgs({ mode: "read", denied: [], writable: [path.resolve("/git/common")] });
  assert.ok(read.includes(`permissions.${CODEX_PROFILE}.extends=":read-only"`));
  assert.ok(!read.join(" ").includes('"write"'), "read-only roles get no writable folder");
});

test("denied folders: sign-ins, a moved Codex home, Agent Dock's data and the state folder, when they exist", async (t) => {
  const home = await temp(t, "codex-home-"), stateDir = await temp(t, "codex-state-"), codexHome = await temp(t, "codex-moved-");
  await mkdir(path.join(home, ".ssh"));
  await mkdir(path.join(home, "AppData", "Agent Dock"), { recursive: true });
  const portable = await temp(t, "codex-portable-");
  const denied = codexDeniedPaths({ stateDir, home, env: { CODEX_HOME: codexHome, APPDATA: path.join(home, "AppData"), AGENT_DOCK_USER_DATA: portable }, platform: "win32" });
  assert.deepEqual(denied.sort(), [path.join(home, ".ssh"), codexHome, path.join(home, "AppData", "Agent Dock"), portable, stateDir].map((p) => path.resolve(p)).sort(), "the app's real data folder (portable here) is denied too");
  assert.ok(!denied.includes(path.join(home, ".aws")), "a missing folder is left out");
});

test("a passing probe selects the profile; a Codex without profiles keeps the plain sandbox; a leak refuses a required sandbox", async (t) => {
  resetCodexProbes();
  t.after(resetCodexProbes);
  const stateDir = await temp(t, "codex-conf-"), launcher = { command: "codex" };
  let probes = 0;
  const pass = async ({ mode }) => (probes++, { ok: true, results: { insideWrite: mode === "write" ? "ok" : "EPERM", outsideWrite: "EPERM", deniedRead: "EPERM", network: "EACCES" } });
  const chosen = await codexConfinement({ mode: "write", stateDir, launcher, probe: pass });
  assert.deepEqual(chosen.args.slice(0, 2), ["-c", `default_permissions="${CODEX_PROFILE}"`]);
  assert.ok(chosen.args.includes('approval_policy="never"') && !chosen.args.includes("--sandbox"));
  assert.equal(chosen.attestation.probe, "passed");
  assert.equal(chosen.attestation.readLimits, true);
  await codexConfinement({ mode: "write", stateDir, launcher, probe: pass });
  assert.equal(probes, 1, "a passing probe is reused");

  const missing = async () => (probes++, { ok: false, reason: "Codex could not apply the profile" });
  const plain = await codexConfinement({ mode: "read", stateDir, launcher, probe: missing, required: true });
  assert.deepEqual(plain.args, ["--sandbox", "read-only"]);
  assert.equal(plain.attestation.probe, "failed");
  await codexConfinement({ mode: "read", stateDir, launcher, probe: missing });
  assert.equal(probes, 3, "a failed probe is tried again");

  const leak = async () => ({ ok: false, results: { insideWrite: "ok", outsideWrite: "ok", deniedRead: "EPERM", network: "EACCES" }, reason: "the sandbox did not hold: outsideWrite" });
  assert.equal((await codexConfinement({ mode: "write", stateDir, launcher: { command: "other" }, probe: leak })).args.includes("workspace-write"), true, "not required: the plain sandbox, as before");
  await assert.rejects(codexConfinement({ mode: "write", stateDir, launcher: { command: "other" }, probe: leak, required: true }), /could not be confirmed: the sandbox did not hold: outsideWrite/);

  const none = await codexConfinement({ mode: "write", stateDir });
  assert.equal(none.attestation.probe, "not run");
});

test("Codex roles run in the probed profile and log what confined them", async (t) => {
  resetCodexProbes();
  t.after(resetCodexProbes);
  const root = await temp(t, "codex-role-"), argsFile = path.join(root, "args.json");
  const saved = { args: process.env.FAKE_CODEX_ARGS_FILE, probe: process.env.FAKE_CODEX_PROBE };
  process.env.FAKE_CODEX_ARGS_FILE = argsFile;
  process.env.FAKE_CODEX_PROBE = "pass";
  t.after(() => { for (const [k, v] of [["FAKE_CODEX_ARGS_FILE", saved.args], ["FAKE_CODEX_PROBE", saved.probe]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const gitCommonDir = path.join(root, "external-git");
  const codex = new CodexWorker({ workspace: root, stateDir: root, command: process.execPath, prefixArgs: [fixture, path.join(root, "pids.json")], additionalWritableDirs: [gitCommonDir] });
  const result = JSON.stringify({ status: "fail", output: "x", correction: "y", nextWorkerInstructions: "", commit: "" });
  await codex.invoke(result, "workspace-write").catch(() => {});
  const qa = JSON.parse(await readFile(argsFile, "utf8"));
  assert.ok(qa.includes(`default_permissions="${CODEX_PROFILE}"`) && !qa.includes("--sandbox"));
  assert.ok(qa.find((a) => a.includes(".filesystem=")).includes(`${JSON.stringify(path.resolve(gitCommonDir))}="write"`));
  await codex.invoke(result, "read-only").catch(() => {});
  const assessment = JSON.parse(await readFile(argsFile, "utf8"));
  assert.ok(assessment.includes(`permissions.${CODEX_PROFILE}.extends=":read-only"`));
  assert.ok(!assessment.find((a) => a.includes(".filesystem=")).includes('"write"'));
  // The commands Codex runs don't inherit its keys (release review 0.40.0).
  assert.ok(assessment.includes("shell_environment_policy.ignore_default_excludes=false"));
  assert.ok(JSON.parse(assessment.find((a) => a.startsWith("shell_environment_policy.exclude=")).split("=")[1]).includes("OPENAI_API_KEY"));
  const log = (await readFile(path.join(root, "action-log.ndjson"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "attestation");
  assert.deepEqual(log.map((e) => [e.cli, e.sandbox, e.probe]), [["codex", "codex-profile-write", "passed"], ["codex", "codex-profile-read", "passed"]]);
});
