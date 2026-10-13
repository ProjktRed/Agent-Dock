import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeChildEnv, extractClaudeResult } from "./claude-worker.mjs";
import { detectCodexUsageLimit } from "./codex-worker.mjs";
import claudeAdapter, { claudeImplementationTools } from "./guard/adapters/claude.mjs";
import codexAdapter, { codexScopeHookArgs } from "./guard/adapters/codex.mjs";
import { CODEX_FAIL_CLOSED } from "./guard/reasons.mjs";

// Implementation through Codex CLI or Claude Code instead of Cline. The loop treats it like the
// Cline worker: one exclusive lock, never replayed after an interruption, and every change still
// goes through Node's scope/HEAD verification and independent QA. The worker never commits.

const IMPLEMENTATION_RULES = [
  "You are the implementation worker in a bounded automation loop. Implement only the task below.",
  "Do not commit, stage, stash, reset, checkout, rebase or otherwise change git HEAD or the index. QA owns acceptance and the single task commit.",
  "Change only the task's approved paths. Do not create helper or scratch files in the repository.",
  "Run the task's check command before finishing, then reply with a short summary of what you changed and the check result.",
].join("\n");

export { claudeImplementationTools };

/**
 * The Codex PreToolUse hook (codex-scope-hook.mjs) that keeps Codex inside the task's paths while
 * it runs. The engine writes this hook itself for every run (never taken from the repository), so
 * Codex is told to run it without its interactive trust prompt: the documented purpose of
 * --dangerously-bypass-hook-trust ("automation that already vets hook sources"). Approved by the
 * user for this use.
 */
export { codexScopeHookArgs };

/** Codex used a tool (patch, shell, MCP) according to its --json events. */
export function codexUsedTools(stdout) {
  return /"type"\s*:\s*"(?:file_change|command_execution|mcp_tool_call|patch_apply|exec_command)/.test(stdout);
}

export function buildImplementationArgs({ cli, prefixArgs = [], model, effort, fast, workspace, outputFile, task, toolGuard, hookArgs = [] }) {
  if (cli === "codex") {
    return [...prefixArgs, "exec", "--ephemeral", "--json", "--color", "never",
      ...(model ? ["-m", model] : []),
      ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      ...(fast ? ["-c", `service_tier="priority"`] : []),
      ...hookArgs,
      // Same sandbox as Codex QA (workspace writes, approvals reviewed automatically); the scope hook limits changes to the task.
      "--approve-for-me", "--cd", workspace, "--output-last-message", outputFile, "-"];
  }
  const { launchArgs } = claudeAdapter.install({ task, toolGuard, model, effort, fast });
  return [...prefixArgs, "-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", ...launchArgs];
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGKILL");
}

export class CloudImplementationWorker {
  constructor({ cli, stateDir, workspace, command, prefixArgs = [], model = null, effort = null, fast = false, timeoutSeconds = 1_800, toolGuard = true, env = process.env, spawnProcess = spawn }) {
    if (!["codex", "claude"].includes(cli)) throw new Error("Implementation CLI must be codex or claude");
    this.cli = cli;
    this.stateDir = path.resolve(stateDir);
    this.workspace = path.resolve(workspace);
    this.command = command ?? cli;
    this.prefixArgs = prefixArgs;
    this.model = model;
    this.effort = effort;
    this.fast = fast;
    this.timeoutMs = timeoutSeconds * 1000;
    this.toolGuard = toolGuard;
    this.env = cli === "claude" ? claudeChildEnv(env) : env;
    this.spawnProcess = spawnProcess;
    // Same lock file as the Cline worker: one implementation at a time per state folder.
    this.lockPath = path.join(this.stateDir, "cline.busy.lock");
  }

