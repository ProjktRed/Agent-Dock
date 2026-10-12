# Agent Dock

<img src="assets/logo.svg" width="72" alt="Agent Dock logo">

A Windows desktop command center for the Codex ↔ Cline automation loop: manage projects,
agents, CLI connections and settings, and monitor runs with progress, usage and token data.

The automation itself is the engine from `E:\BG3C\codex-cline-loop`, vendored unchanged in
[`engine/`](engine/) (see [engine/ENGINE_README.md](engine/ENGINE_README.md)). The app launches it as
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

1. Clones/refreshes the source into `E:\Agent Dock\Updates\repo` and checks out the branch head
   (uncommitted changes are never included).
2. Writes `build-info.json` (commit, branch, source) and the logo icon, runs `npm ci`,
   `electron-vite build` and `electron-builder --win --dir`.
3. Mirrors the result to `E:\Agent Dock\App\AgentDock.exe` and adds “Agent Dock” Start menu and
   Desktop shortcuts. No admin rights are needed. Set `AGENT_DOCK_HOME` to use another root.

The installed app and its update workspace stay outside the source repository:

```
E:\Agent Dock\App       installed app (replaced on update)
E:\Agent Dock\Updates   clean clone of the committed source + build output
```

Options: `--source <repo path or git URL>`, `--branch <name>`, `--install-dir <dir>`, `--commit <sha>`.

### Automatic updates

The installed app compares its commit with the source branch on launch
(`git ls-remote <source> refs/heads/<branch>`). When a newer commit exists it lists the new
commits and offers **Update now**, or installs automatically if you enable it (Settings ›
Updates). Updating:

1. fetches the new commit into the staging copy and runs **that commit's**
   `scripts/release-local.mjs --stage build` while the app keeps running (log shown in Settings),
2. starts the swap stage, quits; the swap waits for the app to exit, mirrors the new build over
   the install folder and relaunches.

Updates are refused while an automation engine is running, because the engine files are replaced.
Building needs Node.js, npm and Git on PATH.

The source is any git location. Today it is the local repository (`E:\Automation_App`); after the
move to GitHub, set Settings › Updates › Update source to `https://github.com/<owner>/<repo>.git`
(or rebuild once from the GitHub clone) and the same mechanism works unchanged.

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
engine/          vendored engine (unchanged), its tests, skills and fixtures
tests/           vitest unit tests for the main-process logic
```

### How app configuration maps to the engine

| App | Engine flag |
| --- | --- |
| Project path, objective, state folder | `--workspace`, `--objective`, `--state-dir` |
| Implementation agent: provider, model, context, max output, timeout | `--provider`, `--model`, `--cline-context-tokens`, `--cline-max-output-tokens`, `--timeout-seconds` |
| QA agent's CLI (Codex or Claude Code) | `--orchestrator codex\|claude` (+ `--codex-exe` / `--claude-command` for a custom path) |
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

- **Usage limits**: account status comes from `codex login status` and `claude auth status`.
  Neither CLI writes quota percentages or reset times to the engine's logs, so those show
  **Not exposed**. A usage-limit stop is shown as **Reported** with the engine's message. You can
  add your own monthly token budget; it is shown as **Manual**.
- **Tokens**: Codex `turn.completed` usage and Claude Code `result` usage from each invocation
  under `<state>\codex\`, plus llama.cpp `/metrics` samples the engine logs per Cline attempt.
  No cost is estimated (no pricing is configured; subscriptions expose none). The current
  context occupancy is not reported by any runtime, so it is not shown as a number.
- **Model limits**: llama.cpp `/props` and Ollama `/api/show` context sizes are **Reported**;
  otherwise **Not exposed**.
- **Capabilities**: detected from each CLI's own `--help` output, never assumed.
- Every setting carries a label: **Enforced by engine**, **Applied by app**, or **Saved only**
  (stored for future engine support).

## Known limitations

- The engine fixes orchestrator models per CLI (Codex: `gpt-6.1-sol`/`gpt-6-astra`,
  Claude: `sonnet`/`opus`, medium effort); the app shows them read-only.
- QA and Assessment must share one orchestrator CLI.
- Custom roles, agent custom instructions, extra skills and protected paths are saved only;
  the engine does not read them yet.
- The llama.cpp auto-start launcher path is fixed in the engine
  (`E:\llama-cpp-local\scripts\Cline-Server.cmd`).
- On this machine the engine's atomic state writes can hit `EPERM` on rename (a file lock,
  likely antivirus or indexing). It intermittently fails one engine test under parallel load
  and blocked the `ADR020-A1` reference run. Excluding the engine state folders from real-time
  scanning is the usual fix.
