import { spawn } from "node:child_process";
import { withoutSecrets } from "./secret-env.mjs";
import { assertSafeQaCommand } from "./guard/protected-paths.mjs";

/** Runs the task's check command, without secrets in the environment. Every caller gets the same command check. */
export async function runCheckCommand(command, cwd, { stateDir } = {}) {
  assertSafeQaCommand({ workspace: cwd, stateDir, command });
  return runCommand(command, cwd);
}

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", command]
      : ["-c", command];
    const child = spawn(shell, args, {
      cwd,
      env: { ...withoutSecrets(), CODEX_QA: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, output }));
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

  const result = await runCommand(task.qaCommand, workspace);
  const afterQa = await inspectGitBoundary({ task, workspace, baselineHead });
  if (afterQa) return { pass: false, output: afterQa };
  return { pass: result.exitCode === 0, output: result.output };
}
