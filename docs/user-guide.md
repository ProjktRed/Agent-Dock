# Agent Dock user guide

Agent Dock runs a coding loop on your project: **Assessment** plans one bounded task, the
**Implementation** agent makes the change, and **QA** checks it and commits it. Only QA commits, and
only changes inside the task's approved files. This guide covers everyday use; [How it
works](how-it-works.md) has the details behind each number and setting.

## Getting started

1. **Install** Agent Dock from the latest release (Windows installer or Linux AppImage). It updates
   itself from signed releases, downloading only what changed when it can (on Linux, a binary patch of
   the AppImage).
2. **CLIs**: on first launch Agent Dock finds the agent CLIs on your PATH (Codex, Claude Code, Cline,
   OpenCode) and local model servers (llama.cpp, Ollama). Sign in to each CLI in its own terminal
   first; Agent Dock never handles those logins.
3. **Agents**: one agent per role is created for you. Check **Agents** to choose models, effort and
   speed. Codex or Claude Code can plan and review; any of the four CLIs can implement.
4. **Add a project** (Projects › Add): a git repository with a clean working tree. Write an
   **objective** (Ctrl+K), for example "Add per-route overrides to the rate limiter config and cover
   them with tests". An `IMPLEMENTATION_PLAN.md` with checkbox items helps: Agent Dock ticks items off
   as tasks are approved, and the planner (Projects › Implementation plan) can write one for you.
5. **Run** (F5). Overview › Progress shows the current stage; Activity shows every step.

When something needs you (a manual review, a blocked case, a usage limit), the project shows
**Resolve attention** with the reason and the choices.

## CLI settings

CLIs › select a connection › **Settings**:

- **Codex and Claude Code: run settings.** Used for every Assessment, QA, Resolver, Elevation and implementation run:
  for Codex the reasoning summary, verbosity, AGENTS.md read limit, tool output limit and when to compact;
  for Claude Code a fallback model, output and thinking tokens, command timeouts, and turning off
  telemetry and error reports. Settings that could loosen what Agent Dock allows (sandbox, approvals,
  permissions, hooks, network, MCP) are not offered. When Codex or Claude Code implements a task, the task
  scope guard's own flags come after them, so the guard always has the last word.
- **Cline and OpenCode: run settings.** Used when they implement a task: for Cline the retries (mistakes
  in a row before it stops) and how it compacts a long conversation; for OpenCode the most steps per
  task and the model's reasoning variant. Agent Dock runs both with their own config kept apart, so
  there is no config file of theirs to show here.
- **Codex and Claude Code: where their own config file is** (`~/.codex/config.toml`,
  `~/.claude/settings.json`, or under `CODEX_HOME` / `CLAUDE_CONFIG_DIR`). **Show config file** shows it
  in your file manager so you can edit it in your own editor. Agent Dock does not change it: it changes
  the CLI everywhere, also outside Agent Dock.
- **Ollama: its server settings** (requests at once, default context length, KV cache type, flash
  attention, keep-alive, models loaded at once, models folder), as the running Ollama uses them (from
  its `server.log`) and as your Windows user environment has them. Change them in Ollama's own settings
  window or as environment variables, then restart Ollama; Agent Dock does not change them. Set the
  connection's **Requests at once** to match `OLLAMA_NUM_PARALLEL`.

Cline, OpenCode, the OpenAI-compatible providers and llama.cpp's server settings are not on this tab
yet.

## Choosing a task size

Settings › Workflow rules › **Task size**, or per project in Projects › Workflow:

- **Eco** (default): many small tasks. Best for local models and for saving usage.
- **Standard**: one plan item per task. Use it on a Pro, Max or API plan, or with a local model with a
  large context. Fewer, larger tasks are usually faster overall.
- **Max**: no size limits. Agent Dock asks before turning it on, and a **Max limits** button appears
  in the sidebar so you can set your own caps. Use it only when you know your model and plan can take it.

**Suggested** shows which mode fits your Implementation agent.

## Running unattended

Settings › Execution & safety › **Unattended mode** (or per project): the run continues by itself
with the tool guard on, and stops at the limits you set: approved tasks, hours, corrections per task,
Elevations, tokens and spend per run and per day. A run report is written at the end (Overview ›
Runs, exportable as Markdown or HTML).

**Scheduled runs** (Projects › Workflow) start a project at a set time on chosen days. On Windows,
**Also when closed** lets Task Scheduler launch Agent Dock for it. Pair a schedule with Unattended
mode for overnight work, and check the run report in the morning.

- **Late starts**: a start up to 30 minutes late still runs, also past midnight (a 23:50 start
  checked at 00:05 counts). Later than that it is skipped, never run hours late.
- **On a laptop** (Also when closed): the task starts on battery too, and the run is not stopped
  when you unplug.
- **Catch-up**: if the PC was asleep or off at the start time, Task Scheduler launches Agent Dock as
  soon as it can. Within 30 minutes the run starts as usual; later, the start is skipped and
  reported as **missed**.
