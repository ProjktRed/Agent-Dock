import { execFile, spawn } from "node:child_process";
import { readFile, stat, lstat, readlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson } from "./dashboard-state.mjs";
import { withoutSecrets } from "./secret-env.mjs";

const exec = promisify(execFile);
const OUTPUT_LIMIT = 12_000;
const DIFF_LIMIT = 200_000;

function bounded(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return { text: value, truncated: false };
  const half = Math.floor((limit - 80) / 2);
  return { text: `${value.slice(0, half)}\n... output truncated ...\n${value.slice(-half)}`, truncated: true };
}

export function classifyQaCommand(command) {
  const normalized = command.trim();
  if (/^npm(?:\.cmd)?\s+(?:run\s+)?test(?:\b|:)/i.test(normalized)) return "tests";
  if (/^npm(?:\.cmd)?\s+run\s+typecheck\b/i.test(normalized)) return "typecheck";
  if (/^npm(?:\.cmd)?\s+run\s+lint\b/i.test(normalized)) return "lint";
  if (/^npm(?:\.cmd)?\s+run\s+build\b/i.test(normalized)) return "build";
  return null;
}

function simpleChain(command) {
  const parts = command.split(/\s*&&\s*/);
  return parts.length > 1 && parts.every(part => /^(?:npm(?:\.cmd)?|git)\s+[\w .:/\\-]+$/i.test(part)) ? parts : null;
}

export function qaCategories(command, result) {
  const categories = { tests: "NOT RUN", typecheck: "NOT RUN", lint: "NOT RUN", build: "NOT RUN" };
  if (result.steps) {
    for (const step of result.steps) {
      const category = classifyQaCommand(step.command);
      if (!category) continue;
      const current = categories[category];
      if (current === "FAIL" || current === "INCONCLUSIVE") continue;
      if (step.status === "NOT RUN" && current === "PASS") categories[category] = "INCONCLUSIVE";
      else categories[category] = step.status;
    }
  } else {
    const category = classifyQaCommand(command);
    if (category) categories[category] = /&&|\|\||[;|]/.test(command) ? "INCONCLUSIVE" : result.exitCode === 0 ? "PASS" : "FAIL";
  }
  return categories;
}

export async function runDeterministicCommand(command, cwd) {
  const chain = simpleChain(command);
  if (!chain) return runShellCommand(command, cwd);
  const started = Date.now();
  const steps = [];
  let exitCode = 0, stdout = "", stderr = "";
  for (const stepCommand of chain) {
    if (exitCode !== 0) {
      steps.push({ command: stepCommand, status: "NOT RUN", exitCode: null, durationMs: 0 });
      continue;
    }
    const result = await runShellCommand(stepCommand, cwd);
    exitCode = result.exitCode;
    stdout += result.stdout;
    stderr += result.stderr;
    steps.push({ command: stepCommand, status: exitCode === 0 ? "PASS" : "FAIL", exitCode, durationMs: result.durationMs });
  }
  return { exitCode, stdout, stderr, steps, durationMs: Date.now() - started };
}

function runShellCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const executable = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    const child = spawn(executable, args, {
      cwd, env: { ...withoutSecrets(), CODEX_QA: "1" }, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({
      exitCode: exitCode ?? 1, stdout, stderr, durationMs: Date.now() - started,
    }));
  });
}

