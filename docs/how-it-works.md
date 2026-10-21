# How it works

Where each number in Agent Dock comes from, and how the loop's roles, limits and safeguards behave.

## Usage limits

All **Reported** by the provider's own CLI, with an "as of" time.

- **Codex**: the official app-server method `account/rateLimits/read` (`codex app-server` over
  stdio, `initialize` + one read). Plan, 5-hour and weekly windows (used %, reset time), credits and
  reset-credit count. Read-only and free; refreshed every 5 minutes by default. The reset-credit
  *consume* method is never called.
- **Claude Code**: first the limits Claude Code itself reported during a recent engine run (every
  engine call reads its `rate_limit_event` and saves it as `claude-rate-limit.json` in the project's
  state folder; used when under 15 minutes old, or 2 minutes for a manual Refresh). No extra call is
  made then. Otherwise, the SDK control request `get_usage` (`skip_behaviors: true`, after `initialize`)
  over `claude -p --input-format stream-json`. Claude Code fetches the numbers itself, so no prompt
  is sent and Agent Dock never handles its login token. Plan, 5-hour and weekly windows (plus
  per-model weekly windows when the plan has them), extra usage and this week's split by product.
  Free; refreshed every 5 minutes by default. Hooks are off for that session. `get_usage` is not in
  Claude's public docs, so if it is unavailable a **manual** Refresh falls back to one minimal Haiku
  request and reads its `rate_limit_event`; automatic refreshes never fall back.
- The last snapshots are cached in `config\limits.json`; a failed refresh keeps the last good
  snapshot and shows the error. You can also add a monthly token budget, shown as **Manual**.

## Tokens and models

