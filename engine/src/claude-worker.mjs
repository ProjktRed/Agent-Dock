import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexUsageLimitError, CodexWorker, codexOutputSchema, parseCodexResult } from "./codex-worker.mjs";
import { CLAUDE_AUTH_ENV, withoutSecrets } from "./secret-env.mjs";
import {installProtection} from './guard/install-protection.mjs';
import {claudeSkillArgs} from './skill-isolation.mjs';

// Claude Code CLI as the orchestrator: Sonnet assesses/QA/resolves, Opus elevates.
export const CLAUDE_MODELS = { assessment: "sonnet", qa: "sonnet", resolver: "sonnet", elevate: "opus", reasoning: "medium" };
const CODEX_DEFAULT_LABELS = new Set(["gpt-6.1-sol", "gpt-6-astra"]);
const ROLE_LABELS = new Map([
  ["GPT-6.1 Sol Medium", "Claude Sonnet (medium effort)"],
  ["GPT-6.1 Sol", "Claude Sonnet"],
  ["GPT-6 Astra", "Claude Opus"],
  ["You are Codex performing", "You are Claude performing"],
]);
// No role gets a free shell or file editing. Only exact command prefixes are allowed;
// Node's independent scope/HEAD verification still gates every QA commit.
const shell = (prefixes) => prefixes.flatMap((p) => [`Bash(${p}:*)`, `PowerShell(${p}:*)`]);
const GIT_READ = ["git status", "git diff", "git log", "git show", "git rev-parse", "git ls-files", "git branch"];
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", ...shell(GIT_READ)];
const QA_TOOLS = [...READ_ONLY_TOOLS, ...shell([
  "npm test", "npm run test", "npm run typecheck", "npm run lint", "npm run build", "npm run format:check",
  "npx vitest run", "npx playwright test", "npx prettier --check", "git add", "git commit",
])];
const NEVER_TOOLS = ["Edit", "Write", "NotebookEdit", "Agent", "WebFetch", "WebSearch"];
const limitText = /(usage limit|limit reached|hit your (?:usage )?limit|rate[ -]limit|credit balance is too low|resets? (?:at|in))/i;

/** Child sessions must not inherit the launching Claude session's host/session wiring. */
export function claudeChildEnv(env = process.env) {
  return Object.fromEntries(Object.entries(withoutSecrets(env, { keep: CLAUDE_AUTH_ENV })).filter(([key]) => !/^CLAUDE(?:CODE$|_)/.test(key)));
}

export function relabelPrompt(prompt) {
  let text = prompt;
  for (const [from, to] of ROLE_LABELS) text = text.split(from).join(to);
  return text;
}

export function extractClaudeResult(stdout) {
  let envelope;
  try { envelope = JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1)); }
  catch { throw new Error("Claude returned no JSON result envelope: " + String(stdout).slice(-2000)); }
  const text = typeof envelope.result === "string" ? envelope.result : "";
  if (envelope.is_error) {
    if (limitText.test(text)) throw new CodexUsageLimitError({ message: text, retryAt: text.match(/resets?[^.\n]*/i)?.[0] ?? null });
    throw new Error("Claude run failed: " + (text || envelope.subtype || "unknown error"));
  }
  if (envelope.structured_output !== undefined && envelope.structured_output !== null) return JSON.stringify(envelope.structured_output);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

export class ClaudeWorker extends CodexWorker {
  constructor({ claudeCommand = "claude", timeoutMs = 45 * 60_000, env = process.env, ...rest }) {
    super({ ...rest, command: claudeCommand });
    this.timeoutMs = timeoutMs;
    this.env = claudeChildEnv(env);
    this.pidFile = path.join(this.stateDir, "codex-process.json"); // same single-orchestrator lock as Codex
  }

