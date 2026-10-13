// The Tier A step executor, shared by capture.mjs and replay.mjs so a recording and its replay
// cannot drift in how they drive the guard.
//
// A step is `{ at, ...spec }` as authored in direct-cases.mjs, or `{ at, input }` as recorded in
// decisions.ndjson. `resolveStep` turns the first into the second; `execute` only ever reads
// `input`. That is what makes replay.mjs feed back exactly what was recorded instead of
// re-deriving it.
//
// Step kinds
//   plugin.beforeModel   { catalog: "full"|"observed" }      → hooks.beforeModel({request:{tools}})
//                        recorded as `{ catalog }`, not as an inlined copy of the 28-tool
//                        catalog: fixtures/cline-tool-catalog.json is committed next to the
//                        recording, so the reference still fully determines the input, and the
//                        narrowed tool list the guard *returned* is still recorded verbatim.
//   plugin.afterModel    { calls: [{name,input,id}] }         → hooks.afterModel({assistantMessage})
//   plugin.beforeTool    { call: {name,input,id} }            → hooks.beforeTool({tool,input,toolCall})
//   hook.PreToolUse      { call } | { payload } | { stdin } | { stdinRepeat:{unit,bytes} }
//   hook.PostToolUse     { call: {name,id,input,output,success} } | { payload } | { stdin }
//   fs.write             { file, content }
//   fs.fill              { file, bytes, unit }                — a big file without a big recording
//   fs.delete            { file }
//   state.policy         { patch } | { raw } | { restore:"prepared", patch? }
//   state.lock           { create: boolean }
//   api.prepareToolGuard { task }                             — in a per-step probe directory
//   api.verifyRestrictedTools { plugin: "present"|"neutered"|"deleted" }
//   api.readGuardOutcome { policy }
//   api.readWorkerCapabilities { present: boolean }

import { execFile, spawn } from "node:child_process";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const GUARD_MODULE = {
  old: path.join(REPO_ROOT, "engine", "src", "cline-tool-guard.mjs"),
  new: path.join(REPO_ROOT, "engine", "src", "guard", "adapters", "cline.mjs"),
};

export const CODEX_HOOK = path.join(REPO_ROOT, "engine", "src", "codex-scope-hook.mjs");
export { REPO_ROOT };

/**
 * A *stable* throwaway root, not mkdtemp. cline-edit-boundary.mjs:9 fingerprints a failed edit by
 * hashing the tool input, which contains the absolute file path, and that hash is persisted in
 * policy.editFailures — so a random temp directory makes two runs of the same case differ in a
 * field no path normalization can reverse. A fixed path under the OS temp directory keeps
 * capture ↔ capture and capture ↔ replay byte-exact on one machine.
 *
 * Consequence, stated rather than hidden: comparing recordings made under *different* temp
 * directories (a Linux box against a Windows box) will differ in exactly these fingerprint
 * fields. The Part 2 gate is an old-vs-new compare on one machine, where they match.
 *
 * One run at a time per `scope`; concurrent captures into the same scope would collide.
 */