- **Tokens**: Codex `turn.completed` usage and Claude Code `result` usage from each invocation under
  `<state>\codex\`, plus llama.cpp `/metrics` samples the engine logs per Cline attempt. Local tokens count toward
  Unattended token budgets: llama.cpp's counters, or for Ollama the usage Cline reports at the end
  of each attempt. **Spend** is the cost a CLI reports (Claude Code, OpenCode, Cline on a cloud
  provider). Codex reports only tokens, so its cost is **estimated** from Settings › Execution & safety ›
  **Price table** (per million input, cached input and output tokens) for the models listed there, and
  not counted for any other model. Local model servers are never priced. On a subscription the
  figure is an estimate at the prices entered, not your bill.
  The current context occupancy is not reported by any runtime, so it is not shown as a number.
- **Model limits**: llama.cpp `/props` and Ollama `/api/show` context sizes are **Reported**;
  otherwise **Not exposed**.
- **Orchestrator models**: listed by the CLI itself, free, no prompt sent. Codex: app-server
  `model/list` (efforts, default effort, Fast service tier `priority`). Claude Code: the SDK
  `initialize` control request (models, effort levels, fast-mode support, and whether fast mode is
  available on the account). Cached in `config\models.json`, refreshed daily or with the refresh
  button in Agents. Fast runs pass `-c service_tier="priority"` (Codex) or the `fastMode` flag
  setting (Claude Code).
- **Local models**: collected from the provider itself and stored on the connection (first setup
  offers it; CLIs › Models › Refresh updates it). Ollama: `/api/tags` + `/api/show` (context and the
  `thinking` capability); needs Ollama running. llama.cpp: `/v1/models`. With a models folder set,
  llama.cpp runs in router mode (`--models-dir`): it lists every model in the folder (one per
  subfolder) and loads the Implementation agent's model on demand. When the server isn't running,
  Agent Dock starts it: `llama-server` from PATH on the connection's address, or a launcher script
  set in Settings › Advanced. Refresh starts it just for the listing (no model is loaded) and stops
  it again. Without a folder, start llama.cpp yourself with the model you want. The engine always
  uses the connection's address (`--llamacpp-url`, `--ollama-url`). A local model has no default:
  each Implementation agent names its own.
- **Thinking (Implementation)**: passed to Cline `--thinking`. For llama.cpp, a level other than Off
  also starts the server with `--reasoning on --reasoning-effort <level>` (only when Agent Dock
  starts it; a running server keeps its setting). Speed tiers do not apply to local models.
- **Capabilities**: detected from each CLI's own `--help` output, never assumed.
- **First launch**: a new install registers only the CLIs and local model servers found on PATH and
  local ports, and builds its first agents from them (Codex before Claude Code for planning and QA;
  Cline on a local runtime for Implementation when both exist, otherwise the orchestrator CLI).

## Engine guardrails

Settings › Advanced, and the last setup step; on by default. Each role may use its own CLI, with
that CLI's models and supported speed tiers; the engine's loop limits stay fixed. Off (asks for
confirmation): any model, effort or speed may be selected, loop limits become editable, and model
mismatches become warnings. Calls share one orchestrator lock and stay sequential. The engine's
safety checks (QA-only commits, scope and HEAD verification, stops on unsafe state) are unaffected.

## Usage-limit backups

Agents › Configuration: select an enabled agent on the other CLI for QA, Assessment or Elevation.
Resolver uses Assessment's backup. A structured usage-limit error retries only that operation once
with identical inputs and the backup's own model, effort and speed; Activity names the switch. Other
errors do not cause failover. If both CLIs are limited, the existing wait/Resume flow preserves the
operation without rerunning implementation. Selected custom executable paths are honored; roles
sharing a CLI kind must use the same executable. Both CLIs must pass startup checks.

## Task size: Eco, Standard and Max

Settings › Workflow rules › Task size, overridable per project in Projects › Workflow. It sets how much
work Assessment puts into one task (engine flag `--task-mode`):

- **Eco** (default): small tasks for local models or saving usage: one file per task where possible,
  implementation and tests as separate tasks, new files under about 200 lines, at most 3 files to read.
  With engine guardrails off, these numbers can be tuned in Context limits.
- **Standard**: one unchecked plan item per task, its code and tests together: at most 10 files,
  new files under about 800 lines, at most 10 files to read. For Pro, Max or API plans, or a local
  model with a large context.
- **Max**: no size limits; one task may cover several plan items that belong together. Turning it on
  asks first. While any project uses Max, a **Max limits** button sits in the sidebar above Collapse:
  files per task, new file size, files to read and an implementation timeout (replacing the agent's
  own), all empty (no limit) at first.

The scope guard, independent QA, QA-only commits and the spend budgets are the same in every mode.
**Suggested** names a mode for the enabled Implementation agent (Standard for a cloud CLI on a Pro,
Max, Team or API plan, or a local model with at least a 128K context; Eco otherwise). It never
suggests Max and never changes the mode by itself.

**Step down** (on by default): in Standard or Max, a task that fails review twice is set aside, its
work kept in a named git stash, and redone one size smaller (Max to Standard, Standard to Eco).
Assessment is told to redo that work now, starting with its first part. The configured size comes
back once the set-aside task's plan items are checked off, or after 5 approved tasks. The
step-down is saved in the run's state folder, so Stop/Run, an app restart or crash recovery keeps it;
it is dropped if you change the task size or turn step-down off before running again. Run reports show the task size, step-downs and plan items
finished; Overview's estimate compares the sizes this project has run in.

## Loop limits

Editable with guardrails off; the defaults are the engine's built-in values: automatic Elevation
after 3 attempted corrections; no correction limit (with one, the loop stops for you after that many
corrections on a task, and Resume allows another round); 3 Resolver strategies per task;
Eco's task sizing for the worker (1 file per task, new files under about 200 lines, at most 3
files to read); default context and output for new Cline agents.

## Implementation on any CLI

The Implementation agent can use Cline (llama.cpp or Ollama), OpenCode, Codex CLI or Claude Code.
File changes are limited to the task's allowed paths while the worker runs, not only checked
afterwards:

- **Claude Code**: `dontAsk` permissions with `Edit`/`Write` allowed only for the task's paths.
- **Codex**: a `PreToolUse` hook the engine writes for each run (`codex-scope-hook.mjs`) blocks any
  patch outside the task's paths. Because the engine generates that hook itself, Codex is started
  with `--dangerously-bypass-hook-trust` for it; every decision is logged next to the prompt, and an
  attempt in which Codex used tools without the hook running is refused.

With the tool guard on, the shell is also limited to the task's check command, lint/typecheck and
read-only commands. Protected-path and shell-syntax checks stay on even when that optional guard is
off. Cline and OpenCode retain their restricted tool runtime for this boundary. The worker is told
never to commit, git write commands are denied, and Node's scope and HEAD checks plus independent QA
still gate every change. An interrupted implementation is never replayed.

A usage limit is different: the CLI has exited and its partial changes are on disk, so the task
waits (Waiting: usage limit) with those changes kept. Resume starts a fresh attempt that is told to
review and finish them; in Unattended mode the engine also tries again by itself every 30 minutes
(engine flag `--limit-retry-minutes`, 0 = wait for Resume). Stop and restart keep the wait.

## Workflow roles

Workflow tab: your own roles at three points in the loop. Roles review read-only; only a fixer edits, under the guard.

- **Before implementation**: runs once per task; its guidance is added to every worker prompt for
  that task.
- **Before QA**: reviews each finished attempt; QA and Assessment read its findings. As a **gate**,
  "changes needed" sends the attempt back for correction instead of to QA, and a gate that cannot run
  blocks the task rather than letting the change through unreviewed. A gate can also be a
  **fixer**: when it finds problems, it fixes them itself once per attempt, then reviews the result
  again. The fix runs on the role's CLI with the tool guard always on, may edit only the task's
  approved files and never commits; the engine's evidence and scope checks run again afterwards. If
  problems remain, the attempt goes back for correction as usual.
- **After QA passes**: writes a report to `role-reports.ndjson` in the project's state folder.

Each role is a `ROLE.md` (frontmatter `name`, `description`, `stage`, `gate`, `fix`, `enabled`, then the
instructions) under `%APPDATA%\Agent Dock\roles\<id>`; import a folder of them from the Workflow
tab. A role runs on the agent assigned to it: an agent with the role "Workflow role" on Codex CLI or
Claude Code, with its own model, effort and speed. Roles go through the orchestrator lock, are
checkpointed like other engine operations (a resumed run never repeats a finished role), wait on
usage limits like QA, and never commit or change HEAD; only a fixer gate edits files, and only the
task's approved ones. A role without an enabled agent
is skipped, with a warning at start.

## Second-opinion QA

Workflow › Templates: create this optional gate, then choose **New agent** to use the other CLI from
the project's primary QA, or assign an existing workflow agent on that CLI. An enabled second
opinion requires an agent and blocks launch if incomplete. It reviews the scoped diff and engine
evidence before QA; only QA accepts and commits. Before-QA receipts are bound to the evidence they
reviewed, so changing the code invalidates their cached verdicts. A QA usage-limit backup may share
the second-opinion reviewer's CLI.

## QA evidence reuse

Engine check results are shared with workflow reviewers and QA. Automatic QA environment retries
reuse passing checks only for the same task, criteria, command, attempt, baseline and repository
content. Failed or inconclusive evidence reruns. Changed content or HEAD blocks use of a stale
packet. **Retry QA** explicitly collects fresh checks and reruns before-QA gates. Fingerprints cover
tracked and non-ignored repository files; use Retry QA after changing ignored/external dependencies
or submodule contents.

## Running, repeating and sharing work

All per project in Projects › Workflow, unless noted.

- **Scheduled runs**: start the automation at a local time on chosen weekdays while Agent Dock is
  open. A start missed by more than 30 minutes (the app was closed) is skipped; the 30 minutes run
  past midnight (a 23:50 start checked at 00:05 is on time). Pair with Unattended
  mode for overnight runs. **Also when closed** (Windows) adds a per-user task in the "Agent Dock" folder of
  Task Scheduler that launches Agent Dock minimized at that time; the app then starts what is due, so
  a run never starts twice. No admin rights; it runs only while you are signed in. Turning the option
  or the schedule off, or removing the project, removes the task. The task is created from an XML
  definition: it starts on battery and keeps going if the PC goes on battery, a start missed while the
  PC was off or asleep runs as soon as it can (still subject to the 30 minutes), it has no time limit,
  a second start while the app it launched is open is ignored (the open app handles it), and
  **Wake to run** (off by default) lets it wake the PC from sleep. If Task Scheduler refuses the XML,
  the task is created the old way with default settings and a warning says so. A scheduled start that
  could not start, or (with Also when closed) was missed, goes to the saved notification channels,
  email included, and a Windows notification (with Settings › General › Notifications › **Usage
  limits and engine exits** on); a start that went ahead shows in the app and goes to the channels
  except email.
- **Pull-request mode**: each new run works on its own `agent-dock/run-…` branch instead of the
  branch you had checked out. Nothing is pushed until you press **Open pull request**, which pushes
  the branch and opens the pull request with GitHub CLI (`gh`), or GitHub's compare page without it.
- **GitHub CI**: once the app has pushed a run branch, Projects › Workflow › GitHub CI shows that
  commit's GitHub Actions runs (`gh run list`, polled every minute until they finish, for at most six
  hours) and tells you when they pass or fail (Windows notification per the notification settings).
  It uses your own `gh auth login`; the app stores no GitHub token. **Fix CI failure** (or the opt-in
  fix loop, off by default) starts a run whose objective begins with the failed jobs' log (`gh run view
  --log-failed`, the last 120 lines, fenced as data), for that start only. When that run completes with
  new commits the app pushes the branch again and watches CI anew; a run that does not complete, or
  makes no commits, pushes nothing. The loop stops after 3 fix runs per push of yours.
- **Parallel tasks** (Settings › Workflow rules, or per project): up to 4 tasks in one run. Each
  round, Assessment picks tasks whose allowed files do not overlap; each runs through its own engine
  (Implementation, QA and its commit) in a worktree next to the project (`<project>-parallel/<task>-<run>`)
  on an `agent-dock/parallel-…` branch, at the same time. A task's engine does not step down (while the
  run itself is stepped down, it works at the smaller size, and merged tasks count toward ending the
  step-down); a task that is set aside ends there, is listed with the run's deferred tasks, and goes
  back to Assessment. The run then applies each approved change
  to your branch without committing, runs that task's check on the combined code, and commits only if
  it passes. A change that does not apply or fails stays on its branch and goes back to Assessment;
  the second time the same task fails to merge, the run stops for you. A task that did not finish
  keeps its worktree for you to inspect (a merged task's worktree is removed after its `node_modules`
  link, so the project's own `node_modules` is never touched). Stop, Pause and Resume reach every
  running task; a task waiting out a usage limit shows in Activity, and Resume continues it as in a
  normal run;
  between rounds the run pauses and stops as it does between tasks, so with Automatic continuation off
  it pauses after a round that merged a change. The run keeps one budget for all its tasks, in Unattended mode
  too: a task's engine has no token, spend, task or time limit of its own; while a round runs, the run
  counts each task's tokens and spend so far (`run-usage.json` in its state folder) toward the run's
  report and the day's budgets (`usage-day.json` of the project only), and a limit reached stops every
  task at its next safe point (`--max-rounds N` also ends the run after N rounds). The check of the
  combined code goes through the QA runner: the same approved-command check, without secrets in its
  environment. Overview's Current task card lists the round's tasks with each one's stage
  (`parallel-round.json`). Needs a cloud Implementation agent (a local model server answers one
  request at a time); a task in progress finishes on its own before parallel rounds start. Plan items are checked off as each change
  is merged. Projects › Workflow › **Clean up parallel worktrees** removes the kept worktrees (each
  `node_modules` link first) and every `agent-dock/parallel-…` branch, after you confirm; unmerged work
  on them is lost, and it waits while a run of the project or its lanes is active.
- **Parallel lanes**: run another objective at the same time in a linked git worktree
  (`<project>-lanes/<name>`) on its own `agent-dock/lane-…` branch. Each lane is its own project with
  its own engine and state folder; merge its branch when you are happy with it. Removing a lane keeps
  its branch.
- **WSL isolation (opt-in)**: the engine and every agent CLI and command it starts run inside a WSL
  distro. Node.js, git and the agent CLIs must be installed and signed in there (**Check distro**
  lists them). Windows drives stay reachable under `/mnt` unless automount is off in the distro's
  `/etc/wsl.conf`; keep the project inside the distro (`\\wsl$\…`) for the strongest separation.
  Prefer Stop over Stop now for these runs.
- **Run again** (Task history): runs one earlier task again, with the same prompt, files and check,
  as the next start's first task. Tasks are kept from 0.34 on (`<state>/tasks`).
- **Estimate** (Overview): the plan's remaining items at this project's own pace over its recent
  approved tasks (time, tokens, spend). Each plan item counts as one task, so it is a rough guide.
- **Export** (Overview › Runs): one run's report as Markdown or a self-contained HTML page.

## Known limitations

- Workflow roles review read-only, except a **fixer** gate (Before QA), which edits the task's
  approved files under the tool guard, once per attempt, and never commits. Roles run only on Codex
  CLI or Claude Code.
- Parallel tasks need a cloud Implementation agent (a local model server answers one request at a
  time). A task's tokens and spend count toward the run's budgets while it works (checked every few
  seconds, so a limit can be passed by what the tasks use in that time and until their next safe
  point); its per-role usage reaches Overview when its engine finishes. The Elevation limit is shared:
  what is left of it is split between the round's tasks (a task given none runs without automatic
  Elevation), and each task's Elevations count toward it. The check of the combined code is ended after
  30 minutes (a watch mode or a server left running) and counts as a failed check.
- On some Windows machines the engine's atomic state writes can hit `EPERM` on rename (a file lock,
  usually antivirus or indexing). The engine retries a blocked rename for about five seconds; if a
  lock lasts longer, excluding the engine state folders from real-time scanning is the usual fix.
- A Cline or OpenCode worker on an OpenAI-compatible cloud provider receives that provider's API key
  in its environment, because the CLI calls the provider itself. Use a key made only for Agent Dock,
  with a low spending limit at the provider; CLIs shows this where the key is entered, and a start
  warns when an OpenRouter key reports no limit.
- Spend budgets count the cost a CLI reports (Claude Code, OpenCode, and Cline on a cloud provider).
  Codex reports only tokens, so its spend counts only for models listed in Settings › Execution & safety
  › Price table, which estimates cost from the tokens. Local model servers (llama.cpp, Ollama) cost
  nothing and are never priced; token budgets still include their tokens.
