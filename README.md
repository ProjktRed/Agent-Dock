# Agent Dock

<img src="assets/logo.svg" width="72" alt="Agent Dock logo">

A Windows desktop command center for the Codex ↔ Cline automation loop: manage projects,
agents, CLI connections and settings, and monitor runs with progress, usage and token data.

The automation itself is the Codex ↔ Cline loop engine, vendored in
[`engine/`](engine/) (see [engine/ENGINE_README.md](engine/ENGINE_README.md)), extended with
per-role model, reasoning effort and speed flags. The app launches it as
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
  lib/           pure logic: engine-args, status mapping, plan parser, git, CLI checks, usage
src/preload/     contextBridge API (window.api), typed by src/shared/api.ts
src/renderer/    React UI: Overview (Progress, Usage limits, Token consumption), Projects,
                 Agents, CLIs, Settings, first-launch setup
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
| llama.cpp models folder (CLIs › Models, router mode) | `--llamacpp-models-dir` → launcher `-ModelsDir` |
| QA agent's CLI (Codex or Claude Code) | `--orchestrator codex\|claude` (+ `--codex-exe` / `--claude-command` for a custom path) |
| QA, Assessment, Elevation agents: model, reasoning effort, speed (Resolver follows Assessment) | `--qa-model` / `--qa-effort` / `--qa-fast`, `--assessment-*`, `--resolver-*`, `--elevate-*` |
| Engine guardrails off: Assessment or Elevation on another CLI than QA | `--assessment-cli` / `--resolver-cli` / `--elevate-cli codex\|claude` |
| Automatic elevation (and Elevation agent enabled) | `--sol-reassessment` |
| Worker tool guard | `--tool-guard` |
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
- **Engine guardrails** (Settings › Advanced, and the last setup step; on by default): keep QA,
  Assessment and Elevation on one orchestrator CLI with models that CLI lists. Off (asks for
  confirmation): each role may use its own CLI and any model, effort or speed. The engine then
  routes each role to its own worker (Codex or Claude Code, one shared lock so calls stay
  sequential), and launch checks become warnings. The engine's safety checks (QA-only commits,
  scope and HEAD verification, stops on unsafe state) are unaffected.

## Known limitations

- The engine's role prompts still name its default models (for example "Elevation: GPT-6 Astra")
  whichever model runs the role.
- With engine guardrails on, QA, Assessment and Elevation share one orchestrator CLI.
- Custom roles can pick a CLI, model, effort and speed, but the engine has no slot that runs them.
- Custom roles, agent custom instructions, extra skills and protected paths are saved only;
  the engine does not read them yet.
- llama.cpp is only started automatically when a launcher script is set (Settings › Advanced ›
  llama.cpp launcher; passed as `--llamacpp-launcher`). Router mode and thinking expect the
  launcher to accept `-ModelsDir`, `-Reasoning` and `-ReasoningEffort` and pass them on to
  `llama-server` as `--models-dir`, `--reasoning` and `--reasoning-effort`.
- On some Windows machines the engine's atomic state writes can hit `EPERM` on rename (a file
  lock, usually antivirus or indexing). It can intermittently fail an engine test under parallel
  load or interrupt a run. Excluding the engine state folders from real-time
  scanning is the usual fix.
