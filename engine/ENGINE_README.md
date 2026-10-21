# Agent Dock engine

The dependency-free Node process that owns Agent Dock's automation loop. The orchestrator CLI
(Codex CLI or Claude Code) runs as a fresh, one-shot child for Assessment, QA, Resolver and
Elevation. The Implementation worker is Cline or OpenCode on a local or OpenAI-compatible model,
or Codex CLI / Claude Code. Agent Dock launches it per project; it can also run on its own from a
terminal, with its own dashboard.

## Start dashboard and loop

From the `engine/` folder:

```powershell
npm run dashboard -- --workspace <path-to-repo> --objective "YOUR BOUNDED PROJECT OBJECTIVE" --port 4180
```

The command automatically opens http://127.0.0.1:4180 in the default browser.
The server binds only to 127.0.0.1.
Replace the objective before running. This command begins real project work.
Run it from an ordinary terminal; no supervising Codex chat needs to stay active.

Codex must be installed and authenticated. By default the adapter launches the
`codex` executable on PATH; use `--codex-exe <absolute-path-to-codex.exe>` if needed.
Assessment and independent QA use `gpt-6.1-sol` with medium reasoning.
Elevate/reassessment uses `gpt-6-astra` with medium reasoning.

With `--provider llamacpp` (the default) Cline uses llama.cpp at `--llamacpp-url`
(default `http://127.0.0.1:8080/v1`, llama-server's own port) with the model named by
`--model`; there is no default model. The automation maps it to Cline's
`openai-compatible` provider and defaults to a 98,304-token context and 8,192-token
maximum output. Before every Cline attempt, Node checks `/health` and `/v1/models`
and requires the exact model identifier. If the endpoint is unavailable it starts the
server: a launcher script when one is set (`--llamacpp-launcher <script>` or the
`LLAMACPP_LAUNCHER` variable), otherwise `llama-server` from PATH in router mode when
`--llamacpp-models-dir` is set. It waits up to 120 seconds; with neither it stops with an
explanation. A startup timeout or model mismatch is logged and stops the attempt. It never
causes an automatic Ollama fallback.

Remote OpenAI-compatible providers include OpenRouter and OpenCode Console (Zen).
For OpenCode Console, use `--provider opencode` and model `deepseek-v4.1-flash-free`
by default; its model preflight reads `https://opencode.ai/inference/v1/models`,
while chat requests use `https://opencode.ai/inference/openai/v1`. Supply the API
key through `AGENT_DOCK_PROVIDER_KEY` (or `--provider-api-key-env`).

Select Ollama explicitly with `--provider ollama` (address: `--ollama-url`, default
`http://127.0.0.1:11434`) and name the model with `--model`; the default context is
98,304 tokens.
Node reads the selected Ollama model's `/api/show` metadata; missing context
metadata or insufficient declared context stops startup without silently reducing
the request. Both providers write `.state/cline-data/settings/providers.json` and
pass that isolated directory to Cline with `--data-dir`.

`--cline-context-tokens`, `--cline-max-output-tokens`, and `--timeout-seconds`
accept positive-integer task-level overrides. Explicit overrides remain
authoritative.
Existing `--cline-js`, `--provider`, `--model`, `--state-dir`, and
`--poll-seconds` options remain available.
An optional `--task task.json` supplies an already-authored first task; subsequent
tasks still come from Codex assessment of the required objective.

## Claude orchestrator (`--orchestrator claude`)

Default is `--orchestrator codex` (unchanged behaviour). With `--orchestrator claude`
the Codex roles run through the Claude Code CLI (`claude -p --json-schema`), using the
same prompts, schemas, PID lock, usage-limit pause/Resume and Node scope checks:
Assessment, QA and Resolver use **Sonnet**, Elevation uses **Opus**, all at medium effort.
Implementation keeps its own worker (`--implementation-cli`).

- Prerequisite: the standalone CLI must be logged in (`claude auth status` → `loggedIn: true`).
  Preflight fails before any work if it is not.
- Children get a clean environment (all `CLAUDE*` variables stripped), so they never attach
  to an interactive Claude session.
- Tools: no role gets file editing (`Edit`/`Write` are disallowed) or an unrestricted shell.
  Assessment/Resolver/Elevation get Read/Grep/Glob and read-only git. QA additionally gets
  only `npm test`, `npm run typecheck|lint|build|format:check|test`, `npx vitest run`,
  `npx playwright test`, `npx prettier --check`, `git add` and `git commit`.
- Optional: `--claude-command <path>` (default `claude` on PATH).
- Code: `src/claude-worker.mjs`, tests: `test/claude-worker.test.mjs`.

Launch from PowerShell with `node` directly, because `npm run` through cmd.exe splits
objectives that contain double quotes:

```powershell
node src/dashboard-cli.mjs --workspace <path-to-repo> --objective "<objective>" --port 4180 --orchestrator claude --state-dir .state-<name>
```

## Implementation through Codex or Claude Code (`--implementation-cli`)

Default is `--implementation-cli cline` (Cline + local model, unchanged). With `codex` or
`claude` the implementation worker is `src/cloud-impl-worker.mjs`:

Codex and Claude enforcement are adapters of the shared `src/guard/` layer;
Codex keeps its per-call hook and Claude keeps its argv-only permission lists.

- `--implementation-model`, `--implementation-effort`, `--implementation-fast` and
  `--timeout-seconds` apply; the Cline runtime (llama.cpp start, provider checks) is skipped.
- Claude Code: `claude -p --permission-mode dontAsk`; `Edit`/`Write` are allowed only for the
  task's `allowedPaths`. With `--tool-guard true` the shell is limited to its `qaCommand`,
  lint/typecheck and read-only git. Git write commands (commit, add, reset, checkout, stash…) are
  always denied.
- Codex: `codex exec --approve-for-me` (the workspace-write sandbox QA uses) plus a `PreToolUse`
  hook passed with `-c hooks.PreToolUse=…` and `--dangerously-bypass-hook-trust` (the engine writes
  the hook itself for every run). `src/codex-scope-hook.mjs` runs the `src/guard/adapters/codex.mjs` adapter:
  patches may only add, update, delete or move the task's `allowedPaths` (also with the tool guard
  off); with `--tool-guard true` shell commands are limited to the task's check, lint/typecheck and
  read-only commands, and MCP tools are denied. Decisions go to `<state>/codex/<id>/scope-hook.ndjson`
  (`implementation-scope-blocked` events); if Codex used tools but the hook logged nothing, the
  attempt is refused (fail closed).
