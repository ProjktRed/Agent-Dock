# Architecture

Agent Dock is an Electron app (main process, preload bridge, React renderer) around a separate
automation engine in [`engine/`](../engine/). The app launches the engine as its own process per
project and reads the engine's `.state` files; it never re-implements the loop. The engine's own
flags and behaviour are described in [engine/ENGINE_README.md](../engine/ENGINE_README.md).

## Source layout

```
src/main/        Electron main process (Node)
  index.ts       window, tray, IPC, 1.5 s status poller, Windows notifications
  engine.ts      spawns engine/src/cli.mjs per project, control (pause/resume/stop/elevate/resolve)
  store.ts       JSON config in %APPDATA%\Agent Dock\config, secrets via safeStorage (DPAPI)
  discovery.ts   first-run discovery of the CLIs and local model servers on this computer
  projects.ts    register / clone / create workspaces, task history from activity.ndjson
  roles.ts       workflow roles: ROLE.md files under %APPDATA%\Agent Dock\roles
  lib/           pure logic: engine-args, status mapping, plan parser, git, CLI checks, usage
src/preload/     contextBridge API (window.api), typed by src/shared/api.ts
src/renderer/    React UI: Overview (Progress, Usage limits, Token consumption), Projects,
                 Workflow, Agents, CLIs, Settings, first-launch setup
src/shared/      types and defaults shared by all three
engine/          automation engine (no dependencies), its tests, skills and fixtures
tests/           vitest unit tests for the main-process logic
```

## How app configuration maps to the engine

| App | Engine flag |
| --- | --- |
| Project path, objective, state folder | `--workspace`, `--objective`, `--state-dir` |
| Implementation agent: provider, model, context, max output, timeout | `--provider`, `--model`, `--cline-context-tokens`, `--cline-max-output-tokens`, `--timeout-seconds` |
| Implementation agent: thinking (Cline `--thinking`) | `--cline-thinking none\|low\|medium\|high\|xhigh` |
| Implementation agent on Codex CLI or Claude Code: model, effort, speed, timeout | `--implementation-cli codex\|claude`, `--implementation-model`, `--implementation-effort`, `--implementation-fast`, `--timeout-seconds` |
| Workflow roles (Workflow tab) with an enabled agent | `--roles-file <state>\workflow-roles.json` (written at start) |
| Engine guardrails off: loop limits (Settings › Workflow rules, Context limits) that differ from the defaults | `--elevation-after`, `--max-corrections`, `--resolver-max-strategies`, `--task-max-files`, `--task-max-new-lines`, `--task-max-read-files` |
| llama.cpp / Ollama connection address (CLIs) | `--llamacpp-url`, `--ollama-url` |
| llama.cpp models folder (CLIs › Models, router mode) | `--llamacpp-models-dir` |
| llama.cpp launcher script (Settings › Advanced, optional) | `--llamacpp-launcher` |
| QA agent's CLI (Codex or Claude Code) | `--orchestrator codex\|claude` (+ `--codex-exe` / `--claude-command` for a custom path) |
| QA, Assessment, Elevation agents: model, reasoning effort, speed (Resolver follows Assessment) | `--qa-model` / `--qa-effort` / `--qa-fast`, `--assessment-*`, `--resolver-*`, `--elevate-*` |
| Assessment or Elevation on another CLI than QA (guardrails may stay on) | `--assessment-cli` / `--resolver-cli` / `--elevate-cli codex\|claude` |
| Orchestrator agent: optional usage-limit backup agent | `--<role>-backup-cli`, `--<role>-backup-model`, `--<role>-backup-effort`, `--<role>-backup-fast` (Resolver follows Assessment) |
| Automatic elevation (and Elevation agent enabled) | `--sol-reassessment` |
| Worker tool guard | `--tool-guard` |
| Protected paths (Settings › Safety) | `--protected-paths` (JSON array) |
| Agents: assigned skills and custom instructions (up to 4,000 characters, added after the skills) | `--skills-file <state>\assigned-skills.json` (written at start) |
| Attached task file | `--task` (validated with the engine's own `validateTask`, used once) |

## Controls

Controls write the engine's `control.json` through its own `DashboardState`, with the same
semantics as the engine dashboard: **Pause** = pause after the current task, **Stop** = at the
next safe point, **Stop after current task** = pause, then stop once paused, **Stop now** =
terminate the process tree. Resume, Elevate and Resolve start the engine if it isn't running.

The engine runs detached with file-backed output (`<state>\app-engine.log`), so closing the window
or quitting the app can leave it running safely; the app reattaches on the next launch.

## Settings labels

Every setting carries a label: **Enforced by engine**, **Applied by app**, or **Saved only**
(stored for future engine support).