  async invoke(prompt, sandbox = "read-only", { model, reasoningEffort, fast = false, schema = codexOutputSchema, parse = parseCodexResult } = {}) {
    await this.assertIdle();
    const invocation = path.join(this.stateDir, "codex", randomUUID());
    await mkdir(invocation, { recursive: true });
    const text = relabelPrompt(prompt);
    await writeFile(path.join(invocation, "schema.json"), JSON.stringify(schema));
    await writeFile(path.join(invocation, "prompt.txt"), text);
    const writable = sandbox !== "read-only";
    // Codex default labels (orchestrator models never configured) map to the Claude defaults:
    // elevation is Opus, every other role Sonnet. Any other model (per-role override) is used as given.
    if (!model || CODEX_DEFAULT_LABELS.has(model)) model = model === "gpt-6-astra" ? CLAUDE_MODELS.elevate : CLAUDE_MODELS.assessment;
    reasoningEffort ||= CLAUDE_MODELS.reasoning;
    const protectionArgs=await installProtection({cli:'claude',workspace:this.workspace,stateDir:this.stateDir,invocation,allowGitCommit:writable,fast});
    const args = [...this.prefixArgs, "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema),
      "--no-session-persistence", "--strict-mcp-config", ...claudeSkillArgs, "--permission-mode", "dontAsk",
      ...(model ? ["--model", model] : []), ...(reasoningEffort ? ["--effort", reasoningEffort] : []),
      // Fast mode needs an explicit opt-in outside the interactive CLI (flag settings fastMode).
      ...protectionArgs,
      "--allowedTools", ...(writable ? QA_TOOLS : READ_ONLY_TOOLS),
      "--disallowedTools", ...NEVER_TOOLS,
      ...(writable ? this.additionalWritableDirs.flatMap((dir) => ["--add-dir", dir]) : [])];
    this.activeCount++;
    let stdout = "", stderr = "";
    try {
      await new Promise((resolve, reject) => {
        const child = this.spawnProcess(this.command, args, { cwd: this.workspace, env: this.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let registered = false, closed = false, closeCode = 1, registrationError = null, finished = false, timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, this.timeoutMs);
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.stdin.on("error", () => {});
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        const finishClosed = async () => {
          if (finished || !closed || (!registered && !registrationError)) return;
          finished = true;
          clearTimeout(timer);
          try {
            if (registered) await this.clearProcessState(this.pidFile);
            if (registrationError) return reject(new Error(`Failed to register Claude process: ${registrationError.message}`));
            if (timedOut) return reject(new Error(`Claude exceeded ${Math.round(this.timeoutMs / 60000)} minutes and was stopped`));
            const resultText = extractClaudeResult(stdout); // throws usage-limit / failure with its message
            await writeFile(path.join(invocation, "result.json"), resultText);
            if (closeCode !== 0) return reject(new Error("Claude exited with code " + closeCode + ": " + (stderr || stdout).slice(-4000)));
            resolve();
          } catch (error) { reject(error); }
        };
        // Like Codex: resolve only on 'close' (process exited and stdio closed).
        child.on("close", (code) => { closed = true; closeCode = code ?? 1; void finishClosed(); });
        void (async () => {
          try {
            if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error("spawned child has no PID");
            await this.writeProcessState(this.pidFile, { pid: child.pid, startedAt: new Date().toISOString(), command: this.command, orchestrator: "claude", model });
            registered = true;
            if (!closed) child.stdin.end(text);
          } catch (error) {
            registrationError = error;
            child.stdin.destroy();
            if (!closed) child.kill();
          }
          void finishClosed();
        })();
      });
    } finally {
      this.activeCount--;
      await writeFile(path.join(invocation, "events.ndjson"), [stdout, stderr].filter(Boolean).join("\n"));
    }
    return parse(await readFile(path.join(invocation, "result.json"), "utf8"));
  }
}

/** Fails before any loop work if the CLI is missing or not logged in. */
export function preflightClaude(command = "claude", env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["auth", "status"], { env: claudeChildEnv(env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("error", (error) => reject(new Error(`Claude preflight could not execute ${command}: ${error.message}`)));
    child.on("close", (code) => {
      let status = null;
      try { status = JSON.parse(output); } catch { /* text output */ }
      const loggedIn = status ? status.loggedIn === true : code === 0 && !/not logged in/i.test(output);
      if (loggedIn) resolve({ command, auth: status?.authMethod ?? "logged-in" });
      else reject(new Error(`Claude CLI is not logged in (${command}). Run \`claude\` once in a terminal and complete /login.`));
    });
  });
}
