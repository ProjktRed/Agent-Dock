# Agent Dock user guide

Agent Dock runs a coding loop on your project: **Assessment** plans one bounded task, the
**Implementation** agent makes the change, and **QA** checks it and commits it. Only QA commits, and
only changes inside the task's approved files. This guide covers everyday use; [How it
works](how-it-works.md) has the details behind each number and setting.

## Getting started

1. **Install** Agent Dock from the latest release (Windows installer or Linux AppImage). It updates
   itself from signed releases.
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

## Choosing a task size

Settings › Workflow rules › **Task size**, or per project in Projects › Workflow:

- **Eco** (default): many small tasks. Best for local models and for saving usage.
- **Standard**: one plan item per task. Use it on a Pro, Max or API plan, or with a local model with a
  large context. Fewer, larger tasks are usually faster overall.
- **Max**: no size limits. Agent Dock asks before turning it on, and a **Max limits** button appears
  in the sidebar so you can set your own caps. Use it only when you know your model and plan can take it.

**Suggested** shows which mode fits your Implementation agent. With **Step down** on, a large task
that fails review twice is redone one size smaller, so a stuck run keeps moving.

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
  Nothing is pushed until you press **Open pull request**.
- **GitHub CI** (Projects › Workflow): after Open pull request, the pushed commit's GitHub Actions
  runs show there, with a notification when they finish. Needs GitHub CLI signed in (`gh auth login`).
  **Fix CI failure** starts a run that fixes it from the failed log; with **Fix failures automatically**
  on, that happens by itself and the fix is pushed (at most 3 fix runs per push of yours).
- **Parallel tasks** (Settings › Workflow rules): up to 4 tasks of the same objective at once, each
  in its own worktree; each change is checked again on the combined code before it is committed.
  Needs a cloud Implementation agent. A task that did not finish or merge keeps its worktree and
  branch; Projects › Workflow › **Clean up parallel worktrees** removes them all once you are done.
- **Parallel lanes**: run another objective at the same time in a git worktree on its own branch.
  Each lane shows up as its own project; merge its branch when you are happy with it.
- **WSL isolation** (opt-in, Windows): the engine and agent CLIs run inside a WSL distro.

## Your own review steps

The **Workflow** page adds roles at three points: before implementation (guidance), before QA (a
review, optionally a **gate** that sends work back, or a **fixer** that fixes small problems itself),
and after QA passes (a report). Templates include a second-opinion QA on the other CLI.

## Troubleshooting

- **The run stopped with a usage limit**: the task waits with its changes kept. Resume when the
  window resets, or let Unattended mode retry every 30 minutes. A usage-limit backup agent on the
  other CLI (Agents) can take over for planning and review.
- **"Scope" or "HEAD" problems**: something changed files outside the task, or the branch moved.
  Agent Dock stops rather than guess. Check `git status`, then Resume or set the task aside.
- **QA could not run its tools**: an environment problem, not the code. Fix the tool or permission,
  then press **Retry QA**.
- **EPERM on Windows**: antivirus or indexing locked a state file. Excluding the engine state
  folders from real-time scanning usually fixes it.
- **An update failed**: nothing is installed unless every file matches the signed release. Try
  again from Settings › Updates; the full download is used if the smaller one does not match.
- **Where are the logs?** Projects › Workflow › Engine state folder › Open. Activity, run reports
  and each agent call are kept there.

See [Security boundaries](security.md) for what the guards do and do not protect against.
