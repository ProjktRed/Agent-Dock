# How it works

Where each number in Agent Dock comes from, and how the loop's roles, limits and safeguards behave.

## Usage limits

All **Reported** by the provider's own CLI, with an "as of" time.

- **Codex**: the official app-server method `account/rateLimits/read` (`codex app-server` over
  stdio, `initialize` + one read). Plan, 5-hour and weekly windows (used %, reset time), credits and
  reset-credit count. Read-only and free; refreshed every 5 minutes by default. The reset-credit
  *consume* method is never called.
- **Claude Code**: the SDK control request `get_usage` (`skip_behaviors: true`, after `initialize`)
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
  of each attempt. No cost is estimated (no pricing is configured;
  subscriptions expose none). The current context occupancy is not reported by any runtime, so it is
  not shown as a number.
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

## Loop limits

Editable with guardrails off; the defaults are the engine's built-in values: automatic Elevation
after 3 attempted corrections; no correction limit (with one, the loop stops for you after that many
corrections on a task, and Resume allows another round); 3 Resolver strategies per task;
Assessment's task sizing for the worker (1 file per task, new files under about 200 lines, at most 3
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

Workflow tab: your own read-only roles at three points in the loop.

- **Before implementation**: runs once per task; its guidance is added to every worker prompt for
  that task.
- **Before QA**: reviews each finished attempt; QA and Assessment read its findings. As a **gate**,
  "changes needed" sends the attempt back for correction instead of to QA, and a gate that cannot run
  blocks the task rather than letting the change through unreviewed.
- **After QA passes**: writes a report to `role-reports.ndjson` in the project's state folder.

Each role is a `ROLE.md` (frontmatter `name`, `description`, `stage`, `gate`, `enabled`, then the
instructions) under `%APPDATA%\Agent Dock\roles\<id>`; import a folder of them from the Workflow
tab. A role runs on the agent assigned to it: an agent with the role "Workflow role" on Codex CLI or
Claude Code, with its own model, effort and speed. Roles go through the orchestrator lock, are
checkpointed like other engine operations (a resumed run never repeats a finished role), wait on
usage limits like QA, and never edit files, commit or change HEAD. A role without an enabled agent
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

## Known limitations

- Workflow roles are read-only reviewers and planners; they cannot edit files.
- On some Windows machines the engine's atomic state writes can hit `EPERM` on rename (a file lock,
  usually antivirus or indexing). The engine retries a blocked rename for about five seconds; if a
  lock lasts longer, excluding the engine state folders from real-time scanning is the usual fix.
- A Cline or OpenCode worker on an OpenAI-compatible cloud provider receives that provider's API key
  in its environment, because the CLI calls the provider itself. Use a key limited to that provider
  and project, with a spending cap at the provider.
- Spend budgets count the cost a CLI reports (Claude Code, OpenCode, and Cline on a cloud provider).
  Codex reports only tokens, so its spend counts only for models listed in Settings › Execution & safety
  › Price table, which estimates cost from the tokens. Local model servers (llama.cpp, Ollama) cost
  nothing and are never priced; token budgets still include their tokens.
