import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliConnection } from "@shared/types";
import { isGitRepo, run } from "./lib/git";
import { parseImplementationPlan, PLAN_FILE } from "./lib/plan";
import { shellLine, stopAndClean } from "./proc";

/** Planner kinds offered when creating a project: cloud CLIs read the workspace themselves; local models get a summary. */
export const PLANNER_KINDS = ["codex", "claude", "llamacpp", "ollama", "openai"] as const;
const PLAN_MAX_CHARS = 30_000;
const TIMEOUT_MS = 10 * 60_000;
const quote = (p: string) => (/[\s&()]/.test(p) && !p.startsWith('"') ? `"${p}"` : p);

export function buildPlannerPrompt(objective: string, context: string | null): string {
  return [
    "You are the planner for an automation loop. Write the project's IMPLEMENTATION_PLAN.md for this objective:",
    "", objective.trim(), "",
    context ? "The workspace was summarised for you below: its file list, manifests and the start of its most relevant source files. Plan around what already exists, and name real files in tasks where you can." : "Inspect the workspace (read-only) and plan around what already exists. Do not edit, create or delete any file.",
    "",
    "Output only the Markdown file, in exactly this structure, nothing before or after it:",
    "# Implementation plan",
    "## Phase 1 — <title>",
    "- [ ] <task>",
    "- [ ] <task>",
    "## Phase 2 — <title>",
    "- [ ] <task>",
    "",
    "Rules:",
    "- 2 to 6 phases, in build order; each phase has 2 to 8 tasks.",
    "- Each task is one small, independently verifiable change an implementation worker can finish in one attempt (a few files at most), with a clear done condition in the task text.",
    "- Mark a task done (- [x]) only if the workspace already clearly contains it.",
    "- Use plain task text: no code blocks, no extra headings, no prose paragraphs, no sub-plans.",
    ...(context ? ["", "Workspace summary:", context] : []),
  ].join("\n");
}

