import { run } from "./git";

// Pull-request mode: a project's run works on its own branch (agent-dock/run-YYYYMMDD-HHMM) instead of
// the branch you had checked out. Nothing leaves the computer until you press "Open pull request",
// which pushes that branch and opens the pull request with GitHub CLI, or GitHub's compare page
// (on GitLab: a merge request, opened by the push itself or on GitLab's new merge request page).

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

/** Host and project path for a GitLab remote: gitlab.com, or a self-managed host whose name contains "gitlab". */
export function gitlabRepo(remoteUrl: string): { host: string; path: string } | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([\w.-]*gitlab[\w.-]*)(?::\d+)?[/:]((?:[\w.-]+\/)+[\w.-]+?)(?:\.git)?\/?$/i.exec(String(remoteUrl).trim());
  return m ? { host: m[1].toLowerCase(), path: m[2] } : null;
}

export const newMergeRequestUrl = (repo: { host: string; path: string }, base: string, head: string) =>
  `https://${repo.host}/${repo.path}/-/merge_requests/new?${new URLSearchParams({ "merge_request[source_branch]": head, "merge_request[target_branch]": base })}`;

/** Push options make GitLab open the merge request itself; they carry no line breaks. */
const mergeRequestOptions = (base: string, title: string) =>
  ["merge_request.create", `merge_request.target=${base}`, `merge_request.title=${title.replace(/[\r\n]+/g, " ").slice(0, 200)}`].flatMap((o) => ["-o", o]);

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
export async function openPullRequest(cwd: string, base: string, title: string, body: string, gh: string | null): Promise<{ url: string; created: boolean; branch: string; sha: string; repo: string | null }> {
  const branch = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  if (!branch.startsWith(PR_BRANCH_PREFIX)) throw new Error(`The project is on ${branch}, not an Agent Dock run branch.`);
  const ahead = Number(await git(cwd, "rev-list", "--count", `${base}..${branch}`).catch(() => "0"));
  if (!ahead) throw new Error(`${branch} has no commits that ${base} lacks yet.`);
  const remote = await git(cwd, "remote", "get-url", "origin");
  // GitLab: the push itself opens the merge request (push options), so no GitLab CLI is needed. A server
  // that does not take push options gets a plain push, and GitLab's new merge request page finishes it.
  const gitlab = gitlabRepo(remote);
  if (gitlab) {
    let r = await run("git", ["push", ...mergeRequestOptions(base, title), "-u", "origin", branch], { cwd, timeoutMs: 120_000 });
    if (r.code !== 0 && /push options/i.test(r.stderr)) r = await run("git", ["push", "-u", "origin", branch], { cwd, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`git push failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).pop()}`);
    const sha = await git(cwd, "rev-parse", "HEAD");
    const url = (r.stderr + r.stdout).match(/https:\/\/\S+\/-\/merge_requests\/\d+/)?.[0];
    return url ? { url, created: true, branch, sha, repo: null } : { url: newMergeRequestUrl(gitlab, base, branch), created: false, branch, sha, repo: null };
  }
  await git(cwd, "push", "-u", "origin", branch);
  const sha = await git(cwd, "rev-parse", "HEAD");
  const repo = githubRepo(remote);
  if (gh && repo) {
    const r = await run(gh, ["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", title, "--body", body], { cwd, timeoutMs: 120_000 });
    const url = r.stdout.trim().split(/\r?\n/).find((l) => /^https:\/\/github\.com\//.test(l));
    if (r.code === 0 && url) return { url, created: true, branch, sha, repo };
    const existing = (r.stderr + r.stdout).match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
    if (existing) return { url: existing, created: false, branch, sha, repo };
  }
  if (!repo) throw new Error(`Pushed ${branch}. The remote is not on GitHub or GitLab, so open the pull request on your Git host.`);
  return { url: compareUrl(repo, base, branch), created: false, branch, sha, repo };
}

/** The CI fix loop: pushes the run branch again when a fix run added commits. Returns the new HEAD, or null when nothing is new. */
export async function pushRunBranch(cwd: string, branch: string, pushedSha: string): Promise<string | null> {
  const current = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  if (current !== branch) throw new Error(`The project is on ${current}, not ${branch}, so the fix was not pushed.`);
  const sha = await git(cwd, "rev-parse", "HEAD");
  if (sha === pushedSha) return null;
  await git(cwd, "push", "origin", branch);
  return sha;
}
