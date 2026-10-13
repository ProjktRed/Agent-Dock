const shell = (prefixes) => prefixes.flatMap((p) => [`Bash(${p}:*)`, `PowerShell(${p}:*)`]);
const GIT_READ = ["git status", "git diff", "git log", "git show", "git rev-parse", "git ls-files"];
const GIT_WRITE = ["git commit", "git add", "git reset", "git checkout", "git switch", "git restore", "git stash", "git rebase", "git merge", "git push", "git tag", "git branch -d", "git branch -D", "git config"];
const CHECKS = ["npm test", "npm run test", "npm run typecheck", "npm run lint", "npx tsc", "npx eslint", "npx prettier"];

/** Claude Code enforces file scope through its own path-aware permissions. */
export function claudeImplementationTools({ task, toolGuard }) {
  const qa = task?.qaCommand?.trim();
  const paths = (task?.allowedPaths ?? []).map((p) => "./" + p.replaceAll("\\", "/").replace(/^\.\//, ""));
  const fileTools = ["Read", "Grep", "Glob", ...paths.flatMap((p) => [`Edit(${p})`, `Write(${p})`])];
  const allowed = toolGuard
    ? [...fileTools, ...shell([...GIT_READ, ...CHECKS, ...(qa ? [qa] : [])])]
    : [...fileTools, "Bash", "PowerShell"];
  const disallowed = ["Agent", "WebFetch", "WebSearch", "NotebookEdit", ...shell(GIT_WRITE)];
  return { allowed, disallowed };
}

export const adapter = {
  id: "claude",
  label: "Claude Code",
  stateSubdir: null,
  capabilities: {
    narrowsToolSchema: false, enumeratesCommands: false, postToolEvents: false,
    outOfProcessHooks: false, counters: false, editDiscipline: false,
  },
  install({ task, toolGuard, model, effort, fast }) {
    const tools = claudeImplementationTools({ task, toolGuard });
    return { launchArgs: ["--permission-mode", "dontAsk",
      ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []),
      ...(fast ? ["--settings", JSON.stringify({ fastMode: true })] : []),
      "--allowedTools", ...tools.allowed, "--disallowedTools", ...tools.disallowed] };
  },
};

export default adapter;