  async isBusy() {
    try {
      const pid = Number((await readFile(this.lockPath, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); return true; } catch (error) { if (error.code !== "ESRCH") return true; }
      }
      await rm(this.lockPath, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return false;
  }

  async withExclusive(operation) {
    await mkdir(this.stateDir, { recursive: true });
    if (await this.isBusy()) return null;
    let lock;
    try { lock = await open(this.lockPath, "wx"); }
    catch (error) { if (error.code === "EEXIST") return null; throw error; }
    try {
      await lock.writeFile(`${process.pid}\n`);
      return await operation();
    } finally {
      await lock.close();
      await rm(this.lockPath, { force: true });
    }
  }

  async run(prompt, hooks = {}) {
    const onEvent = hooks.onEvent ?? (() => {});
    const invocation = path.join(this.stateDir, "codex", randomUUID());
    await mkdir(invocation, { recursive: true });
    const outputFile = path.join(invocation, "result.txt");
    const text = `${IMPLEMENTATION_RULES}\n\n${prompt}`;
    await writeFile(path.join(invocation, "prompt.txt"), text);
    // Codex: the scope hook gets this run's policy and logs every decision next to the prompt.
    let hookArgs = [];
    const hookLog = path.join(invocation, "scope-hook.ndjson");
    if (this.cli === "codex") {
      if (!hooks.task?.allowedPaths?.length) throw new Error("Codex implementation needs the task's allowed paths for its scope hook");
      const policyFile = path.join(invocation, "scope-policy.json");
      await writeFile(policyFile, JSON.stringify({ workspace: this.workspace, allowedPaths: hooks.task.allowedPaths, qaCommand: hooks.task.qaCommand ?? "", toolGuard: this.toolGuard }));
      hookArgs = codexAdapter.install({ policyFile, logFile: hookLog }).launchArgs;
    }
    const args = buildImplementationArgs({ cli: this.cli, prefixArgs: this.prefixArgs, model: this.model, effort: this.effort, fast: this.fast, workspace: this.workspace, outputFile, task: hooks.task, toolGuard: this.toolGuard, hookArgs });
    await onEvent({ type: "implementation-cli-ready", cli: this.cli, model: this.model ?? "CLI default" });
    let stdout = "", stderr = "", timedOut = false;
    const exitCode = await new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.command, args, { cwd: this.workspace, env: this.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, this.timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdin.on("error", () => {});
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); resolve(code ?? 1); });
      Promise.resolve(hooks.onStart?.({ pid: child.pid })).then(() => child.stdin.end(text), (error) => { killTree(child); reject(error); });
    });
    await writeFile(path.join(invocation, "events.ndjson"), [stdout, stderr].filter(Boolean).join("\n"));
    if (timedOut) return { exitCode: 124, runResult: { finishReason: "timeout", text: `Stopped after ${Math.round(this.timeoutMs / 60000)} minutes.` } };
    let summary = "";
    if (this.cli === "codex") {
      const decisions = (await readFile(hookLog, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      for (const blocked of decisions.filter((d) => !d.allowed)) await onEvent({ type: "implementation-scope-blocked", tool: blocked.tool, reason: blocked.reason });
      // Fail closed: tool use without a single hook decision means the scope hook did not run.
      if (codexUsedTools(stdout) && !decisions.length) throw new Error(CODEX_FAIL_CLOSED);
      const limit = detectCodexUsageLimit(stdout + "\n" + stderr);
      if (limit) throw new Error(`Implementation stopped by the Codex usage limit: ${limit.message}`);
      summary = await readFile(outputFile, "utf8").catch(() => "");
    } else {
      try { summary = extractClaudeResult(stdout); }
      catch (error) { if (error.code === "CODEX_USAGE_LIMIT") throw new Error(`Implementation stopped by the Claude usage limit: ${error.message}`); summary = error.message; return { exitCode: exitCode || 1, runResult: { finishReason: "failed", text: summary.slice(0, 2000) } }; }
    }
    const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-5).join("\n");
    return { exitCode, runResult: { finishReason: exitCode === 0 ? "completed" : "failed", text: (summary.trim() || tail || "No summary.").slice(0, 2000) } };
  }
}
