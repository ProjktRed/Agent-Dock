# Security boundaries

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

- **Protected paths** in Settings › Safety reach every engine launch through `--protected-paths` (a
  JSON string array). Paths may be workspace-relative or absolute; `*`, `?` and `**` patterns are
  supported. Basename patterns such as `.env*` include nested matches. The running engine,
  application installation, settings and project-state folders are protected automatically.
  The defaults also cover folders and files that configure tools which run code: `.claude/`,
  `.codex/`, `.opencode/`, `.clinerules`, `.husky/`, `.github/workflows/` and `.vscode/`. Settings
  from before these were defaults get them added once; nothing you added is removed.
  Changes take effect on the next engine start.
- Codex, Claude Code, Cline and OpenCode tool calls are checked before access. Path checks compare
  canonical paths: symlink/junction targets, missing-file parents, and Windows short (8.3) or
  differently cased spellings all resolve to the real location. Recursive searches that include
  protected content are refused; narrow the search to source directories. Git metadata inspection
  remains available. Protected changes fail QA scope checks and suppress the whole diff, including
  content moved to a previously unprotected filename.
- Assessment cannot choose an arbitrary QA shell program. QA commands are limited to project npm
  scripts, supported local check tools, and bounded Git inspection. Shell expressions, interpreters,
  redirection, package installation and ambiguous path syntax are refused. Every check argument,
  including the value in `--option=value`, is path-checked; options that write reports or build output
  are refused, and options that rewrite files (`--write`, `--fix`, `-u`) need every target readable.
  History reads (`git show`, `git log`) name commits only, and read commands take only their
  read-only options. Guarded commands must be plain ASCII outside a quoted commit message (PowerShell
  reads several Unicode characters as syntax). Checks run `npx` with `--no-install`, so a check never
  downloads a package.
- **Project checks** (Settings › Execution & safety). A check such as `npm test` runs the project's
  scripts and tests, which agents can edit. These guards are **not an OS sandbox**: a check runs as your
  user and can read the project's files, and can decrypt Agent Dock's saved keys (see below). Off (the
  default) means checks are untrusted: while any run is
  going, the app compares its config files with what it last wrote, puts back anything else changed
  (keeping the changed copy beside it as `<name>.changed-<time>`), and stops every run when those or its
  engine files changed. Turning it on needs a native confirmation, and a settings import cannot turn it
  on. The watch works while Agent Dock is open; changes made while it is closed are not seen.
- Packaged builds carry a list of the engine's files and their SHA-256 hashes inside `app.asar`
  (whose own integrity Electron checks on Windows and macOS; Electron has no ASAR integrity check on
  Linux, so there the list is only as trustworthy as the installed app). The app compares the installed engine and update script with
  it before it loads or starts the engine, and refuses changed, missing or added files. A file the
  watch cannot read or put back counts as changed.
- These guards do not defend against a compromised CLI, concurrent filesystem races, or a process
  already running as your user. CLI startup configuration/automatic context loading is also outside
  tool-hook mediation.
- Saving settings from the window is checked in the main process: a malformed save keeps the current
  values, and a change that weakens a safety control or chooses a program to run (tool guard off,
  trusted checks, engine guardrails off, an unprotected path, remote approvals, the llama.cpp launcher,
  the Node runtime, the update source) needs a native confirmation the window cannot answer; so does
  turning the tool guard off for one project, and giving a CLI connection a program other than its plain
  name or one found on PATH for it (when saved or tested). The window can look up only Git and the
  supported CLIs on PATH. Imported connections must be a known kind with a plain id, and a connection's
  address must be http(s) with no user name or password in it.
- API keys entered in Agent Dock, and connection environment variables marked secret, are encrypted
  with your OS account (DPAPI on Windows, through Electron `safeStorage`), never leave the main process
  except as environment variables for the process that needs them, are stored apart from the app's own
  keys, go to a connection's new address only after you confirm (the dialog names the host the key would
  go to), and are redacted from logs, prompts, notifications and the diagnostics export. Where the OS has
  no credential store (for example Linux without an unlocked keyring) they are not saved at all. Config
  files are written 0600 in a 0700 folder. This encryption keeps them from other users of the computer,
  not from programs running as you: as Electron documents for `safeStorage`, any program running under
  your account can decrypt them, and that includes a project check (`npm test` runs code agents can
  edit). Use keys made for Agent Dock with low spending limits.
- The diagnostics export leaves out task prompts, objectives and role instructions (only their length
  is shown).
- The action log's entries are hash-chained and signed (HMAC-SHA256) with a key the app keeps
  encrypted; engines get the key in their environment, the processes they start do not. A rewritten
  entry fails verification even when the chain is recomputed. Entries written before the key existed
  verify only up to where each log ended when the key was made (recorded once, signed). Each signed entry
  also records itself as the log's newest, signed, so removing the newest entries or emptying the log
  fails verification. After each run and each Verify logs, the app also records the newest entry, signed,
  in its own config folder, and checks that the log still contains it: restoring an older copy of a
  project's state folder (log and head record together) or deleting both fails too, unless the app's
  config is rolled back as well. The run-finished notification carries the last entry's number and hash,
  evidence kept off this computer. Stops from the terminal command
  cannot be signed; Verify logs counts them separately and they cannot stand in for signed entries.
  The signature shows what happened through agents' tools and the app; it does not hold against code
  running as you, which can decrypt the key like any other saved secret (see above), and that includes
  a project check.