async function git(workspace, args) {
  try {
    const result = await exec("git", args, { cwd: workspace, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { exitCode: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

function parseStatus(output) {
  const records = output.split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const code = record.slice(0, 2);
    files.push(record.slice(3).replaceAll("\\", "/"));
    if (/[RC]/.test(code) && records[index + 1]) files.push(records[++index].replaceAll("\\", "/"));
  }
  return [...new Set(files)].sort();
}

function splitTaskPrompt(task) {
  if (Array.isArray(task.acceptanceCriteria)) return { objective: task.objective ?? task.prompt, acceptanceCriteria: task.acceptanceCriteria };
  const marker = /\n\s*Codex review criteria:\s*\n/i;
  const parts = String(task.prompt ?? "").split(marker);
  if (parts.length < 2) return { objective: task.objective ?? task.prompt, acceptanceCriteria: [] };
  const acceptanceCriteria = parts.slice(1).join("\n").split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  return { objective: task.objective ?? parts[0].trim(), acceptanceCriteria };
}

export async function collectGitEvidence({ workspace, task, baselineSha }) {
  const [head, status] = await Promise.all([
    git(workspace, ["rev-parse", "HEAD"]),
    git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  const changedFiles = status.exitCode === 0 ? parseStatus(status.stdout) : [];
  const allowed = new Set(task.allowedPaths.map((item) => item.replaceAll("\\", "/")));
  const unexpectedPaths = changedFiles.filter((item) => !allowed.has(item));
  let scopeStatus = "PASS";
  let scopeMessage = "All changed paths are approved.";
  if (head.exitCode !== 0 || status.exitCode !== 0) {
    scopeStatus = "NOT RUN";
    scopeMessage = "Git scope validation could not run.";
  } else if (head.stdout.trim() !== baselineSha || unexpectedPaths.length) {
    scopeStatus = "FAIL";
    scopeMessage = head.stdout.trim() !== baselineSha
      ? `HEAD differs from baseline ${baselineSha}.`
      : `Changes outside allowedPaths: ${unexpectedPaths.join(", ")}`;
  }

  const scoped = changedFiles.filter((item) => allowed.has(item));
  const trackedDiff = scoped.length
    ? await git(workspace, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--", ...scoped])
    : { exitCode: 0, stdout: "", stderr: "" };
  let diffText = trackedDiff.stdout;
  for (const file of scoped) {
    const fullPath = path.resolve(workspace, file);
    const relative = path.relative(workspace, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const details = await stat(fullPath).catch(() => null);
    if (!details?.isFile()) continue;
    const tracked = await git(workspace, ["ls-files", "--error-unmatch", "--", file]);
    if (tracked.exitCode === 0) continue;
    const content = await readFile(fullPath, "utf8").catch(() => "[binary or unreadable]");
    diffText += `\n--- /dev/null\n+++ b/${file}\n${content}`;
  }
  const originalBytes = Buffer.byteLength(diffText);
  const limited = bounded(diffText, DIFF_LIMIT);
  return {
    changedFiles,
    diff: { text: limited.text, bytes: originalBytes, truncated: limited.truncated },
    scope: { status: scopeStatus, unexpectedPaths, message: scopeMessage },
  };
}

function conciseClineSummary(workerResult) {
  const runResult = workerResult.runResult ?? {};
  const source = workerResult.summary ?? runResult.summary ?? runResult.text ?? "No structured completion summary was provided.";
  return {
    exitCode: workerResult.exitCode,
    finishReason: runResult.finishReason ?? null,
    text: bounded(source, 2_000).text,
  };
}

/** Hash tracked and non-ignored input files, including unchanged dependencies in the repository. */
export async function workspaceFingerprint(workspace) {
  const [head, index, untracked] = await Promise.all([
    git(workspace, ["rev-parse", "HEAD"]),
    git(workspace, ["ls-files", "--stage", "-z"]),
    git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if ([head, index, untracked].some(result => result.exitCode !== 0)) return null;
  const tracked = index.stdout.split("\0").filter(Boolean).map(record => record.slice(record.indexOf("\t") + 1));
  const files = [...new Set([...tracked, ...untracked.stdout.split("\0").filter(Boolean)])].sort();
  const hash = createHash("sha256").update(head.stdout).update(index.stdout);
  for (const file of files) {
    const fullPath = path.resolve(workspace, file);
    const relative = path.relative(workspace, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    hash.update(JSON.stringify(file));
    const details = await lstat(fullPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!details) { hash.update("missing"); continue; }
    if (details.isSymbolicLink()) hash.update("link:" + await readlink(fullPath));
    else if (details.isFile()) {
      const content = createHash("sha256");
      for await (const chunk of createReadStream(fullPath)) content.update(chunk);
      hash.update("file:" + content.digest("hex"));
    } else hash.update("directory");
  }
  return hash.digest("hex");
}

/** Legacy packets lack a fingerprint and retain the existing scope/HEAD reconciliation path. */
export async function assertQaPacketFresh(workspace, packet) {
  const expected = packet.qaEvidence?.fingerprint?.workspace;
  if (expected && expected !== await workspaceFingerprint(workspace)) {
    throw new Error("QA evidence is stale: workspace content or HEAD changed; collect fresh check results before review");
  }
}

const requestFingerprint = input => createHash("sha256").update(JSON.stringify(input)).digest("hex");

export async function prepareQaPacket({
  workspace, stateDir, task, attempt, baselineSha, workerResult,
  runCommand = runDeterministicCommand,
  previousPacket = null,
}) {
  const started = Date.now();
  const request = requestFingerprint({ task, attempt, baselineSha });
  const before = await collectGitEvidence({ workspace, task, baselineSha });
  const beforeFingerprint = await workspaceFingerprint(workspace);
  const previous = previousPacket?.qaEvidence;
  const reusable = beforeFingerprint && before.scope.status === "PASS" && previous?.fingerprint?.request === request && previous.fingerprint.workspace === beforeFingerprint && previous.workspaceStable === true && previous.command.exitCode === 0 && previous.scope.status === "PASS" && !Object.values(previous.categories).some(status => ["FAIL", "INCONCLUSIVE", "TIMEOUT", "RUNNING", "NON-TERMINATING"].includes(status));
  const commandResult = reusable ? null : await runCommand(task.qaCommand, workspace);
  const after = await collectGitEvidence({ workspace, task, baselineSha });
  const afterFingerprint = await workspaceFingerprint(workspace);
  const combined = commandResult ? [commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n").trim() : "";
  const summary = bounded(combined || "No command output.", OUTPUT_LIMIT);
  const categories = { ...(reusable ? previous.categories : qaCategories(task.qaCommand, commandResult)), scopeCheck: after.scope.status };
  const workspaceStable = Boolean(beforeFingerprint && beforeFingerprint === afterFingerprint);
  if (beforeFingerprint && !workspaceStable) {
    const category = classifyQaCommand(task.qaCommand);
    if (category && categories[category] === "PASS") categories[category] = "INCONCLUSIVE";
  }
  const prompt = splitTaskPrompt(task);
  const packet = {
    task: { id: task.id, name: task.name ?? task.id, objective: prompt.objective, allowedPaths: [...task.allowedPaths] },
    acceptanceCriteria: prompt.acceptanceCriteria,
    baselineSha,
    diff: after.diff,
    changedFiles: after.changedFiles,
    clineSummary: conciseClineSummary(workerResult),
    attempt,
    qaEvidence: {
      command: reusable ? previous.command : {
        command: task.qaCommand,
        exitCode: commandResult.exitCode,
        durationMs: commandResult.durationMs,
        summary: summary.text,
        truncated: summary.truncated,
      },
      categories,
      ...(reusable ? (previous.steps ? { steps: previous.steps } : {}) : (commandResult.steps ? { steps: commandResult.steps } : {})),
      scope: after.scope,
      durationMs: Date.now() - started,
      scopeBeforeCommand: before.scope.status,
      fingerprint: { request, workspace: afterFingerprint },
      workspaceStable,
      reused: Boolean(reusable),
    },
  };
  await atomicWriteJson(path.join(stateDir, "qa-packet.json"), packet);
  return packet;
}