- **Wake to run** (with Also when closed, off by default): lets Task Scheduler wake the PC from
  sleep for the start. It cannot start a PC that is shut down or hibernating, and Windows does not
  wake it if wake timers are off in the power plan (Control Panel › Power Options › Change advanced
  power settings › Sleep › Allow wake timers).
- **Notifications**: a scheduled start that could not start, or was missed, goes to your saved
  notification channels (webhook, Discord, Slack, Telegram and email) and to a Windows notification
  when **Usage limits and engine exits** is on. A start that went ahead goes to the same channels
  except email. Each missed start is reported once, and only for Also when closed schedules.
- If Task Scheduler refuses the task's settings, Agent Dock creates it with Windows' default
  settings instead and warns you; those may skip starts on battery and never catch up.
- **Linux (AppImage)**: Also when closed adds a systemd user timer (`~/.config/systemd/user/agent-dock-run-*`)
  that launches the AppImage minimized. No root; it runs while you are signed in, and a start missed while
  the PC was off runs at the next sign-in (reported as missed when it is past the grace period). Wake to
  run is Windows only. Keep the AppImage where it is, or open the new copy once so the timers follow it.

## Project checks and safety

Checks such as `npm test` run the project's own scripts and tests, which agents can edit. Settings ›
Execution & safety › **Project checks** decides how much Agent Dock trusts them:

- **Off (the default)**: while a run is going, Agent Dock watches its own settings and engine files.
  Anything else that changes them is put back (the changed copy is kept beside it, named
  `<file>.changed-<time>`), and every run stops with a notice. Review the last task's changes before
  you resume.
- **On**: checks run as your own code and nothing is watched. Use it only for projects whose tests you
  trust completely.

Neither setting is a sandbox: a check can still read the project's files. Turning off the tool guard,
trusting checks, unprotecting a path or changing a program Agent Dock runs asks you to confirm first.

## Spend and usage

- Overview › Usage shows your Codex and Claude plan windows as reported by the CLIs themselves.
- Spend budgets count the cost the CLIs report. Codex reports only tokens, so add its models to
  Settings › Execution & safety › **Price table** to include them.
- Overview's **Estimate for the rest** gives the time, tokens and spend for the remaining plan
  items at this project's own pace, per task size.

## Reviewing and sharing work

- **Task history** (Projects): every task with its outcome. **Run again** repeats one with the same
  prompt, files and check.
- **Pull-request mode** (Projects › Workflow): each run works on its own `agent-dock/run-…` branch.
  Nothing is pushed until you press **Open pull request**. On GitLab this opens a merge request.
- **GitHub CI** (Projects › Workflow): after Open pull request, the pushed commit's GitHub Actions
  runs show there, each linking to GitHub, with a notification when they finish. Needs GitHub CLI
  signed in (`gh auth login`).
- **Parallel tasks** (Settings › Workflow rules): up to 4 tasks of the same objective at once, each
  in its own worktree; each change is checked again on the combined code before it is committed.
  Needs a cloud Implementation agent. A task that did not finish or merge keeps its worktree and
  branch; Projects › Workflow › **Clean up parallel worktrees** removes them all once you are done.
- **WSL isolation** (opt-in, Windows): the engine and agent CLIs run inside a WSL distro.

## Your own review steps

The **Workflow** page has one optional **Second review** before QA, on an agent using the other CLI
from QA. When it finds a concrete problem, the attempt goes back for correction instead of to QA.

## Troubleshooting

- **The run stopped with a usage limit**: the task waits with its changes kept. Resume when the
  window resets, or let Unattended mode retry every 30 minutes. A usage-limit backup agent on the
  other CLI (Agents) can take over for planning and review.
- **"Scope" or "HEAD" problems**: something changed files outside the task, or the branch moved.
  Agent Dock stops rather than guess. Check `git status`, then Resume or set the task aside.
- **QA could not run its tools**: an environment problem, not the code. Fix the tool or permission,
  then press **Retry QA**.
- **"Stopped every run: something other than Agent Dock changed its own files"**: a check or another
  program changed Agent Dock's settings or engine during a run. The settings were put back; look at
  the `.changed-` copy in the config folder and at the last task's diff before you resume. If Agent
  Dock's engine files were changed, reinstall or update before running again.
- **Remote approvals by email**: an email reply can only Stop or Dismiss. Resume, Elevate, Resolve and
  Retry QA are answered in the app or with the Telegram buttons.
- **EPERM on Windows**: antivirus or indexing locked a state file. Excluding the engine state
  folders from real-time scanning usually fixes it.
- **An update failed**: nothing is installed unless every file matches the signed release. Try
  again from Settings › Updates; the full download is used if the smaller one does not match.
- **Where are the logs?** Projects › Workflow › Engine state folder › Open. Activity, run reports
  and each agent call are kept there.

See [Security boundaries](security.md) for what the guards do and do not protect against.