- Same lock file as Cline (`cline.busy.lock`), same never-replay rule after an interruption, same
  scope/HEAD verification and independent QA. The prompt and output go to `<state>/codex/<id>/`
  so token usage is recorded.

## Workflow roles (`--roles-file`)

A JSON array of read-only roles (`src/workflow-roles.mjs`):
`{ id, name, stage, gate, cli, model?, effort?, fast?, instructions, enabled? }`, where `stage` is
`before-implementation`, `before-qa` or `after-pass` and `cli` is `codex` or `claude`. Each role
returns `{ verdict: pass|changes-needed, summary, findings[], guidance }`.

- `before-implementation`: once per task; `guidance` is appended to every worker prompt.
- `before-qa`: a new recovery phase `review` between evidence and QA, once per attempt. Results
  are added to the QA packet as `roleReviews`. A `gate` role returning `changes-needed` turns the
  attempt into a recoverable failure (HEAD verified unchanged) that goes to correction Assessment
  without calling QA. A gate that fails to run blocks; an advisory role that fails is recorded
  (`role-error`) and skipped.
- `after-pass`: after the commit; reports are appended to `<state>/role-reports.ndjson`.

Roles run through `runRecoverableCodex` (`role:<id>` operations: usage-limit wait, pending
receipts) and each result is checkpointed in `current-task.json`, so a resumed run never repeats
a finished role. Events: `role-started`, `role-finished`, `role-result`, `role-error`,
`role-gate-failed`.

## Loop limits

Defaults reproduce the original fixed behaviour (`src/engine-tuning.mjs`):

