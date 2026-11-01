import type { CiBucket, CiCheck, CiState } from "@shared/types";
import { run } from "./git";

// GitHub CI: after the app pushes a run branch, it reads that commit's GitHub Actions runs with GitHub CLI,
// signed in as you (gh auth login). The app stores no GitHub token; without gh it shows why it cannot read CI.

/** Polling interval while a commit's runs are pending, and how long before the app stops waiting. */
export const CI_POLL_MS = 60_000;
export const CI_GIVE_UP_MS = 6 * 60 * 60_000;
/** Right after a push GitHub may not list the runs yet: "none" counts as pending this long. */
export const CI_REGISTER_MS = 3 * 60_000;

export type Runner = typeof run;

interface GhRun { databaseId?: number; name?: string; workflowName?: string; status?: string; conclusion?: string; url?: string; headSha?: string; event?: string }

const bucketOf = (r: GhRun): CiBucket => {
  if (r.status !== "completed") return "pending";
  switch (r.conclusion) {
    case "success": return "pass";
    case "skipped": case "neutral": return "skipping";
    case "cancelled": case "stale": return "cancel";
    default: return "fail";
  }
};

/** The Actions runs of one commit, from gh run list --json output. */
export function parseRuns(stdout: string, sha: string): CiCheck[] {
  let list: unknown;
  try { list = JSON.parse(stdout); } catch { throw new Error("GitHub CLI returned output Agent Dock could not read."); }
  if (!Array.isArray(list)) throw new Error("GitHub CLI returned output Agent Dock could not read.");
  return (list as GhRun[])
    .filter((r) => r && typeof r === "object" && String(r.headSha ?? "") === sha)
    .map((r) => ({ id: Number(r.databaseId) || 0, name: String(r.name ?? r.workflowName ?? "run"), workflow: String(r.workflowName ?? ""), bucket: bucketOf(r), url: typeof r.url === "string" && /^https:\/\/github\.com\//.test(r.url) ? r.url : null, event: typeof r.event === "string" && /^[a-z_]{1,40}$/.test(r.event) ? r.event : null }));
}

/** One state for all of a commit's runs: a failure wins, then anything still running. */
export function summarize(checks: CiCheck[]): CiState {
  if (checks.some((c) => c.bucket === "fail")) return "fail";
  if (checks.some((c) => c.bucket === "pending")) return "pending";
  if (checks.some((c) => c.bucket === "pass")) return "pass";
  if (checks.some((c) => c.bucket === "cancel")) return "cancelled";
  return "none";
}

export const isFinal = (state: CiState) => state === "pass" || state === "fail" || state === "cancelled";

const ghProblem = (text: string) =>
  /gh auth login|not logged|authentication/i.test(text) ? "GitHub CLI is not signed in. Run gh auth login, then Refresh."
    : /could not resolve to a repository|not found/i.test(text) ? "GitHub CLI cannot see this repository with your sign-in."
      : `GitHub CLI could not read the runs: ${text.trim().split(/\r?\n/).pop() ?? "unknown error"}`;

/** The runs for a pushed commit: { state, checks, message }. Never throws; a problem is "unavailable" with the reason. */
export async function readCi(opts: { gh: string | null; repo: string; branch: string; sha: string; pushedAt: string; cwd: string; now?: number; runner?: Runner }): Promise<{ state: CiState; checks: CiCheck[]; message: string | null }> {
  if (!opts.gh) return { state: "unavailable", checks: [], message: "Install GitHub CLI (gh) and run gh auth login to see CI results here." };
  const r = await (opts.runner ?? run)(opts.gh, ["run", "list", "--repo", opts.repo, "--branch", opts.branch, "--limit", "30", "--json", "databaseId,name,workflowName,status,conclusion,url,headSha,event"], { cwd: opts.cwd, timeoutMs: 60_000 });
  if (r.code !== 0) return { state: "unavailable", checks: [], message: ghProblem(r.stderr || r.stdout) };
  let checks: CiCheck[];
  try { checks = parseRuns(r.stdout, opts.sha); } catch (error) { return { state: "unavailable", checks: [], message: (error as Error).message }; }
  const state = summarize(checks);
  if (state !== "none") return { state, checks, message: null };
  const young = (opts.now ?? Date.now()) - Date.parse(opts.pushedAt) < CI_REGISTER_MS;
  return young ? { state: "pending", checks, message: "Waiting for GitHub to start the workflows." } : { state: "none", checks, message: "No GitHub Actions runs for this commit. The repository may have no workflow for this branch." };
}