export function workRoot(scope) {
  return path.join(os.tmpdir(), "agent-dock-guard-baseline", scope);
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/** A Cline SDK-shape tool list from the fixture: "observed" is what Cline 3.0.70 really sends. */
export function catalogTools(fixture, which) {
  const strip = ({ descriptionSha256: _a, descriptionLength: _b, synthetic: _c, ...tool }) => tool;
  if (which === "observed") return fixture.observed.map(strip);
  if (which === "full") return [...fixture.observed, ...fixture.guardOnly].map(strip);
  throw new Error(`unknown catalog "${which}"`);
}

/**
 * One scripted model scenario → the step list a real Cline would produce, in Cline's dispatch
 * order. Verified against Cline CLI 3.0.70 (see README.md "What Tier B proved"):
 *   1. the SDK plugin's beforeModel narrows the request,
 *   2. afterModel sees tool calls the narrowed registry does not contain and nothing else runs
 *      for them — the SDK rejects them before execution,
 *   3. for a registered call the file hook runs first, then the plugin's beforeTool,
 *   4. PostToolUse is dispatched even for a plugin-skipped call.
 */
export function expandScenario(scenario, registry) {
  const steps = [];
  scenario.turns.forEach((turn, index) => {
    steps.push({ at: "plugin.beforeModel", catalog: "observed" });
    const calls = (turn.toolCalls ?? []).map((call, position) => ({
      name: call.name,
      input: call.arguments ?? {},
      id: `call_${scenario.name}_${index}_${position}`,
    }));
    if (calls.length) steps.push({ at: "plugin.afterModel", calls });
    for (const call of calls) {
      if (!registry.has(call.name)) continue;
      steps.push({ at: "hook.PreToolUse", call: { name: call.name, input: call.input } });
      steps.push({ at: "plugin.beforeTool", call });
      steps.push({
        at: "hook.PostToolUse",
        call: { name: call.name, id: call.id, input: call.input, ...defaultResult(call, scenario) },
      });
    }
  });
  return steps;
}

/** The result shapes a real Cline 3.0.70 sends back for each tool, recorded from live runs. */
function defaultResult(call, scenario) {
  const { name, input } = call;
  if (name === "read_files") {
    const files = Array.isArray(input.files) ? input.files : [];
    const results = files.map((file) => ({ query: file.path, result: `{{READ:${file.path}}}`, success: true }));
    return { output: JSON.stringify(results), success: true };
  }
  if (name === "run_commands") {
    const commands = Array.isArray(input.commands) ? input.commands : [];
    return { output: JSON.stringify(commands.map((command) => ({ query: command, result: "", success: true }))), success: true };
  }
  if (name === "editor") {
    const created = input.old_text == null && input.insert_line == null;
    return {
      output: JSON.stringify({ query: `edit:${input.path}`, result: created ? `File created successfully at: ${input.path}` : `Edited ${input.path}`, success: true }),
      success: true,
    };
  }
  return { output: JSON.stringify({ query: scenario.name, result: "ok", success: true }), success: true };
}

/** `{{READ:<abs path>}}` → the numbered-line block Cline's read_files returns for that file now. */
async function materializeReads(text, workspace) {
  const matches = [...String(text).matchAll(/\{\{READ:([^}]+)\}\}/g)];
  let out = String(text);
  for (const [token, file] of matches) {
    const body = await readFile(path.resolve(workspace, file), "utf8").catch(() => "");
    const lines = body.replace(/\r\n/g, "\n").split("\n");
    while (lines.length && lines.at(-1) === "") lines.pop();
    const numbered = lines.map((line, index) => `${index + 1} | ${line}`).join("\n");
    out = out.replaceAll(token, JSON.stringify(numbered).slice(1, -1));
  }
  return out;
}

export function materialize(value, workspace) {
  return JSON.parse(JSON.stringify(value).replaceAll("{{WS}}", workspace.replaceAll("\\", "\\\\")));
}

/**
 * A throwaway run of one case: workspace, state dir, prepared guard, live plugin instance.
 * `seedFiles` is scenarios.mjs SEED_FILES; `task` is scenarios.mjs TASK.
 */
