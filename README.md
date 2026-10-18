# Agent Dock

<img src="assets/logo.svg" width="72" alt="Agent Dock logo">

A Windows desktop app for running AI coding agents on your projects: plan, implement, review and
test in a supervised loop, and monitor progress, usage limits and token consumption in one place.

The loop runs in the engine in [`engine/`](engine/), with per-role models, reasoning effort and
speed, a choice of implementation CLI, custom workflow roles and adjustable loop limits. The app
launches it as a separate process per project and reads the engine's `.state` files.

## Getting started

**Install:** download `AgentDock-Setup-<version>-win-x64.exe` from
[the releases page](https://github.com/ProjktRed/Agent-Dock/releases) and run it. It installs
for your Windows account only (no admin rights) into `%LOCALAPPDATA%\Programs\AgentDock`, with Start
menu and desktop shortcuts and an uninstaller. The installer is not Authenticode-signed yet, so Windows
SmartScreen may warn about an unknown publisher (More info › Run anyway); the release notes list its
SHA-256. Agent Dock then updates itself from the same page, and installs a release only when its
signature matches the release key built into the app.

**You need:** Windows 10 or 11, [Git](https://git-scm.com/download/win), and Codex CLI or Claude Code,
installed and signed in. Agent Dock never handles their logins. Optional: Cline CLI with
llama.cpp or Ollama, to implement with a local model instead of a cloud CLI.

1. **Setup** opens on first launch. Step 1 checks Git, the CLI for planning and QA, and the
   Implementation agent's CLI. If only Codex or only Claude Code is installed, one button points
   the agents at it, on its default model; change models later in **Agents**.
2. **Add a project:** an existing Git repository, a GitHub clone, or a new folder. Give it an
   objective (what the loop should build), or let **Create plan with a model** write an
   `IMPLEMENTATION_PLAN.md` for you to review.
3. **Start** the project on **Overview**. Assessment picks one small task, Implementation makes the
   change inside that task's files, and QA checks it and commits it. **Progress** shows each step;
   **Runs** lists finished runs with their reports.

What stays under your control:
- Nothing runs until you press Start, and Pause, Stop and Stop now work at any time. **Stop all**
  (Settings › Safety) stops every project at once.
- Workers cannot commit, change Git history or touch paths outside their task. Protected paths
  (Settings › Safety) and Agent Dock's own folders are refused to every worker.
- **Unattended mode** (Settings › Safety) adds hard caps on tasks, hours, corrections, tokens and
  spend, and a Supervisor that alerts or pauses on stalls and repeated failures.
- API keys you enter are encrypted with your Windows account (DPAPI) and kept out of logs,
  prompts and notifications.

Something wrong? **Settings › Advanced › Export diagnostics** saves a zip for a bug report, with
secrets, project code and model prompts left out.

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

## Build and install from source

`npm run release:local` builds the latest commit of the current branch (never uncommitted changes)
and installs it for your Windows account, with Start menu and desktop shortcuts. Such a build
updates itself from its Git source (Settings › Updates).

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
engine/          automation engine, its tests, skills and fixtures
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
| llama.cpp models folder (CLIs › Models, router mode) | `--llamacpp-models-dir` |
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
  A usage limit is different: the CLI has exited and its partial changes are on disk, so the task
  waits (Waiting: usage limit) with those changes kept. Resume starts a fresh attempt that is told to
  review and finish them; in Unattended mode the engine also tries again by itself every 30 minutes
  (engine flag `--limit-retry-minutes`, 0 = wait for Resume). Stop and restart keep the wait.
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

## Security boundaries

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
- On some Windows machines the engine's atomic state writes can hit `EPERM` on rename (a file
  lock, usually antivirus or indexing). It can intermittently fail an engine test under parallel
  load or interrupt a run. Excluding the engine state folders from real-time
  scanning is the usual fix.

## Releases (maintainers)

Pushing a tag `vX.Y.Z` that matches `package.json` runs `.github/workflows/release.yml`: checks and
tests, the per-user installer (`npm run package:installer`, electron-builder NSIS), the packaged
security check, a zip of the app, and a manifest of that zip signed with Ed25519. It publishes the
installer, zip, `manifest.json` and `manifest.sig` to the public releases repository. Setup, once:

1. `node scripts/sign-release.mjs --generate-key release-key.pem`, add the file's contents as the
   repository secret `RELEASE_SIGNING_KEY`, delete the file, and put the printed public key in
   `src/main/release-key.ts`.
2. Create the public releases repository with one commit (a README). If it is not the default in
   `release.yml`, set it as the repository variable `RELEASE_REPO`.
3. Add the secret `RELEASES_TOKEN`: a fine-grained token with Contents read/write on the releases
   repository only.

## License

[MIT](LICENSE)
