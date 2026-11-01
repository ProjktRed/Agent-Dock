import { spawn } from "node:child_process";
import { checkEnv, withoutSecrets } from "./secret-env.mjs";
import { assertSafeQaCommand } from "./guard/protected-paths.mjs";
import { appendBounded, CHECK_TIMEOUT_MS, killProcessTree as killTree } from "./process-bounds.mjs";
import { checksSandboxed, sandboxedSpawn } from "./sandbox.mjs";

/** Runs the task's check command, without secrets in the environment. Every caller gets the same command check. */
export async function runCheckCommand(command, cwd, { stateDir, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  assertSafeQaCommand({ workspace: cwd, stateDir, command });
  return runCommand(command, cwd, { timeoutMs, check: true });
}

/**
 * PowerShell finds npm.ps1 before npm.cmd, and Windows' default execution policy (Restricted) refuses to
 * run it: a check would fail before it starts. npm.cmd and npx.cmd are the same commands without a script.
 */
export function windowsShims(command) {
  return command.replace(/(^|[;&|]\s*)(npm|npx)(?=\s|$)/gi, (_, before, name) => `${before}${name.toLowerCase()}.cmd`);
}

/**
 * A check runs only tools the project already has: plain npx downloads and runs a package it cannot find
 * (a mistyped or hijacked name included), so every npx in a check gets --no-install.
 */
export function noInstall(command) {
  return command.replace(/(^|[;&|]\s*)(npx(?:\.cmd)?)(?=\s)(?!\s+--no-install(?=\s|$))/gi, "$1$2 --no-install");
}

/** The shell for one command; a check (project code) runs in the sandbox when Settings › Experimental says so. */
async function launchFor(command, cwd, check) {
  const windows = process.platform === "win32";
  const text = windows ? windowsShims(noInstall(command)) : noInstall(command);
  if (check && checksSandboxed()) return sandboxedSpawn(text, cwd, { windowsShell: "powershell", env: { CODEX_QA: "1" } });
  return {
    file: windows ? "powershell.exe" : "/bin/sh",
    args: windows ? ["-NoProfile", "-NonInteractive", "-Command", text] : ["-c", text],
    env: { ...(check ? checkEnv() : withoutSecrets()), CODEX_QA: "1" },
    release() {},
  };
}

/** timeoutMs > 0: a command still running then is ended, and fails with timedOut set. */
async function runCommand(command, cwd, { timeoutMs = 0, check = false } = {}) {
  const launch = await launchFor(command, cwd, check);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(launch.file, launch.args, { cwd, env: launch.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { launch.release(); reject(error); return; }
    let output = "", timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output = appendBounded(output, chunk)));
    child.stderr.on("data", (chunk) => (output = appendBounded(output, chunk)));
    child.on("error", (error) => { if (timer) clearTimeout(timer); launch.release(); reject(error); });
    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      launch.release();
      if (timedOut) resolve({ exitCode: 1, timedOut: true, output: `${output}
The check was ended after ${Math.round(timeoutMs / 60_000) || "<1"} minutes without finishing.` });
      else resolve({ exitCode: exitCode ?? 1, output });
    });
  });
}

export async function captureGitBaseline(workspace) {
  const head = await runCommand("git rev-parse HEAD", workspace);
  if (head.exitCode !== 0) throw new Error(`QA requires a git repository.\n${head.output}`);
  const status = await runCommand("git -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all", workspace);
  if (status.exitCode !== 0 || status.output.trim()) {
    throw new Error(`QA requires a clean git workspace before Cline starts.\n${status.output}`);
  }
  return { head: head.output.trim() };
}

async function inspectGitBoundary({ task, workspace, baselineHead }) {
  if (!Array.isArray(task.allowedPaths)) return null;
  if (baselineHead) {
    const head = await runCommand("git rev-parse HEAD", workspace);
    if (head.exitCode !== 0 || head.output.trim() !== baselineHead) {
      return `QA FAIL: git HEAD changed during Cline implementation. Expected ${baselineHead}, received ${head.output.trim()}. Cline must not commit.`;
    }
  }

  const status = await runCommand("git -c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all", workspace);
  if (status.exitCode !== 0) return `QA could not inspect the git diff.\n${status.output}`;
  const records = status.output.split("\0").filter(Boolean);
  const changed = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const statusCode = record.slice(0, 2);
    changed.push(record.slice(3).replaceAll("\\", "/"));
    if (/[RC]/.test(statusCode) && records[index + 1]) {
      changed.push(records[index + 1].replaceAll("\\", "/"));
      index += 1;
    }
  }
  const allowed = new Set(task.allowedPaths.map((entry) => entry.replaceAll("\\", "/")));
  const unexpected = changed.filter((entry) => !allowed.has(entry));
  return unexpected.length
    ? `QA FAIL: changes outside Codex-approved paths:\n${unexpected.join("\n")}`
    : null;
}

export async function runQaCommand({ task, workspace, baselineHead, workerResult }) {
  if (workerResult.exitCode !== 0) {
    return {
      pass: false,
      output: `Cline exited with code ${workerResult.exitCode}.\n${workerResult.output}`,
    };
  }

  const beforeQa = await inspectGitBoundary({ task, workspace, baselineHead });
  if (beforeQa) return { pass: false, output: beforeQa };

  const result = await runCommand(task.qaCommand, workspace, { check: true });
  const afterQa = await inspectGitBoundary({ task, workspace, baselineHead });
  if (afterQa) return { pass: false, output: afterQa };
  return { pass: result.exitCode === 0, output: result.output };
}