| Flag | Default | Meaning |
| --- | --- | --- |
| `--elevation-after` | 3 | Attempted Assessment corrections before automatic Elevation |
| `--max-corrections` | 0 (none) | Corrections per task before stopping for user attention (`correction-limit`); Resume grants another round |
| `--resolver-max-strategies` | 3 | Distinct Resolver recovery strategies per task |
| `--task-max-files` | 1 | Task sizing in the Assessment prompt |
| `--task-max-new-lines` | 200 | New-file size in the Assessment prompt |
| `--task-max-read-files` | 3 | Files the worker may be told to read |
| `--task-mode` | `eco` | Task size: `eco` (small tasks, the `--task-max-*` values above), `standard` (one plan item per task: 10 files, 800 new lines, 10 read files) or `max` (no fixed size: 0 = no limit). Explicit `--task-max-*` flags override the mode's sizing. Anything else is an error |
| `--step-down` | `true` | `true` or `false`. In `standard` or `max` mode, a task that fails review twice is set aside and redone one size smaller (max to standard, standard to eco). The smaller size lasts until that task's plan items are checked off or 5 tasks are approved, then the configured size returns. Saved in `step-down.json`, so a resumed run keeps it; discarded if the configured size changed. No effect in `eco` mode |

## Parallel tasks

| Flag | Default | Meaning |
| --- | --- | --- |
| `--parallel` | 1 | Tasks per round, a whole number from 1 to 8 (the app passes at most 4). Above 1, each round Assessment picks tasks whose allowed files do not overlap, and each runs in its own engine and git worktree (`<project>-parallel/<task>-<run>`, branch `agent-dock/parallel-…`); approved changes are applied to the branch one at a time, checked on the combined code and committed only if the check passes |
| `--single-task` | `false` | Internal: set (`true`) by a parallel run on each task's own engine. That engine runs the one task given with `--task`, then ends; it leaves plan check-offs and approved plan changes to the parent, sends no notifications and runs no Supervisor. Not meant to be passed by hand |

`--parallel` above 1 falls back to one task at a time (logging `{"parallel":{"lanes":1,"reason":…}}`)
with `--unattended true`, with `--task` or `--single-task`, while a pending orchestrator call is
resumed, or while a task is still in progress (it finishes first; parallel rounds start from a task
boundary). The app also passes `--parallel` only for a cloud Implementation agent. A task's engine
gets the parent's arguments without `--parallel`, `--step-down` (always `false` there) or the
Supervisor flags; while the parent is stepped down it gets the smaller `--task-mode` and
`--task-max-*` values instead of the configured ones. Each task's usage, per role, is added to the
run when its engine ends.

## Process lifecycle

1. Node acquires the existing Cline lock and checks a clean git baseline.
2. Node launches `codex exec --ephemeral --json --output-schema … --output-last-message … -`
   for read-only assessment. The prompt travels over stdin.
3. Node waits for the Codex child's **close** event, not merely the output JSON.
4. Node launches Cline only after Codex has exited and its stdio handles have closed.
5. After Cline exits, Node launches a fresh Codex invocation for diff review and QA.
6. Codex runs checks. On FAIL it returns findings and an exact bounded correction prompt,
   without fixing source or committing. On PASS it commits approved work and returns
   the commit hash and QA evidence. QA uses workspace-write with automatic approval
   review; unavailable permissions result in manual review, not sandbox bypass.
7. Node waits for Codex to close, checks the result, and either launches the Cline
   correction or starts a fresh assessment after PASS. Actionable QA failures have
   no numeric retry limit. On attempts 5, 10, 15, and so on, Codex must reassess
   the root cause and issue a materially revised correction strategy.

An implementation/strategy `MANUAL_REVIEW` gets one automatic, short-lived
reassessment from `gpt-6-astra` with medium reasoning. Astra may recommend one
materially revised bounded correction. After Astra exits, independent Codex QA
evaluates that advice and writes the actual Cline correction. A second manual
review after that correction stays manual.
Scope, HEAD, state-corruption, unsafe-commit, permission, and security/policy
failures never auto-escalate. Sol reassessment is enabled by default; disable it
with `--sol-reassessment false`.

Every assessment/QA and Cline handoff receives the local shared skill in
`skills/bounded-task-handoff/SKILL.md`. Codex selects `Task skill: diagnose`,
`implement`, or `verify`; Node supplies the corresponding short reference to
Cline. New assessments must select a valid mode; existing saved tasks remain
compatible using the implementation mode when no selection is present.
Cline's final report identifies exact changes, commands actually run and their
results, evidence, and blockers. This report does not replace independent QA.
Manual Elevate advice also returns through QA before a revised correction is
stored. Once independent QA exits, Node automatically continues that saved
correction through Cline and normal QA, retaining the baseline, existing diff,
original scope, and next attempt number. Pause/Stop and process-idle checks still
apply. HEAD/scope violations block the launch. This bounded continuation stops
after the current task rather than selecting another backlog item. A started
correction is marked in the existing correction-task.json and cannot be replayed
from the same completed advisory QA operation.