/** Strips code fences and chatter before the heading; ensures the expected title. */
export function cleanPlanText(raw: string): string {
  let text = String(raw).replace(/\r\n/g, "\n").trim();
  const fenced = text.match(/```(?:markdown|md)?\n([\s\S]*?)```/i);
  if (fenced && /##\s+Phase/i.test(fenced[1])) text = fenced[1].trim();
  const start = text.search(/^#\s+Implementation plan\b|^##\s+Phase\s+\d+/im);
  if (start > 0) text = text.slice(start);
  if (!/^#\s+Implementation plan/i.test(text)) text = `# Implementation plan\n\n${text}`;
  return text.slice(0, PLAN_MAX_CHARS).trimEnd() + "\n";
}

/** Null when the plan has the structure the engine reads; otherwise why not. */
export function planProblem(text: string): string | null {
  const plan = parseImplementationPlan(text);
  if (!plan.phases.length) return "No “## Phase N — Title” headings were found.";
  const empty = plan.phases.filter((p) => !p.total);
  if (empty.length) return `Phase ${empty.map((p) => p.number).join(", ")} has no “- [ ]” tasks.`;
  return null;
}

const MANIFESTS = ["README.md", "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "composer.json", "Gemfile", "pom.xml", "build.gradle"];
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|vue|svelte|html|css|scss|sql|sh|ps1|ya?ml|toml)$/i;
const SKIP = /(^|\/)(node_modules|dist|out|build|vendor|\.git|\.venv|__pycache__|coverage|fixtures?)(\/|$)|\.min\.|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|IMPLEMENTATION_PLAN\.md$/i;
const ENTRY = /(^|\/)(index|main|app|cli|server|lib|mod|__init__)\.[a-z]+$/i;
const EXCERPT_CHARS = 2_500;
const EXCERPTS_CHARS = 20_000;

/**
 * Source files a local planner should read first: entry points, files whose path names a word from the
 * objective, then shallow files. Tests and generated code come last.
 */
export function pickPlannerFiles(files: string[], objective: string, max = 12): string[] {
  const words = [...new Set(objective.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])];
  const score = (file: string) => {
    const lower = file.toLowerCase();
    let s = 0;
    if (ENTRY.test(file)) s += 6;
    s += 4 * words.filter((w) => lower.includes(w)).length;
    s -= file.split("/").length;
    if (/(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(file)) s -= 5;
    return s;
  };
  return files.filter((f) => SOURCE.test(f) && !SKIP.test(f)).map((f) => ({ f, s: score(f) })).sort((a, b) => b.s - a.s || a.f.localeCompare(b.f)).slice(0, max).map((x) => x.f);
}

/** File list, manifests and excerpts of the most relevant source files, for local planners, which cannot read the workspace themselves. */
export async function workspaceSummary(workspace: string, objective = ""): Promise<string> {
  const files: string[] = [];
  if (isGitRepo(workspace)) {
    const listed = await run("git", ["ls-files"], { cwd: workspace });
    if (listed.code === 0) files.push(...listed.stdout.split(/\r?\n/).filter(Boolean));
  }
  if (!files.length) {
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (files.length >= 300 || depth > 4) return;
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (/^(\.git|node_modules|dist|out|build|\.venv|__pycache__)$/.test(entry.name)) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath, depth + 1);
        else files.push(relPath);
      }
    };
    await walk(workspace, "", 0);
  }
  const parts = [files.length ? `Files (${files.length}${files.length > 300 ? ", first 300" : ""}):\n${files.slice(0, 300).join("\n")}` : "The workspace is empty."];
  for (const name of MANIFESTS) {
    const file = path.join(workspace, name);
    if (existsSync(file)) parts.push(`${name}:\n${(await readFile(file, "utf8").catch(() => "")).slice(0, name === "README.md" ? 6000 : 2000)}`);
  }
  let budget = EXCERPTS_CHARS;
  for (const rel of pickPlannerFiles(files, objective)) {
    if (budget <= 0) break;
    const text = await readFile(path.join(workspace, rel), "utf8").catch(() => "");
    if (!text.trim() || text.includes("\u0000")) continue;
    const excerpt = text.slice(0, Math.min(EXCERPT_CHARS, budget));
    budget -= excerpt.length;
    parts.push(`${rel}${excerpt.length < text.length ? ` (first ${excerpt.length} of ${text.length} characters)` : ""}:\n${excerpt}`);
  }
  return parts.join("\n\n");
}

export interface PlannerRun { connection: CliConnection; model: string | null; apiKey: string | null }
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

