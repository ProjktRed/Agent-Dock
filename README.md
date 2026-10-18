# Agent Dock

<img src="assets/logo.svg" width="72" alt="Agent Dock logo">

A Windows desktop command center for the Codex ↔ Cline automation loop: manage projects,
agents, CLI connections and settings, and monitor runs with progress, usage and token data.

The automation itself is the Codex ↔ Cline loop engine, vendored in
[`engine/`](engine/) (see [engine/ENGINE_README.md](engine/ENGINE_README.md)), extended with
per-role model, reasoning effort and speed flags, implementation through Codex or Claude Code,
custom workflow roles and adjustable loop limits. The app launches it as
a separate process per project and reads the engine's `.state` files. It never re-implements
the loop.

## Run

Requires Node 20+ (the engine runs on the system `node` when found, otherwise on Electron's
bundled runtime), Git, and the CLIs you want to use (Codex CLI or Claude Code, Cline CLI,
llama.cpp or Ollama).

```bash
npm install
```

```bash
npm run dev
```

Other scripts: `npm run build` (production bundle into `out/`), `npm start` (run the built app),
`npm test` (app unit tests), `npm run test:engine` (the engine's own suite), `npm run typecheck`,
`npm run package` (unpacked Windows build via electron-builder).

## Install as a Windows app

```bash
npm run release:local
```

This builds the app from a **clean copy of the latest commit** on the current branch, not from
your working tree, and installs it:

1. Clones/refreshes the source into `<root>\Updates\repo` and checks out the branch head
   (uncommitted changes are never included).
2. Writes `build-info.json` (commit, branch, source) and the logo icon, runs `npm ci`,
   `electron-vite build` and `electron-builder --win --dir`.
3. Mirrors the result to `<root>\App\AgentDock.exe` and adds “Agent Dock” Start menu and
   Desktop shortcuts. No admin rights are needed.

`<root>` is `%LOCALAPPDATA%\Programs\Agent Dock` by default; set `AGENT_DOCK_HOME` to use another
folder. The installed app and its update workspace stay outside the source repository:

```
<root>\App       installed app (replaced on update)
<root>\Updates   clean clone of the committed source + build output
```

Options: `--source <repo path or git URL>`, `--branch <name>`, `--install-dir <dir>`, `--commit <sha>`.

### Automatic updates

The installed app compares its commit with the source branch on launch
(`git ls-remote <source> refs/heads/<branch>`). When a newer commit exists it lists the new
commits and offers **Update now**, or installs automatically if you enable it (Settings ›
Updates). While the app runs it repeats that check in the background (every 30 minutes by default,
Settings › Updates › Check while running) and when you return to the window (at most every
10 minutes). Background checks stay silent when the source can't be reached, and show a Windows
notification for a new update when the window isn't in front. Updating:

1. fetches the new commit into the staging copy and runs **that commit's**
   `scripts/release-local.mjs --stage build` while the app keeps running (log shown in Settings),
2. starts the swap stage, quits; the swap waits for the app to exit, mirrors the new build over
   the install folder and relaunches.

Updates are refused while an automation engine is running, because the engine files are replaced.
Building needs Node.js, npm and Git on PATH.

The source is any git location: by default the repository the app was built from, or a URL such
as `https://github.com/<owner>/<repo>.git` set in Settings › Updates › Update source.

## Architecture

```
src/main/        Electron main process (Node)
  index.ts       window, tray, IPC, 1.5 s status poller, Windows notifications
  engine.ts      spawns engine/src/cli.mjs per project, control (pause/resume/stop/elevate/resolve)
  store.ts       JSON config in %APPDATA%\Agent Dock\config, secrets via safeStorage (DPAPI)
  projects.ts    register / clone / create workspaces, task history from activity.ndjson
  roles.ts       workflow roles: ROLE.md files under %APPDATA%\Agent Dock\roles
  lib/           pure logic: engine-args, status mapping, plan parser, git, CLI checks, usage
src/preload/     contextBridge API (window.api), typed by src/shared/api.ts
src/renderer/    React UI: Overview (Progress, Usage limits, Token consumption), Projects,
                 Workflow, Agents, CLIs, Settings, first-launch setup
src/shared/      types and defaults shared by all three
engine/          vendored engine (+ per-role model flags), its tests, skills and fixtures
tests/           vitest unit tests for the main-process logic
```

### How app configuration maps to the engine

| App | Engine flag |
| --- | --- |
| Project path, objective, state folder | `--workspace`, `--objective`, `--state-dir` |
| Implementation agent: provider, model, context, max output, timeout | `--provider`, `--model`, `--cline-context-tokens`, `--cline-max-output-tokens`, `--timeout-seconds` |
| Implementation agent: thinking (Cline `--thinking`) | `--cline-thinking none\|low\|medium\|high\|xhigh` |
| Implementation agent on Codex CLI or Claude Code: model, effort, speed, timeout | `--implementation-cli codex\|claude`, `--implementation-model`, `--implementation-effort`, `--implementation-fast`, `--timeout-seconds` |
| Workflow roles (Workflow tab) with an enabled agent | `--roles-file <state>\workflow-roles.json` (written at start) |
| Engine guardrails off: loop limits (Settings › Workflow rules, Context limits) that differ from the defaults | `--elevation-after`, `--max-corrections`, `--resolver-max-strategies`, `--task-max-files`, `--task-max-new-lines`, `--task-max-read-files` |
| llama.cpp models folder (CLIs › Models, router mode) | `--llamacpp-models-dir` → launcher `-ModelsDir` |
| QA agent's CLI (Codex or Claude Code) | `--orchestrator codex\|claude` (+ `--codex-exe` / `--claude-command` for a custom path) |
| QA, Assessment, Elevation agents: model, reasoning effort, speed (Resolver follows Assessment) | `--qa-model` / `--qa-effort` / `--qa-fast`, `--assessment-*`, `--resolver-*`, `--elevate-*` |
| Assessment or Elevation on another CLI than QA (guardrails may stay on) | `--assessment-cli` / `--resolver-cli` / `--elevate-cli codex\|claude` |
| Orchestrator agent: optional usage-limit backup agent | `--<role>-backup-cli`, `--<role>-backup-model`, `--<role>-backup-effort`, `--<role>-backup-fast` (Resolver follows Assessment) |
| Automatic elevation (and Elevation agent enabled) | `--sol-reassessment` |
| Worker tool guard | `--tool-guard` |
| Agents: assigned skills and custom instructions (up to 4,000 characters, added after the skills) | `--skills-file <state>\assigned-skills.json` (written at start) |
| Attached task file | `--task` (validated with the engine's own `validateTask`, used once) |

Controls write the engine's `control.json` through its own `DashboardState`, with the same
semantics as the engine dashboard: **Pause** = pause after the current task, **Stop** = at the
next safe point, **Stop after current task** = pause, then stop once paused, **Stop now** =
terminate the process tree. Resume, Elevate and Resolve start the engine if it isn't running.

The engine runs detached with file-backed output (`<state>\app-engine.log`), so closing the window
or quitting the app can leave it running safely; the app reattaches on the next launch.

## What is real and what is labelled

- **Usage limits** (all **Reported** by the provider's own CLI, with an "as of" time):
  - **Codex**: the official app-server method `account/rateLimits/read` (`codex app-server` over
    stdio, `initialize` + one read). Plan, 5-hour and weekly windows (used %, reset time),
    credits and reset-credit count. Read-only and free; refreshed every 5 minutes by default. The
    reset-credit *consume* method is never called.
  - **Claude Code**: the SDK control request `get_usage` (`skip_behaviors: true`, after
    `initialize`) over `claude -p --input-format stream-json`. Claude Code fetches the numbers
    itself, so no prompt is sent and Agent Dock never handles its login token. Plan, 5-hour and
    weekly windows (plus per-model weekly windows when the plan has them), extra usage and this
    week's split by product. Free; refreshed every 5 minutes by default. Hooks are off for that
    session. `get_usage` is not in Claude's public docs, so if it is unavailable a **manual**
    Refresh falls back to one minimal Haiku request and reads its `rate_limit_event`; automatic
    refreshes never fall back.
  - The last snapshots are cached in `config\limits.json`; a failed refresh keeps the last good
    snapshot and shows the error. You can also add a monthly token budget, shown as **Manual**.
- **Tokens**: Codex `turn.completed` usage and Claude Code `result` usage from each invocation
  under `<state>\codex\`, plus llama.cpp `/metrics` samples the engine logs per Cline attempt.
  No cost is estimated (no pricing is configured; subscriptions expose none). The current
  context occupancy is not reported by any runtime, so it is not shown as a number.
- **Model limits**: llama.cpp `/props` and Ollama `/api/show` context sizes are **Reported**;
  otherwise **Not exposed**.
- **Orchestrator models**: listed by the CLI itself, free, no prompt sent. Codex: app-server
  `model/list` (efforts, default effort, Fast service tier `priority`). Claude Code: the SDK
  `initialize` control request (models, effort levels, fast-mode support, and whether fast mode is
  available on the account). Cached in `config\models.json`, refreshed daily or with the refresh
  button in Agents. Fast runs pass `-c service_tier="priority"` (Codex) or the `fastMode` flag
  setting (Claude Code).
- **Local models**: collected from the provider itself and stored on the connection (first setup
  offers it; CLIs › Models › Refresh updates it). Ollama: `/api/tags` + `/api/show` (context and
  the `thinking` capability); needs Ollama running. llama.cpp: `/v1/models`. With a models folder
  set, llama.cpp runs in router mode (`--models-dir`): it lists every model in the folder (one per
  subfolder) and loads the Implementation agent's model on demand, with the launcher's tuning. If
  the server isn't running, Refresh starts the launcher in router mode just for the listing (no
  model is loaded) and stops it again. Router mode is opt-in; without a folder the launcher serves
  its single configured model as before.
- **Thinking (Implementation)**: passed to Cline `--thinking`. For llama.cpp, a level other than
  Off also starts the server with `--reasoning on --reasoning-effort <level>` (only when the
  engine starts it; a running server keeps its setting). Speed tiers do not apply to local models.
- **Capabilities**: detected from each CLI's own `--help` output, never assumed.
- Every setting carries a label: **Enforced by engine**, **Applied by app**, or **Saved only**
  (stored for future engine support).
- **Engine guardrails** (Settings › Advanced, and the last setup step; on by default): each role
  may use its own CLI, with that CLI's models and supported speed tiers; the engine's loop limits
  stay fixed. Off (asks for confirmation): any model, effort or speed may be selected, loop limits
  become editable, and model mismatches become warnings. Calls share one orchestrator lock and
  stay sequential. The
  engine's safety checks (QA-only commits, scope and HEAD verification, stops on unsafe state)
  are unaffected.
- **Usage-limit backups** (Agents › Configuration): select an enabled agent on the other CLI
  for QA, Assessment or Elevation. Resolver uses Assessment's backup. A structured usage-limit
  error retries only that operation once with identical inputs and the backup's own model,
  effort and speed; Activity names the switch. Other errors do not cause failover. If both CLIs
  are limited, the existing wait/Resume flow preserves the operation without rerunning
  implementation. Selected custom executable paths are honored; roles sharing a CLI kind must
  use the same executable. Both CLIs must pass startup checks.
- **Loop limits** (editable with guardrails off; the defaults are the engine's built-in values):
  automatic Elevation after 3 attempted corrections; no correction limit (with one, the loop stops
  for you after that many corrections on a task, and Resume allows another round); 3 Resolver
  strategies per task; Assessment's task sizing for the worker (1 file per task, new files under
  about 200 lines, at most 3 files to read); default context and output for new Cline agents.
- **Implementation on any CLI**: the Implementation agent can use Cline (llama.cpp or Ollama),
  Codex CLI or Claude Code. File changes are limited to the task's allowed paths while the worker
  runs, not only checked afterwards:
  - **Claude Code**: `dontAsk` permissions with `Edit`/`Write` allowed only for the task's paths.
  - **Codex**: a `PreToolUse` hook the engine writes for each run (`codex-scope-hook.mjs`) blocks
    any patch outside the task's paths. Because the engine generates that hook itself, Codex is
    started with `--dangerously-bypass-hook-trust` for it; every decision is logged next to the
    prompt, and an attempt in which Codex used tools without the hook running is refused.

  With the tool guard on, the shell is also limited to the task's check command, lint/typecheck and
  read-only commands. Protected-path and shell-syntax checks stay on even when that optional
  guard is off. Cline and OpenCode retain their restricted tool runtime for this boundary.
  The worker is told never to commit, git write commands are denied, and Node's scope and HEAD
  checks plus independent QA still gate every change. An interrupted implementation is never
  replayed (the same rule as for Cline).
- **Workflow roles** (Workflow tab): your own read-only roles at three points in the loop.
  - **Before implementation**: runs once per task; its guidance is added to every worker prompt
    for that task.
  - **Before QA**: reviews each finished attempt; QA and Assessment read its findings. As a
    **gate**, "changes needed" sends the attempt back for correction instead of to QA, and a gate
    that cannot run blocks the task rather than letting the change through unreviewed.
  - **After QA passes**: writes a report to `role-reports.ndjson` in the project's state folder.

  Each role is a `ROLE.md` (frontmatter `name`, `description`, `stage`, `gate`, `enabled`, then the
  instructions) under `%APPDATA%\Agent Dock\roles\<id>`; import a folder of them from the Workflow
  tab. A role runs on the agent assigned to it: an agent with the role "Workflow role" on Codex CLI
  or Claude Code, with its own model, effort and speed. Roles go through the orchestrator lock, are
  checkpointed like other engine operations (a resumed run never repeats a finished role), wait on
  usage limits like QA, and never edit files, commit or change HEAD. A role without an enabled
  agent is skipped, with a warning at start.
- **Second-opinion QA** (Workflow › Templates): create this optional gate, then choose **New
  agent** to use the other CLI from the project's primary QA, or assign an existing workflow
  agent on that CLI. An enabled second opinion requires an agent and blocks launch if incomplete.
  It reviews the scoped diff and engine evidence before QA; only QA accepts and commits.
  Before-QA receipts are bound to the evidence they reviewed, so changing the code invalidates
  their cached verdicts. A QA usage-limit backup may share the second-opinion reviewer's CLI.
- **QA evidence reuse**: engine check results are shared with workflow reviewers and QA.
  Automatic QA environment retries reuse passing checks only for the same task, criteria,
  command, attempt, baseline and repository content. Failed or inconclusive evidence reruns.
  Changed content or HEAD blocks use of a stale packet. **Retry QA** explicitly collects fresh
  checks and reruns before-QA gates. Fingerprints cover tracked and non-ignored repository files;
  use Retry QA after changing ignored/external dependencies or submodule contents.

## Security boundaries (0.16.5)

- **Protected paths** in Settings › Safety now reach every engine launch through
  `--protected-paths` (a JSON string array). Paths may be workspace-relative or absolute;
  `*`, `?` and `**` patterns are supported. Basename patterns such as `.env*` include nested
  matches. The running engine, application installation, settings and project-state folders
  are protected automatically. Changes take effect on the next engine start.
- Codex, Claude Code, Cline and OpenCode tool calls are checked before access. Canonical path
  checks include symlink/junction targets and missing-file parents. Recursive searches that
  include protected content are refused; narrow the search to source directories. Git metadata
  inspection remains available. Protected changes fail QA scope checks and suppress the whole
  diff, including content moved to a previously unprotected filename.
- Assessment cannot choose an arbitrary QA shell program. QA commands are limited to project
  npm scripts, supported local check tools, and bounded Git inspection. Shell expressions,
  interpreters, redirection, package installation and ambiguous path syntax are refused.
  Project scripts and their dependencies still execute as trusted code: these guards are
  **not an OS sandbox**, and do not defend against a malicious project script, a compromised
  CLI, concurrent filesystem races, or a process already running as your user. CLI startup
  configuration/automatic context loading is also outside tool-hook mediation.
- The standalone engine dashboard requires a fresh random bearer token for every API route.
  Its browser launch link carries the token in a fragment, which the page removes from history
  and saves per tab. A server restart invalidates older tokens. Tokens are not written to engine
  logs. Host, origin and JSON request checks remain enforced.
- Packaged Electron refuses debugging/inspection switches, ignores development renderer URL
  overrides, denies web permissions and webviews, and packages with ASAR integrity/load-path
  and Node environment/inspection fuses. Electron's RunAsNode fuse remains enabled because
  the engine and CLI hooks use its bundled Node runtime. The pinned electron-builder 25 uses
  `scripts/harden-electron.cjs` as an `afterPack` hook (before signing), since it predates the
  `electronFuses` configuration option. See [Electron's fuse documentation](https://www.electronjs.org/docs/latest/tutorial/fuses).

To verify a Windows security test package without installing or opening its UI:

```powershell
npm run build
npx electron-builder --win --dir --config.directories.output=dist/security
node scripts/verify-packaged-security.mjs dist/security/win-unpacked/AgentDock.exe
```

The smoke test checks the actual packaged fuses, bundled Node startup and rejection of
debugging switches. It does not replace live-provider integration testing or an OS sandbox.

## Known limitations

- Workflow roles are read-only reviewers and planners; they cannot edit files.
- A usage limit hit during a Codex or Claude Code implementation stops that attempt. Because an
  interrupted implementation is never replayed, the task then needs Resolve or your decision.
- llama.cpp is only started automatically when a launcher script is set (Settings › Advanced ›
  llama.cpp launcher; passed as `--llamacpp-launcher`). Router mode and thinking expect the
  launcher to accept `-ModelsDir`, `-Reasoning` and `-ReasoningEffort` and pass them on to
  `llama-server` as `--models-dir`, `--reasoning` and `--reasoning-effort`.
- On some Windows machines the engine's atomic state writes can hit `EPERM` on rename (a file
  lock, usually antivirus or indexing). It can intermittently fail an engine test under parallel
  load or interrupt a run. Excluding the engine state folders from real-time
  scanning is the usual fix.
