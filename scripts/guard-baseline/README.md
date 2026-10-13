# Guard baseline — Part 1 of the backend-agnostic guard plan

This directory records what the implementation worker's guard does **today**, precisely enough that
the Part 2 refactor can be proven to change nothing. It adds no production code and modifies no
file under `engine/src/` or `src/`.

The thing being protected is a string contract. `blocked-resolver.mjs:77` decides whether a blocked
run can recover automatically by regex-matching the worker error composed at
`cline-cli-worker.mjs:564` from the guard's own denial reason. If any of those strings drifts, a
recoverable block silently becomes a permanent one and nothing in the codebase notices.

## How to run

All paths are relative to this directory. `2>/dev/null` is always safe: the engine's own
diagnostics go to stderr, and every message these scripts produce goes to stdout.

```sh
# Tier A — the authoritative baseline. No Cline, no model, no network.
node scripts/guard-baseline/capture.mjs --impl old --out baseline/old

# Determinism: the same capture twice must be byte-identical.
node scripts/guard-baseline/capture.mjs --impl old --out baseline/old-again
node scripts/guard-baseline/compare.mjs baseline/old baseline/old-again

# Replay: feed the recorded inputs back through a guard and compare.
node scripts/guard-baseline/replay.mjs --impl old --mode sequence --in baseline/old --out replay/old-seq
node scripts/guard-baseline/replay.mjs --impl old --mode isolated --in baseline/old --out replay/old-iso
node scripts/guard-baseline/compare.mjs baseline/old replay/old-seq
node scripts/guard-baseline/compare.mjs baseline/old replay/old-iso

# Tier B — fidelity confirmation against a real Cline CLI driven by the stub server.
# On this machine the CLI is a local npm install, not the engine's Windows %APPDATA% default:
#   /workspace/tools/cline/node_modules/cline/bin/cline   (Cline CLI 3.0.70)
node scripts/guard-baseline/capture.mjs --impl old --tier B --out baseline/old-cline \
  --cline-js /path/to/node_modules/cline/bin/cline --timeout-seconds 150
node scripts/guard-baseline/capture.mjs --impl old --tier B --out baseline/old-cline-again --cline-js …
node scripts/guard-baseline/compare.mjs baseline/old-cline baseline/old-cline-again
```

Part 2's gate is the same commands with `--impl new`, which resolves to
`engine/src/guard/adapters/cline.mjs` instead of `engine/src/cline-tool-guard.mjs`:

```sh
node scripts/guard-baseline/capture.mjs --impl new --out baseline/new
node scripts/guard-baseline/compare.mjs baseline/old baseline/new    # only the declared import URL
node scripts/guard-baseline/replay.mjs --impl new --mode isolated --in baseline/old --out replay/new-iso
node scripts/guard-baseline/replay.mjs --impl new --mode sequence --in baseline/old --out replay/new-seq
node scripts/guard-baseline/compare.mjs baseline/old replay/new-iso
node scripts/guard-baseline/compare.mjs baseline/old replay/new-seq
```

Flags: `--impl old|new`, `--tier A|B|both`, `--out <dir>`, `--only <case,case>`,
`--cline-js <path>` (or `CLINE_JS`), `--timeout-seconds <n>` (Tier B, per scenario),
`--context-tokens <n>` (Tier B). `compare.mjs` takes two trees and `--verbose`.

## Layout

| Path | What it is |
| --- | --- |
| `capture.mjs` | the recorder: Tier A, the Codex rail, and Tier B |
| `replay.mjs` | re-feeds a recorded Tier A baseline's inputs through a guard implementation |
| `compare.mjs` | the gate: exact-string structural diff of two trees, one declared allowance |
| `inventory.mjs` | the reason-string contract — every denial/cancel/throw string, quoted with its `file:line` |
| `scenarios.mjs` | the task, the seed files, and the scripted model scenarios |
| `direct-cases.mjs` | the decisions no scripted model turn can express |
| `codex-cases.mjs` | the Codex `PreToolUse` scope rail, frozen before Part 2 folds it in |
| `stub-llamacpp.mjs` | an OpenAI-compatible llama.cpp stand-in with scripted replies |
| `fixtures/cline-tool-catalog.json` | the real Cline 3.0.70 tool catalog, recorded from the wire |
| `lib/runner.mjs` | the step executor shared by capture and replay |
| `lib/derive.mjs` | the recording shape (policy snapshots, reason extraction, derived strings) |
| `lib/normalize.mjs` | determinism: reversible path tokens, one-way volatile scalars |
| `baseline/old/` | the committed Tier A recording |
| `baseline/old-cline/` | the committed Tier B recording |

Per case, a recording contains:

| File | Contents |
| --- | --- |
| `prepare.json` | `prepareToolGuard`'s return value verbatim, including the model-visible `instructions` block |
| `artifacts/` | the whole generated `<stateDir>/cline-guard/` tree: `policy.json`, `config/hooks/{PreToolUse,PostToolUse}.mjs`, `config/plugins/restricted-tools.js`, `config/package.json`, `config/data/settings/global-settings.json` |
| `decisions.ndjson` | one record per event: `{seq, at, input, control, policyBefore, policyAfter}` |
| `strings.json` | `readGuardOutcome`, `readWorkerCapabilities`, and for every reason the case produced: the composed worker error and `canRecoverOperational`'s verdict on it |
| `argv.json`, `providers.json`, `stub-requests.ndjson`, `events.ndjson`, `run.json`, `stub-verification.json` | Tier B only |

Run-level: `meta.json` (the case list), `inventory.json` (reason-string coverage),
`verdicts.json` (the recoverable/not-recoverable table). `<tree>-environment.json` is written as a
**sibling** of each tree, not a file inside it, so a Node version or a capture timestamp can never
be mistaken for a second allowance in `compare.mjs`.

## What each tier proves

**Tier A is the gate.** It needs no Cline, no model and no network, so it runs anywhere and is what
Part 2 is held to. For every scenario and case it:

1. builds a throwaway workspace from `SEED_FILES`, `git init` + one commit, and writes
   `<stateDir>/current-task.json` from `TASK`;
2. calls `prepareToolGuard` and records its return value plus the whole generated artifact tree;
3. drives the SDK plugin **in-process** — `beforeModel` over the tool catalog fixture, `afterModel`
   over tool-call parts, `beforeTool` per call — recording each returned control object verbatim
   (`{tools}` / `{stop,reason}` / `{skip,reason}` / `undefined`) and `policy.json` after each call;
4. drives the generated file hooks **out-of-process**, `node <hooksDir>/PreToolUse.mjs` with one
   NDJSON payload on stdin, exactly as Cline does, recording raw stdout, stderr and exit code;
5. runs the `prepareToolGuard` / `verifyRestrictedTools` / `readGuardOutcome` /
   `readWorkerCapabilities` entry points against deliberately broken inputs;
6. runs the Codex `PreToolUse` hook as a subprocess over 23 cases × `toolGuard` true and false,
   recording exit code and exact stderr;
7. asserts that every string in `inventory.mjs` is accounted for, and that
   `canRecoverOperational` says `true` for each of the three recoverable reasons and `false` for
   the scope and counter stops.

**Tier B is fidelity confirmation.** It proves the wire format a real Cline actually sends, which a
fixture can only assert. It starts the stub, points `prepareClineRuntime` at it through
`llamaCppUrl`, prepares the guard, and runs the real `launchCline` per scenario, recording the
generated `providers.json`, the exact `buildClineArgs` argv, the stub's full request log (the
narrowed tool list and the `run_commands` enum **as sent on the wire**), the normalized `cline-*`
activity events, and the final policy. It cannot cover most of `inventory.mjs` — a real Cline never
reaches those branches — so inventory gaps are reported there and not treated as failures.

### What Tier B proved (Cline CLI 3.0.70, Linux, Node 20.19.2)

These are findings, recorded in `baseline/old-cline/`, not assumptions:

- **The file hook runs before the SDK plugin's `beforeTool`.** A `run_commands` call for
  `git push origin main` is cancelled by the hook with
  `command is not approved validation/read-only inspection; use native editing tools, not shell writes`
  (`cline-tool-guard.mjs:190`) — which **is** one of the three recoverable reasons. The plan's §1.5
  expectation that the unsafe command yields `canRecoverOperational === false` does not hold against
  current dev, and `unsafe command is prohibited` (`:82`) is consequently **unreachable through a
  real Cline run**: by the time `beforeTool` sees an unsafe command the hook has already cancelled.
  It is still recorded, by driving `beforeTool` directly in `plugin-unsafe-command`.
- **`unknown or unapproved tool: ` (`:194`) is also unreachable through a real Cline run.** The SDK
  never dispatches `beforeTool` *or* the file hooks for a name absent from the narrowed registry; it
  rejects before execution and `afterModel` counts it, so three unknown tools stop with
  `three invalid tool requests; preserve the diff and reassess` — which is **not** recoverable. It
  is recorded through the hook directly in `hook-unknown-tool-and-command`.
- **Cline 3.0.70 does not register `apply_patch`, `skills` or `submit_and_exit`.** Its act-mode
  catalog is 25 tools (`read_files`, `search_codebase`, `run_commands`, `fetch_web_content`,
  `editor`, `ask_question`, `spawn_agent` and 18 `team_*` tools). The guard narrows it to exactly
  `["ask_question","editor","read_files","run_commands","search_codebase"]` on the wire, with a
  22-entry `run_commands.commands` enum. A scripted `submit_and_exit` call is therefore rejected as
  an unregistered tool. `fixtures/cline-tool-catalog.json` records the 25 observed tools under
  `observed` and the three the guard allows but Cline does not offer under `guardOnly`.
- **Cline attempts its own telemetry.** Every run tried `CONNECT data.cline.bot:443`, and the
  task's own `npm run check` / `npx prettier` tried `CONNECT registry.npmjs.org:443`. Both were
  refused by the local proxy sink. Zero requests to any model-provider host.

### Tier B determinism