- Remote approvals: Telegram buttons count only from your private chat. Email cannot prove who sent a
  reply, so an email reply can only stop a run or dismiss a plan change, within an hour of the request.
- llama-server started by Agent Dock listens on this computer only (127.0.0.1); it has no API key.
- A Cline or OpenCode worker on a cloud provider gets that key in its environment, so a worker could
  read it. The control that bounds a leak is a spending limit on the key itself: use a key made only for
  Agent Dock, with a low limit set at the provider (for example an OpenRouter per-key credit limit). The
  run and daily budgets stay the limit inside the app. Before a run, Agent Dock asks OpenRouter whether
  the key has a limit (`GET /api/v1/key`, at most hourly) and warns when it has none.
- Notification channel settings (webhook URLs, the Telegram bot token, the AgentMail API key) go only
  to the engine, which reads them once at startup and removes them from its environment. Check
  commands, model CLIs, workers and parallel task engines never inherit them; only the engine that
  started the run sends notifications.
- Windows: Agent Dock and its engine resolve bare program names (git, codex, claude, powershell)
  from PATH only, never from the current folder, and child processes inherit that setting. Arguments
  that pass through `cmd.exe` are quoted and escaped for it, or refused when they cannot be passed
  safely. Read-only git calls used for monitoring and QA evidence run with `core.fsmonitor=false`.
- Claude Code always starts with `--setting-sources user`: a project's own `.claude/` settings
  (hooks, permissions) are not loaded. Agent Dock's protection hook is passed with `--settings`.
- A repository's own CLI configuration never applies: Agent Dock does not start Codex in a repository
  with a `.codex/config.toml` or `.codex/hooks.json` (Codex would apply its hooks, notify programs, MCP
  servers or providers to the run, and Agent Dock starts Codex with its hook review off for its own guard
  hook), nor Cline in one with `.clinerules/hooks/` (Cline runs those without review). It checks the
  workspace and each folder up to its git root before every start. OpenCode runs with project
  configuration disabled and its own config folders.
- Codex roles that write run in Codex's workspace-write sandbox with approvals set to never: a command
  the sandbox blocks (network, files outside the workspace) stays blocked instead of being let out by an
  automatic reviewer.
- CLIs › Settings: run settings for Codex and Claude Code come from a fixed list, checked by the app
  and again by the engine, with no sandbox, approval, permission, hook, network or MCP setting on it.
  The config file editor writes only Codex's `config.toml` and Claude Code's user `settings.json`,
  which are trusted configuration: that file can define hooks, which run commands. Ollama's settings
  are written only to a fixed list of `OLLAMA_*` variables in your user environment, with checked
  values passed to PowerShell as data, never as command text.
- Importing a settings file never sets programs to start: connection program paths, the llama.cpp
  launcher and the Node runtime stay as they are on this computer. An import cannot turn the tool
  guard off, and its protected paths are added to yours.
- The standalone engine dashboard requires a fresh random bearer token for every API route. Its
  browser launch link carries the token in a fragment, which the page removes from history and saves
  per tab. The link is handed to the browser through a private launch page, never on a command line. A server restart invalidates older tokens. Tokens are not written to engine logs. Host,
  origin and JSON request checks remain enforced.
- Updates install only when the release's manifest carries a valid Ed25519 signature from the key
  built into the app, and the download's size and SHA-256 match that manifest.
- Packaged Electron refuses debugging/inspection switches, has developer tools and the application
  menu turned off, ignores development renderer URL overrides, denies web permissions and webviews, and packages with ASAR integrity/load-path and Node
  environment/inspection fuses. Electron's RunAsNode fuse remains enabled because the engine and CLI
  hooks use its bundled Node runtime. The window loads app://agent-dock/ (only files inside the built
  renderer folder are served), not file://, so the GrantFileProtocolExtraPrivileges fuse is off. The fuses are flipped by `scripts/harden-electron.cjs`, which
  runs as electron-builder's `afterPack` hook (before signing). electron-builder 26 also has an
  `electronFuses` configuration option; the build does not use it, so the fuse list is set in one
  script that `verify-packaged-security.mjs` checks. See
  [Electron's fuse documentation](https://www.electronjs.org/docs/latest/tutorial/fuses).

## Checking a packaged build

To verify a Windows security test package without installing or opening its UI:

```powershell
npm run build
npx electron-builder --win --dir --config.directories.output=dist/security
node scripts/verify-packaged-security.mjs dist/security/win-unpacked/AgentDock.exe
```

The smoke test checks the actual packaged fuses, bundled Node startup and rejection of debugging
switches. It does not replace live-provider integration testing or an OS sandbox.