export async function createRunner({ impl, caseName, seedFiles, task, fixture, scope = "tierA" }) {
  const guard = await import(GUARD_MODULE[impl]);
  const base = workRoot(scope);
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  const root = await realpath(base);
  const caseRoot = path.join(root, caseName);
  const workspace = path.join(caseRoot, "workspace");
  const stateDir = path.join(caseRoot, "state");
  const probeRoot = path.join(caseRoot, "probe");
  for (const directory of [workspace, stateDir, probeRoot]) await mkdir(directory, { recursive: true });

  for (const [relative, body] of Object.entries(seedFiles)) {
    await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await writeFile(path.join(workspace, relative), body);
  }
  await exec("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  await exec("git", ["add", "-A"], { cwd: workspace });
  await exec("git", ["-c", "user.email=guard@baseline.invalid", "-c", "user.name=Guard Baseline", "commit", "-qm", "seed"], { cwd: workspace });
  await writeFile(path.join(stateDir, "current-task.json"), JSON.stringify(task, null, 2) + "\n");

  const prepared = await guard.prepareToolGuard({ stateDir, workspace });
  const preparedPolicy = await readFile(prepared.policyPath, "utf8");
  await writeFile(path.join(caseRoot, "prepared-policy.json"), preparedPolicy);
  const plugin = guard.createRestrictedToolsPlugin(prepared.policyPath);

  const registry = new Set(catalogTools(fixture, "observed").map((tool) => tool.name)
    .filter((name) => fixture.guardAllowedTools.includes(name)));

  const context = {
    impl, guard, root, caseRoot, workspace, stateDir, probeRoot, prepared, plugin, registry, fixture,
    realWorkspace: await realpath(workspace),
    realStateDir: await realpath(stateDir),
  };

  return {
    context,
    tokens: { REPO: REPO_ROOT, RUN: root, WS: context.realWorkspace, STATE: context.realStateDir },
    resolveStep: (spec, seq) => resolveStep(spec, context, seq),
    execute: (event, seq) => execute(event, context, seq),
    readPolicy: () => readPolicySnapshot(prepared.policyPath),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Authored spec → the `{at, input}` pair that gets recorded and that replay feeds back. */
async function resolveStep(spec, context, seq) {
  const { at, ...rest } = materialize(spec, context.workspace);
  if (at === "plugin.beforeModel") {
    catalogTools(context.fixture, rest.catalog);  // fail now, not mid-recording, on a bad name
    return { at, input: { catalog: rest.catalog } };
  }
  if (at === "plugin.afterModel") {
    return {
      at,
      input: {
        assistantMessage: {
          content: rest.calls.map((call) => ({ type: "tool-call", toolName: call.name, input: call.input, toolCallId: call.id ?? null })),
        },
      },
    };
  }
  if (at === "plugin.beforeTool") {
    return { at, input: { tool: { name: rest.call.name }, input: rest.call.input, toolCall: { toolCallId: rest.call.id ?? null } } };
  }
  if (at === "hook.PreToolUse" || at === "hook.PostToolUse") {
    if (rest.stdin !== undefined || rest.stdinRepeat !== undefined) return { at, input: rest };
    if (rest.payload !== undefined) return { at, input: { stdin: JSON.stringify(rest.payload) } };
    const call = rest.call;
    const payload = at === "hook.PreToolUse"
      ? { hookName: "tool_call", tool_call: { name: call.name, input: call.input, ...(call.id ? { id: call.id } : {}) } }
      : { hookName: "tool_result", tool_result: { name: call.name, input: call.input, output: call.output, ...(call.id ? { id: call.id } : {}) }, postToolUse: { success: call.success !== false } };
    return { at, input: { stdin: await materializeReads(JSON.stringify(payload), context.workspace) } };
  }
  if (at.startsWith("fs.") || at.startsWith("state.") || at.startsWith("api.")) return { at, input: rest };
  throw new Error(`unknown step "${at}"`);
}

async function readPolicySnapshot(policyPath) {
  let text;
  try { text = await readFile(policyPath, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { missing: true }; throw error; }
  try { return { json: JSON.parse(text) }; }
  catch { return { raw: text }; }
}

async function writePolicySnapshot(policyPath, snapshot) {
  if (snapshot?.missing) return rm(policyPath, { force: true });
  if (snapshot?.raw !== undefined) return writeFile(policyPath, snapshot.raw, "utf8");
  return writeFile(policyPath, JSON.stringify(snapshot.json, null, 2), "utf8");
}

export { writePolicySnapshot };

/** Run the generated file hook exactly as Cline does: a Node subprocess, NDJSON on stdin. */
function runHook(script, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    // The guard stops reading past 1 MB, so the remaining write is expected to break.
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const PROBE_PLUGINS = {
  neutered: 'export default {name:"automation.not-the-guard",hooks:{}};\n',
};

async function execute(event, context, seq) {
  const { at, input } = event;
  const { guard, plugin, prepared, workspace, stateDir, probeRoot } = context;
  const probeDir = path.join(probeRoot, String(seq));

  if (at === "plugin.beforeModel") {
    return plugin.hooks.beforeModel({ request: { tools: catalogTools(context.fixture, input.catalog) } });
  }
  if (at === "plugin.afterModel") return plugin.hooks.afterModel({ assistantMessage: input.assistantMessage });
  if (at === "plugin.beforeTool") return plugin.hooks.beforeTool({ tool: input.tool, input: input.input, toolCall: input.toolCall });

  if (at === "hook.PreToolUse" || at === "hook.PostToolUse") {
    const name = at === "hook.PreToolUse" ? "PreToolUse.mjs" : "PostToolUse.mjs";
    const stdin = input.stdinRepeat
      ? input.stdinRepeat.unit.repeat(Math.ceil(input.stdinRepeat.bytes / input.stdinRepeat.unit.length))
      : input.stdin;
    return runHook(path.join(prepared.hooksDir, name), stdin);
  }

  if (at === "fs.write") { await writeFile(path.resolve(workspace, input.file), input.content, "utf8"); return null; }
  if (at === "fs.fill") {
    const unit = input.unit ?? "x";
    await writeFile(path.resolve(workspace, input.file), unit.repeat(Math.ceil(input.bytes / unit.length)), "utf8");
    return null;
  }
  if (at === "fs.delete") { await rm(path.resolve(workspace, input.file), { force: true }); return null; }

  if (at === "state.policy") {
    if (input.raw !== undefined) { await writeFile(prepared.policyPath, input.raw, "utf8"); return null; }
    const base = input.restore === "prepared"
      ? JSON.parse(await readFile(path.join(context.caseRoot, "prepared-policy.json"), "utf8"))
      : JSON.parse(await readFile(prepared.policyPath, "utf8"));
    await writeFile(prepared.policyPath, JSON.stringify({ ...base, ...(input.patch ?? {}) }, null, 2), "utf8");
    return null;
  }
  if (at === "state.lock") {
    const lock = prepared.policyPath + ".lock";
    if (input.create) await writeFile(lock, "stale\n", "utf8");
    else await rm(lock, { force: true });
    return null;
  }

  if (at === "api.prepareToolGuard") {
    await mkdir(probeDir, { recursive: true });
    if (input.task !== null && input.task !== undefined) {
      await writeFile(path.join(probeDir, "current-task.json"), JSON.stringify(input.task, null, 2) + "\n");
    }
    return capture(() => guard.prepareToolGuard({ stateDir: probeDir, workspace }));
  }
  if (at === "api.verifyRestrictedTools") {
    await mkdir(probeDir, { recursive: true });
    await writeFile(path.join(probeDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const pluginPath = path.join(probeDir, "restricted-tools.js");
    if (input.plugin === "present") await cp(prepared.pluginPath, pluginPath);
    else if (input.plugin === "neutered") await writeFile(pluginPath, PROBE_PLUGINS.neutered, "utf8");
    else await rm(pluginPath, { force: true });
    return capture(async () => (await guard.verifyRestrictedTools({ pluginPath }), "ok"));
  }
  if (at === "api.readGuardOutcome") {
    await mkdir(probeDir, { recursive: true });
    const policyPath = path.join(probeDir, "policy.json");
    await writeFile(policyPath, typeof input.policy === "string" ? input.policy : JSON.stringify(input.policy, null, 2), "utf8");
    return capture(() => guard.readGuardOutcome(policyPath));
  }
  if (at === "api.readWorkerCapabilities") {
    if (!input.present) await mkdir(probeDir, { recursive: true });
    return capture(() => guard.readWorkerCapabilities(input.present ? stateDir : probeDir));
  }
  throw new Error(`unknown step "${at}"`);
}

/** API probes record either a value or the thrown message — never a stack. */
async function capture(operation) {
  try { return { returned: await operation() }; }
  catch (error) { return { threw: { name: error.name, message: error.message, code: error.code ?? null } }; }
}
