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
  redirection, package installation and ambiguous path syntax are refused. Project scripts and their
  dependencies still execute as trusted code: these guards are **not an OS sandbox**, and do not
  defend against a malicious project script, a compromised CLI, concurrent filesystem races, or a
  process already running as your user. CLI startup configuration/automatic context loading is also
  outside tool-hook mediation.
- API keys entered in Agent Dock are encrypted with your Windows account (DPAPI through Electron
  `safeStorage`), never leave the main process except as environment variables for the process that
  needs them, and are redacted from logs, prompts, notifications and the diagnostics export.
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
- Importing a settings file never sets programs to start: connection program paths, the llama.cpp
  launcher and the Node runtime stay as they are on this computer. An import cannot turn the tool
  guard off, and its protected paths are added to yours.
- The standalone engine dashboard requires a fresh random bearer token for every API route. Its
  browser launch link carries the token in a fragment, which the page removes from history and saves
  per tab. A server restart invalidates older tokens. Tokens are not written to engine logs. Host,
  origin and JSON request checks remain enforced.
- Updates install only when the release's manifest carries a valid Ed25519 signature from the key
  built into the app, and the download's size and SHA-256 match that manifest.
- Packaged Electron refuses debugging/inspection switches, has developer tools and the application
  menu turned off, ignores development renderer URL overrides, denies web permissions and webviews, and packages with ASAR integrity/load-path and Node
  environment/inspection fuses. Electron's RunAsNode fuse remains enabled because the engine and CLI
  hooks use its bundled Node runtime. The fuses are flipped by `scripts/harden-electron.cjs`, which
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
