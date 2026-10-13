#!/usr/bin/env node
// The gate. An exact-string, structural diff of two baseline trees.
//
//   node scripts/guard-baseline/compare.mjs baseline/old baseline/old-again
//   node scripts/guard-baseline/compare.mjs baseline/old replay/old-seq
//   node scripts/guard-baseline/compare.mjs baseline/old baseline/new
//
// Compared: the case list, every file in every case directory byte for byte — every `control`
// object, every reason string, every policy snapshot, the generated artifact text,
// prepare.json.instructions, argv.json, providers.json, strings.json, stub-requests.ndjson — plus
// the run-level meta.json, inventory.json and verdicts.json.
//
// THE ONE DECLARED ALLOWABLE DIFFERENCE
//
//   Inside artifacts/config/hooks/{PreToolUse,PostToolUse}.mjs and
//   artifacts/config/plugins/restricted-tools.js, the single generated
//   `import {...} from "file:///…"` line may change its module specifier — and nothing else.
//   Part 2 moves that specifier from cline-tool-guard.mjs to the new adapter module. A second
//   changed line in those files, a changed imported name, or a changed specifier anywhere else is
//   a failure. There is no fuzzy matching and no second exemption.
//
// Not compared: `<tree>-environment.json`, which is a *sibling* of each tree rather than a file
// inside it, precisely so that a Node version or a capture timestamp can never be mistaken for a
// second allowance.
//
// Tier B determinism is handled at capture time, not here: lib/normalize.mjs rewrites paths,
// ports, ISO timestamps and Cline's M/D/YYYY prompt date to placeholders before writing, so
// this stays an exact diff for Tier B too.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const IMPORT_ALLOWLIST = {
  files: [/^artifacts\/config\/hooks\/(?:PreToolUse|PostToolUse)\.mjs$/, /^artifacts\/config\/plugins\/restricted-tools\.js$/],
  line: /^(import \{[A-Za-z0-9_, ]+\} from )("file:\/\/[^"]+")(;)$/,
};

const [leftArg, rightArg, ...rest] = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const verbose = process.argv.includes("--verbose");
if (!leftArg || !rightArg || rest.length) {
  console.error("Usage: node compare.mjs <left tree> <right tree> [--verbose]");
  process.exit(64);
}
const left = path.resolve(HERE, leftArg);
const right = path.resolve(HERE, rightArg);

async function listFiles(root) {
  const files = new Map();
  const walk = async (directory, relative) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(path.join(directory, entry.name), next); continue; }
      files.set(next, path.join(directory, entry.name));
    }
  };
  if (!(await stat(root).catch(() => null))) throw new Error(`no such tree: ${root}`);
  await walk(root, "");
  return files;
}

/** The first N differing lines of two texts, as a readable diff. */
function lineDiff(a, b, limit = 6) {
  const leftLines = a.split("\n");
  const rightLines = b.split("\n");
  const rows = [];
  for (let i = 0; i < Math.max(leftLines.length, rightLines.length) && rows.length < limit; i++) {
    if (leftLines[i] === rightLines[i]) continue;
    rows.push({ line: i + 1, left: leftLines[i] ?? "(absent)", right: rightLines[i] ?? "(absent)" });
  }
  const total = Math.max(leftLines.length, rightLines.length);
  let differing = 0;
  for (let i = 0; i < total; i++) if (leftLines[i] !== rightLines[i]) differing += 1;
  return { rows, differing };
}

/**
 * True when every differing line in a generated artifact is the declared import-specifier change
 * and nothing else: same line count, same imported names, only the `from "file://…"` part moved.
 */
function onlyDeclaredImportChange(relative, a, b) {
  const caseRelative = relative.split("/").slice(1).join("/");
  if (!IMPORT_ALLOWLIST.files.some((pattern) => pattern.test(caseRelative))) return null;
  const leftLines = a.split("\n");
  const rightLines = b.split("\n");
  if (leftLines.length !== rightLines.length) return null;
  const changes = [];
  for (let i = 0; i < leftLines.length; i++) {
    if (leftLines[i] === rightLines[i]) continue;
    const l = IMPORT_ALLOWLIST.line.exec(leftLines[i]);
    const r = IMPORT_ALLOWLIST.line.exec(rightLines[i]);
    if (!l || !r || l[1] !== r[1] || l[3] !== r[3]) return null;
    changes.push({ line: i + 1, from: l[2], to: r[2] });
  }
  return changes.length ? changes : null;
}

const failures = [];
const allowed = [];

const leftFiles = await listFiles(left);
const rightFiles = await listFiles(right);

for (const relative of [...new Set([...leftFiles.keys(), ...rightFiles.keys()])].sort()) {
  const a = leftFiles.get(relative);
  const b = rightFiles.get(relative);
  if (!a) { failures.push({ relative, kind: "only-in-right" }); continue; }
  if (!b) { failures.push({ relative, kind: "only-in-left" }); continue; }
  const textA = await readFile(a, "utf8");
  const textB = await readFile(b, "utf8");
  if (textA === textB) continue;
  const declared = onlyDeclaredImportChange(relative, textA, textB);
  if (declared) { allowed.push({ relative, changes: declared }); continue; }
  failures.push({ relative, kind: "content", ...lineDiff(textA, textB) });
}

console.log(`compare ${leftArg} ↔ ${rightArg}`);
console.log(`  files: ${leftFiles.size} ↔ ${rightFiles.size}`);
for (const entry of allowed) {
  console.log(`  allowed (declared import specifier): ${entry.relative}`);
  for (const change of entry.changes) console.log(`      line ${change.line}: ${change.from} → ${change.to}`);
}
if (!failures.length) {
  console.log(`  identical${allowed.length ? ` apart from ${allowed.length} declared import change(s)` : ""}`);
  process.exit(0);
}
console.log(`\n${failures.length} difference(s):`);
for (const failure of failures.slice(0, verbose ? failures.length : 20)) {
  if (failure.kind !== "content") { console.log(`  ${failure.kind}: ${failure.relative}`); continue; }
  console.log(`  ${failure.relative}: ${failure.differing} differing line(s)`);
  for (const row of failure.rows) {
    console.log(`      line ${row.line}`);
    console.log(`        - ${row.left.slice(0, 300)}`);
    console.log(`        + ${row.right.slice(0, 300)}`);
  }
}
if (failures.length > 20 && !verbose) console.log(`  … ${failures.length - 20} more (use --verbose)`);
process.exit(1);
