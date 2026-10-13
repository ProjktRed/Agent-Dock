#!/usr/bin/env node
// Re-feed a recorded baseline's inputs through a guard implementation and write a tree compare.mjs
// can diff against the recording.
//
//   node scripts/guard-baseline/replay.mjs --impl old --mode sequence --in baseline/old --out replay/old-seq
//   node scripts/guard-baseline/replay.mjs --impl new --mode isolated --in baseline/old --out replay/new-iso
//
// Two modes, both required:
//   --mode sequence   replay in order against one evolving policy. Catches counter and transition
//                     drift: event N sees whatever event N-1 actually left behind.
//   --mode isolated   restore policy.json from the recorded pre-state before each event, so one
//                     divergence cannot cascade into dozens of false diffs downstream.
//
// The in-process plugin instance is NOT recreated per event in either mode: its closed-over
// registeredTools set (cline-tool-guard.mjs:48) is established by beforeModel and is part of the
// behavior under test, not part of the policy file.
//
// Import-only. No network, no Cline, and the only subprocess is the generated file hook — which is
// itself the thing under test.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GUARD_ALLOWED_TOOLS, SEED_FILES, TASK } from "./scenarios.mjs";
import { deriveStrings, snapshotForRecord, snapshotTree } from "./lib/derive.mjs";
import { makeNormalizer } from "./lib/normalize.mjs";
import { GUARD_MODULE, REPO_ROOT, createRunner, writePolicySnapshot } from "./lib/runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    flags[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const impl = flags.impl ?? "old";
const mode = flags.mode ?? "sequence";
if (!GUARD_MODULE[impl]) throw new Error(`--impl must be old or new, got "${impl}"`);
if (!["sequence", "isolated"].includes(mode)) throw new Error(`--mode must be sequence or isolated, got "${mode}"`);
if (!flags.in || flags.in === "true") throw new Error("--in <recorded baseline dir> is required");
if (!flags.out || flags.out === "true") throw new Error("--out <dir> is required");
const inRoot = path.resolve(HERE, flags.in);
const outRoot = path.resolve(HERE, flags.out);
const only = flags.only && flags.only !== "true" ? new Set(flags.only.split(",").map((name) => name.trim())) : null;

const fixture = {
  ...JSON.parse(await readFile(path.join(HERE, "fixtures", "cline-tool-catalog.json"), "utf8")),
  guardAllowedTools: GUARD_ALLOWED_TOOLS,
};
const meta = JSON.parse(await readFile(path.join(inRoot, "meta.json"), "utf8"));
if (meta.tier !== "A") throw new Error(`replay only drives a Tier A recording; ${flags.in} is tier ${meta.tier}`);
const { canRecoverOperational } = await import(path.join(REPO_ROOT, "engine", "src", "blocked-resolver.mjs"));

const problems = [];
const note = (message) => { problems.push(message); console.log(`! ${message}`); };

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });
console.log(`replay --impl ${impl} --mode ${mode} ${flags.in} → ${path.relative(REPO_ROOT, outRoot)}`);

const replayed = [];
for (const entry of meta.cases) {
  if (only && !only.has(entry.name)) continue;
  const destination = path.join(outRoot, entry.name);
  await mkdir(destination, { recursive: true });

  // The Codex rail is stateless and has no policy to evolve, so neither replay mode has anything
  // to do differently with it. Its recording passes through unchanged, which keeps
  // `compare baseline/old replay/*` a comparison of the whole tree rather than part of it.
  if (entry.kind === "codex") {
    for (const file of ["prepare.json", "decisions.ndjson", "strings.json"]) {
      await writeFile(path.join(destination, file), await readFile(path.join(inRoot, entry.name, file), "utf8"), "utf8");
    }
    replayed.push({ name: entry.name, events: entry.events, passthrough: true });
    console.log(`  ${entry.name}: passthrough (stateless rail)`);
    continue;
  }

  const recorded = (await readFile(path.join(inRoot, entry.name, "decisions.ndjson"), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));

  const runner = await createRunner({ impl, caseName: entry.name, seedFiles: SEED_FILES, task: TASK, fixture });
  const { context } = runner;
  const normalizer = makeNormalizer({ tokens: runner.tokens });

  await writeFile(path.join(destination, "prepare.json"),
    JSON.stringify(normalizer.valuePaths(context.prepared), null, 2) + "\n", "utf8");
  await snapshotTree(path.dirname(context.prepared.policyPath), normalizer, path.join(destination, "artifacts"));

  const events = [];
  for (const previous of recorded) {
    if (mode === "isolated") {
      await writePolicySnapshot(context.prepared.policyPath, normalizer.denormalize(previous.policyBefore));
    }
    const input = normalizer.denormalize(previous.input);
    const policyBefore = await runner.readPolicy();
    let control;
    try { control = await runner.execute({ at: previous.at, input }, previous.seq); }
    catch (error) { control = { harnessThrew: { name: error.name, message: error.message } }; }
    const policyAfter = await runner.readPolicy();
    events.push({
      seq: previous.seq,
      at: previous.at,
      input: previous.input,
      control: control === undefined ? { undefined: true } : normalizer.value(control),
      policyBefore: snapshotForRecord(policyBefore, normalizer),
      policyAfter: snapshotForRecord(policyAfter, normalizer),
    });
  }
  await writeFile(path.join(destination, "decisions.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");

  const covers = JSON.parse(await readFile(path.join(inRoot, entry.name, "strings.json"), "utf8")).covers ?? [];
  const strings = await deriveStrings({ guard: context.guard, prepared: context.prepared, stateDir: context.stateDir, events, normalizer, canRecoverOperational });
  await writeFile(path.join(destination, "strings.json"), JSON.stringify({ covers, ...strings }, null, 2) + "\n", "utf8");

  await runner.cleanup();
  const drift = events.filter((event, index) => JSON.stringify(event) !== JSON.stringify(recorded[index])).length;
  if (drift) note(`${entry.name}: ${drift}/${events.length} event(s) differ from the recording (compare.mjs prints the per-field diff)`);
  replayed.push({ name: entry.name, events: events.length, drift });
  console.log(`  ${entry.name}: ${events.length} decisions${drift ? `, ${drift} differ` : ""}`);
}

// meta/inventory/verdicts describe the recording, not this replay of it: copied so the two trees
// compare as whole trees. A replay that drifts shows up in decisions.ndjson and strings.json.
for (const file of ["meta.json", "inventory.json", "verdicts.json"]) {
  await writeFile(path.join(outRoot, file), await readFile(path.join(inRoot, file), "utf8"), "utf8");
}
await writeFile(outRoot + "-environment.json", JSON.stringify({
  capturedAt: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`,
  replayOf: path.relative(REPO_ROOT, inRoot).replaceAll(path.sep, "/"), impl, mode,
}, null, 2) + "\n", "utf8");

console.log(`\ncases: ${replayed.length}  decisions: ${replayed.reduce((total, entry) => total + entry.events, 0)}`);
if (problems.length) {
  console.log(`\n${problems.length} case(s) drifted. Run compare.mjs for the per-field diff.`);
  process.exit(1);
}
console.log("ok");
