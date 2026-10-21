import { run } from "./git";

// Pull-request mode: a project's run works on its own branch (agent-dock/run-YYYYMMDD-HHMM) instead of
// the branch you had checked out. Nothing leaves the computer until you press "Open pull request",
// which pushes that branch and opens the pull request with GitHub CLI, or GitHub's compare page.

export const PR_BRANCH_PREFIX = "agent-dock/";

export function runBranchName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${PR_BRANCH_PREFIX}run-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** owner/name for a GitHub remote (https or ssh), or null for anything else. */
export function githubRepo(remoteUrl: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(remoteUrl).trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export const compareUrl = (repo: string, base: string, head: string) =>
  `https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;

const git = async (cwd: string, ...args: string[]) => {
  const r = await run("git", args, { cwd, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).pop()}`);
  return r.stdout.trim();
};

/**
 * Before a start in pull-request mode: stay on an existing agent-dock/ branch, otherwise create a new
 * run branch from the current HEAD. Returns the branch and the base it came from.
 */
export async function ensureRunBranch(cwd: string, previousBase: string | null, now = new Date()): Promise<{ branch: string; base: string; created: boolean }> {
  const current = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  if (current === "HEAD") throw new Error("Pull-request mode needs a checked-out branch, not a detached HEAD.");
  if (current.startsWith(PR_BRANCH_PREFIX)) return { branch: current, base: previousBase ?? "main", created: false };
  const branch = runBranchName(now);
  await git(cwd, "switch", "-c", branch);
  return { branch, base: current, created: true };
}

/** Pushes the run branch and opens the pull request; returns its URL (or the compare page to finish it). */
export async function openPullRequest(cwd: string, base: string, title: string, body: string, gh: string | null): Promise<{ url: string; created: boolean }> {
  const branch = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  if (!branch.startsWith(PR_BRANCH_PREFIX)) throw new Error(`The project is on ${branch}, not an Agent Dock run branch.`);
  const ahead = Number(await git(cwd, "rev-list", "--count", `${base}..${branch}`).catch(() => "0"));
  if (!ahead) throw new Error(`${branch} has no commits that ${base} lacks yet.`);
  const remote = await git(cwd, "remote", "get-url", "origin");
  await git(cwd, "push", "-u", "origin", branch);
  const repo = githubRepo(remote);
  if (gh && repo) {
    const r = await run(gh, ["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", title, "--body", body], { cwd, timeoutMs: 120_000 });
    const url = r.stdout.trim().split(/\r?\n/).find((l) => /^https:\/\/github\.com\//.test(l));
    if (r.code === 0 && url) return { url, created: true };
    const existing = (r.stderr + r.stdout).match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
    if (existing) return { url: existing, created: false };
  }
  if (!repo) throw new Error(`Pushed ${branch}. The remote is not on GitHub, so open the pull request on your Git host.`);
  return { url: compareUrl(repo, base, branch), created: false };
}
