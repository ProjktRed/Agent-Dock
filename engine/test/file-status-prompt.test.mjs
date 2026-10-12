import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCorrectionPrompt, buildInitialPrompt, describeAllowedPaths } from "../src/workflow.mjs";

async function repo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-status-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, windowsHide: true });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "existing.ts"), "export const x = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return dir;
}

const task = (allowedPaths) => ({ id: "T", name: "n", prompt: "Task skill: implement\nGoal", allowedPaths, qaCommand: "npm test" });

test("marks tracked files MODIFY, absent files CREATE and untracked task files CREATED BY THIS TASK", async () => {
  const dir = await repo();
  await writeFile(path.join(dir, "src", "partial.ts"), "broken");
  const text = describeAllowedPaths(task(["src/existing.ts", "src/new.ts", "src/partial.ts"]), dir);
  assert.match(text, /src\/existing\.ts: MODIFY/);
  assert.match(text, /src\/new\.ts: CREATE \(does not exist yet; create it directly; do not search/);
  assert.match(text, /src\/partial\.ts: CREATED BY THIS TASK.*overwrite it completely/);
});

test("initial and correction prompts carry the file status only when a workspace is supplied", async () => {
  const dir = await repo();
  const t = task(["src/new.ts"]);
  assert.match(buildInitialPrompt(t, { workspace: dir }), /File status \(computed by Node from git\)/);
  assert.match(buildCorrectionPrompt(t, "QA failed", 1, "", false, { workspace: dir }), /src\/new\.ts: CREATE/);
  assert.doesNotMatch(buildInitialPrompt(t), /File status \(computed by Node/);
});

test("fails soft outside a git repository", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "no-git-"));
  assert.equal(describeAllowedPaths(task(["a.ts"]), dir), "");
});