There is no Codex child alive during a Cline attempt. This applies to processes
owned by this loop; unrelated Codex desktop/CLI sessions are not terminated.
The process PID is recorded in the existing .state directory so a surviving
child from an interrupted manager prevents a new launch. Prompts prohibit
nested Codex/Cline launches and background processes.

Node verifies that PASS corresponds to one new commit on the captured baseline,
only approved file paths, and a clean working tree. Non-PASS must not change HEAD.
Malformed output, unsafe scope, permission errors, and an explicit Codex
manual-review decision stop for manual review. Failed work is left in place for inspection and is never
automatically reset or committed by Node. After a crash, a dirty baseline blocks
automatic restart, preserving work for manual review.

A structured Codex usage-limit or credit-exhaustion failure is recoverable rather
than QA FAIL. The loop writes `.state/pending-codex.json`, enters
`WAITING_FOR_LIMIT` (`WAITING_FOR_CODEX` before 0.32), and waits for a manual Resume. Resume reruns only the saved
Codex assessment or QA operation with the same inputs; it does not rerun Cline or
change the attempt number. Any reported retry/reset text is displayed verbatim.

## Controls and state

Pause After Task waits in Node between tasks until Resume. No Codex process is
used while paused. Stop requests are handled before launch or after the current
Cline/QA attempt reaches a safe boundary. Neither control interrupts active work.

The existing .state files remain authoritative:
- live.json and control.json: atomic replacement
- activity.ndjson: append-only transition log
- current-task.json and correction-task.json: bounded task handoffs
- last-result.json: latest task QA/history
- loop-result.json: terminal outcome
- codex-process.json: live child PID (removed after close)
- pending-codex.json: interrupted Codex operation, exact inputs, and limit details
- codex/<invocation-id>/: prompt, output schema, final JSON, and process output

The dashboard logs show Codex assessment/finish, Cline start/work/finish, and Codex
QA start/finish without a layout change. Every llama.cpp attempt records a
`cline-provider-ready` event with requested and effective provider, endpoint,
port, and model. `/metrics` is sampled before and after the attempt and a
`cline-provider-metrics` event records prompt tokens, generated tokens, prompt
tokens/second, generation tokens/second, and failure state. Metrics-read failures
are explicit events and do not masquerade as successful measurements. Ollama may
keep the model loaded between tasks; no model unload operation is performed.

## Verification

## Blocked-case Resolver and implementation progress

Assessment and blocked-case Resolver use `gpt-6.1-sol` with medium reasoning;
QA also uses 6.1 Sol Medium. Elevation remains Astra Medium.

`Resolve Block` requests one short-lived, read-only Resolver operation through
the existing dashboard control state. Identical cases cannot run twice, and a
worker in progress disables the control. Usage exhaustion preserves the exact
pending Resolver input for manual Resume.

Valid saved BLOCKED cases automatically invoke the read-only Resolver once all
workers are idle. Operational editing-guard blocks may receive a different native
tool/approved-command strategy only after HEAD, scope and the diff are independently
rechecked. Resolver advice and capabilities go to Assessment, never directly Cline.
Unchanged cases are deduplicated; at most three distinct recovery strategies are
applied per task, including scratch recovery. Pause at a blocked safe point and
Stop prevent automatic invocation. Usage limits use the existing pending Resume.
The last rejected tool/command is bounded in the existing guard policy, not stored
as a full transcript. Hooks still cancel unsafe execution; they do not silently
permit it just to keep the worker alive.

Automatic scratch preservation is restricted to current-run, explicitly observed scratch
writes: unchanged, untracked, top-level helper files whose hashes and baseline
prove ownership. They are copied and hash-verified in the state's
`resolver-archive` outside the target repository before removing the originals.
A durable journal reconciles interrupted preservation. Unknown, pre-existing,
tracked, or changed files are never cleaned automatically. Permission, security,
Git HEAD, unsafe-commit and malformed-state blocks remain blocked.