function runCli(command: string, args: string[], cwd: string, prompt: string, signal: AbortSignal, env: NodeJS.ProcessEnv, outputFile?: string, tempDir?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(shellLine(quote(command), args), { shell: true, windowsHide: true, cwd, env });
    let stdout = "", stderr = "", done = false;
    const finish = (error: Error | null, value = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        stopAndClean(child, tempDir ?? path.join(os.tmpdir(), "agent-dock-plan-none"));
        reject(error);
      } else {
        if (tempDir) void rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
        resolve(value);
      }
    };
    const abort = () => finish(new Error("Planning was cancelled."));
    const timer = setTimeout(() => finish(new Error("The planner did not finish within 10 minutes.")), TIMEOUT_MS);
    signal.addEventListener("abort", abort);
    child.on("error", (error) => finish(error));
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", async (code) => {
      if (done) return;
      const text = outputFile ? await readFile(outputFile, "utf8").catch(() => "") : stdout;
      if (code === 0 && text.trim()) finish(null, text);
      else finish(new Error(stderr.trim().split(/\r?\n/).slice(-2).join(" ") || `The planner exited with code ${code} and no plan.`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

/** One planner call; cloud CLIs run read-only in the workspace, local models get the workspace summary. */
export async function callPlanner(workspace: string, objective: string, planner: PlannerRun, signal: AbortSignal, fetchImpl: Fetch = fetch as unknown as Fetch, feedback = ""): Promise<string> {
  const { connection, model } = planner;
  const kind = connection.kind;
  if (kind === "codex" || kind === "claude") {
    const prompt = buildPlannerPrompt(objective, null) + feedback;
    const command = connection.location.trim() || kind;
    if (kind === "codex") {
      const temp = await mkdtemp(path.join(os.tmpdir(), "agent-dock-plan-"));
      const out = path.join(temp, "plan.md");
      const args = ["exec", "--ephemeral", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check", ...(model ? ["-m", model] : []), "--cd", quote(workspace), "--output-last-message", quote(out), "-"];
      return runCli(command, args, workspace, prompt, signal, process.env, out, temp);
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
    const args = ["-p", "--output-format", "text", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--permission-mode", "dontAsk", "--allowedTools", "Read", "Grep", "Glob", ...(model ? ["--model", model] : [])];
    return runCli(command, args, workspace, prompt, signal, env);
  }
  if (!["llamacpp", "ollama", "openai"].includes(kind)) throw new Error(`${connection.name} cannot be used as a planner.`);
  if (!model) throw new Error("Choose the local model that should write the plan.");
  let base = connection.location.trim().replace(/\/+$/, "");
  if (kind === "ollama" && !/\/v1$/.test(base)) base += "/v1";
  const prompt = buildPlannerPrompt(objective, await workspaceSummary(workspace, objective)) + feedback;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(planner.apiKey ? { Authorization: `Bearer ${planner.apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, stream: false }),
    signal: AbortSignal.any([signal, timeout]),
  }).catch((error: Error) => { throw new Error(signal.aborted ? "Planning was cancelled." : timeout.aborted ? "The planner did not finish within 10 minutes." : `Could not reach ${connection.name}: ${error.message}`); });
  if (!res.ok) throw new Error(`${connection.name} returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const text = (await res.json())?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error(`${connection.name} returned no text.`);
  return text;
}

/** Generates a plan; one retry with the structural problem when the first answer does not parse. */
export async function generatePlan(workspace: string, objective: string, planner: PlannerRun, signal: AbortSignal, fetchImpl?: Fetch): Promise<string> {
  if (!objective.trim()) throw new Error("Set an objective; the planner plans toward it.");
  let text = cleanPlanText(await callPlanner(workspace, objective, planner, signal, fetchImpl));
  const problem = planProblem(text);
  if (problem) {
    const feedback = `\n\nYour previous answer could not be used: ${problem} Answer again with only the plan in the exact structure above.`;
    text = cleanPlanText(await callPlanner(workspace, objective, planner, signal, fetchImpl, feedback));
    const again = planProblem(text);
    if (again) throw new Error(`The planner's answer is not a usable plan: ${again}`);
  }
  return text;
}

/** Writes the reviewed plan (never over an existing one) and, in a Git repo, commits only that file. */
export async function savePlan(workspace: string, text: string): Promise<{ committed: boolean }> {
  const plan = cleanPlanText(text);
  const problem = planProblem(plan);
  if (problem) throw new Error(problem);
  const file = path.join(workspace, PLAN_FILE);
  if (existsSync(file)) throw new Error(`${PLAN_FILE} already exists in this workspace; it was left unchanged.`);
  await writeFile(file, plan, { flag: "wx" });
  if (!isGitRepo(workspace)) return { committed: false };
  const add = await run("git", ["add", "--", PLAN_FILE], { cwd: workspace });
  const commit = add.code === 0 ? await run("git", ["commit", "-m", "Add implementation plan", "--", PLAN_FILE], { cwd: workspace }) : add;
  if (commit.code !== 0) throw new Error(`${PLAN_FILE} was written, but committing it failed (commit it yourself before starting): ${commit.stderr.trim().split(/\r?\n/).pop()}`);
  return { committed: true };
}