Two full Tier B runs are byte-identical, including across calendar days. The stub returns scripted
replies, and `lib/normalize.mjs` rewrites everything a real Cline process varies that reaches the
recording (absolute paths, ports, ISO timestamps, and the `Date: M/D/YYYY` line in Cline's system
prompt, as `{DATE}`) at **capture** time. `compare.mjs` therefore stays an exact-string diff for
Tier B too. Extend the normalizer rules rather than loosening `compare.mjs`.

## The one declared allowable difference

`compare.mjs` diffs every file in both trees byte for byte and fails on any difference, with a
single exception:

> Inside `artifacts/config/hooks/{PreToolUse,PostToolUse}.mjs` and
> `artifacts/config/plugins/restricted-tools.js`, the one generated
> `import {…} from "file:///…"` line may change its module specifier — and nothing else.

Part 2 moves that specifier from `cline-tool-guard.mjs` to the new adapter module. A second changed
line in those files, a changed imported name, a changed line count, or a changed specifier anywhere
else is a failure. There is no fuzzy matching and no second exemption.

## Determinism

`lib/normalize.mjs` keeps two kinds of substitution deliberately separate.

- **Reversible path tokens** — `{REPO}`, `{RUN}`, `{WS}`, `{STATE}`, `{PROBE}`, and their
  `file://` forms. `replay.mjs` turns them back into its own throwaway directories, so a recording
  stays replayable.
- **One-way volatile scalars** — ISO timestamps (`{TS}`), UUIDs (`{UUID}`), the stub port
  (`{PORT}`), PIDs, durations, Cline conversation ids. None of these appear in anything replay has
  to feed back in.

Nothing else is touched: no whitespace fixing, no field dropping, and no key sorting of artifact
text — so a genuine key-order change in the generated `policy.json` still shows up as a diff in
`artifacts/policy.json`. The policy snapshots inside `decisions.ndjson` *are* key-sorted, because
replay's isolated mode restores `policy.json` from a recorded snapshot and natural key order cannot
survive that round trip.

Two deliberate indirections keep the recording readable without weakening it, since what they
reference is committed right next to it:

- `plugin.beforeModel` records `{catalog: "observed"|"full"}` rather than an inlined copy of the
  28-tool catalog. The narrowed tool list the guard **returned** is still recorded verbatim.
- An oversized hook stdin records `{stdinRepeat:{unit,bytes}}`, and a >1 MB edit source records
  `{at:"fs.fill", bytes}`, rather than a megabyte of filler.

**One thing is not path-normalizable.** `cline-edit-boundary.mjs:9` fingerprints a failed edit by
hashing the tool input, absolute file path included, and persists that hash in
`policy.editFailures`. The harness therefore uses a *stable* work root
(`<os.tmpdir()>/agent-dock-guard-baseline/<scope>`) rather than `mkdtemp`, so two runs on one
machine produce identical fingerprints. Consequence, stated rather than hidden: comparing
recordings made under different temp directories (a Linux box against a Windows box) will differ in
exactly those fingerprint fields. The Part 2 gate is an old-vs-new compare on one machine, where
they match. Only one capture at a time per scope.

## What is committed, and what is reproducible output

Committed: everything above plus `baseline/old/` and `baseline/old-cline/`.

`.gitignore` excludes the acceptance-only outputs — `baseline/old-again/`,
`baseline/old-cline-again/`, `replay/`, `baseline/new*/` and the `*-environment.json` siblings —
because they are regenerated by the commands at the top of this file and would otherwise be
reviewed as if they were a contract.

## Known gaps

- Three inventory strings are proved by asserting the literal is still present in its source file
  rather than by producing it: `cline-cli-worker.mjs:435`
  (`Cline tool restriction plugin did not initialize; guarded completion refused`), `:567`
  (`Guarded Cline attempt did not complete: `) and `cloud-impl-worker.mjs:167` (the Codex
  fail-closed refusal). Each needs a live worker doing something a stub cannot make it do. They are
  marked `how: "source-literal"` in `inventory.mjs` and counted separately in `inventory.json`.
- The Codex rail is recorded through its hook subprocess, not through a real Codex process, so the
  fail-closed check at `cloud-impl-worker.mjs:163-167` and the `implementation-scope-blocked` event
  are not exercised end to end.
- `codex-scope-guard.mjs:69` compares a patch path against the exact resolved `allowedPaths` set,
  so `*** Add File: src/inscope/new.ts` is denied even though `src/inscope/` is an allowed
  directory — unlike the Cline rail, whose `approvedPath` treats a trailing-slash scope as a
  directory. That asymmetry is **recorded, not corrected**, in the
  `patch-add-file-in-scope-directory` case.
- Tier B's proxy sink only catches clients that honor `HTTP(S)_PROXY`. The other two closures are
  that every provider credential variable is deleted from the child environment before launch and
  that the generated `providers.json` is asserted to point at the stub's loopback URL.
- Tier B was recorded on Linux with Node 20.19.2. The engine's `DEFAULT_CLINE_JS`
  (`cline-cli-worker.mjs:10`) is a Windows `%APPDATA%` path, so Tier B always needs `--cline-js`
  here.
