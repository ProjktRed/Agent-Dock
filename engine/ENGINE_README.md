# Codex ↔ Cline/GLM loop

The dependency-free Node process owns the continuous loop. Codex runs as a fresh,
one-shot CLI child only for assessment and QA. Cline implements each task.
The dashboard design and the Ollama model-loading behavior are unchanged.
llama.cpp is the default implementation backend; Ollama remains available only
when it is selected explicitly.

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

By default Cline uses llama.cpp at `http://127.0.0.1:8081/v1` with model
`glm-4.7-flash-ud-q3-k-xl`. The automation maps `--provider llamacpp` to Cline's
`openai-compatible` provider and defaults to a 98,304-token context and 8,192-token
maximum output. Before every Cline attempt, Node checks `/health` and `/v1/models`
and requires the exact model identifier. If the endpoint is unavailable and a launcher script
is set (`--llamacpp-launcher <script>` or the `LLAMACPP_LAUNCHER` variable), it starts that
script and waits up to 120 seconds; without one it stops with an explanation. A
startup timeout or model mismatch is logged and stops the attempt. It never causes
an automatic Ollama fallback.

Select the preserved Ollama path explicitly with `--provider ollama`. Unless
overridden, this continues to use `glm-4.7-flash:q4_K_M` and 98,304 context tokens.
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
Implementation is still Cline + local GLM via llama.cpp.

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
`WAITING_FOR_CODEX`, and waits for a manual Resume. Resume reruns only the saved
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
keep GLM loaded between tasks; no model unload operation is performed.

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

### Cline editing guard

Normal and Elevate-driven Cline attempts install automation-owned `PreToolUse`
and `PostToolUse` hooks under `<state-dir>/cline-guard/config/hooks`. The CLI
receives that isolated `--config` directory and retains its existing provider
`--data-dir`; no global Cline installation/settings are changed.

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