Successful safe recovery proceeds to Assessment, then Cline, then independent
QA; Resolver cannot accept or commit work. Legacy blocked runs without ownership
evidence require manual review and are not retroactively trusted.

The recessed dashboard's left progress list reads the target repository's
`IMPLEMENTATION_PLAN.md` checkboxes, rather than estimating task acceptance.
Phase expansion is client-side and survives polling.

## Verification commands

### Worker tool guard

Normal and Elevate-driven Cline attempts install automation-owned `PreToolUse`
and `PostToolUse` hooks under `<state-dir>/cline-guard/config/hooks`. The CLI
receives that isolated `--config` directory and retains its existing provider
`--data-dir`; no global Cline installation/settings are changed. Guard policy,
state, decisions and edit discipline live in the backend-agnostic `src/guard/`
layer, with a Cline adapter translating its tools and hook controls.

Each guarded attempt also generates a small SDK plugin in that isolated config.
`disabledTools` hides unrelated tools; before every model request the plugin
whitelists native read/search/editor/patch/skills/question/completion tools and
restricts `run_commands.commands` to exact approved command choices. The launcher
pins `CLINE_GLOBAL_SETTINGS_PATH` to the automation-owned settings even when the
provider uses a separate data directory. No global CLI files are patched.

Native `editor`/`apply_patch` writes must stay inside the task's `allowedPaths`,
including resolved junction/symlink parents. Shell commands are limited to the
exact task QA command, lint/typecheck, exact-file Prettier **check/write**, and bounded
read-only Git inspection. Interpreters, output redirection, shell-based source
writes and helper creation stop the attempt before execution. Ordinary unsupported
tool/command requests instead return a tool error without executing or aborting:
the model can select a permitted tool next. Three invalid requests in one attempt
stop for existing reassessment. Invented names absent from the SDK registry count
too. Scope escapes, unsafe Git and unavailable/corrupt guard state remain hard stops.
Two consecutive native editing failures also stop it, including failures wrapped
as `success:false` inside an otherwise successful Cline tool result. A successful
edit resets the failure count. Aborted runs cannot be accepted merely for exit 0.

The atomic per-attempt policy/counter is stored in `<state-dir>/cline-guard/policy.json`.
Counters reset only when a new worker attempt is prepared. A guard stop preserves
the diff, releases the normal busy lock and enters the existing controlled blocked
path; it does not commit, rerun Cline or shut down the dashboard/model server.
This is a tool guard, not an OS security sandbox: approved validation scripts can
still generate their normal artifacts, and independent Git scope QA remains required.
It cannot erase the model's learned tool names; it hides their schemas and rejects
invalid requests. Restrictions are prepared at the next worker attempt, never by
changing a running Cline session. Missing plugin initialization refuses completion.

The guard records the tools actually exposed by the runtime for Assessment and
Resolver; allowing a name does not install that tool. Existing-file editor calls
require a successful, still-current `read_files` range and a unique replacement
match, or an insertion within that read range. Editor fields are limited to 2000
characters; patches to 4000. Failed identical native edits cannot be repeated.
The last four failures retain bounded inputs, error text and source excerpts in
the existing guard policy. SDK skip/result notifications count as one failure.
Correction handoffs put the next change first and include original acceptance
criteria once, without replaying nested obsolete strategies.

```powershell
npm test
node --test test/codex-lifecycle.test.mjs
node scripts/live-integration.mjs
```

The lifecycle test starts real OS child processes standing in for Codex and Cline.
Fake Codex writes its JSON, then stays alive briefly. During each fake Cline run,
the child repeatedly probes every recorded Codex PID and fails if any is alive.
The test covers assessment → FAIL → correction → PASS → next assessment.

`npm test` and the lifecycle test do not invoke a live model or perform real
project work. `scripts/live-integration.mjs` is an explicitly invoked end-to-end
proof: it creates an isolated temporary Git repository with a failing JavaScript
test, has Cline inspect/edit/test it through llama.cpp, then passes the scoped diff
to the existing Codex QA and commit workflow.

No vision model is configured by this integration. A later vision addition needs
a separate llama.cpp-compatible multimodal GGUF plus its matching projector file,
a dedicated server/port and launcher, and a Cline provider/model entry with image
capability. It should be benchmarked independently rather than sharing the coding
model's VRAM budget.
