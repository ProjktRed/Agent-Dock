# Security boundaries

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

- **Protected paths** in Settings › Safety reach every engine launch through `--protected-paths` (a
  JSON string array). Paths may be workspace-relative or absolute; `*`, `?` and `**` patterns are
  supported. Basename patterns such as `.env*` include nested matches. The running engine,
  application installation, settings and project-state folders are protected automatically.
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
- The standalone engine dashboard requires a fresh random bearer token for every API route. Its
  browser launch link carries the token in a fragment, which the page removes from history and saves
  per tab. A server restart invalidates older tokens. Tokens are not written to engine logs. Host,
  origin and JSON request checks remain enforced.
- Updates install only when the release's manifest carries a valid Ed25519 signature from the key
  built into the app, and the download's size and SHA-256 match that manifest.
- Packaged Electron refuses debugging/inspection switches, ignores development renderer URL
  overrides, denies web permissions and webviews, and packages with ASAR integrity/load-path and Node
  environment/inspection fuses. Electron's RunAsNode fuse remains enabled because the engine and CLI
  hooks use its bundled Node runtime. The pinned electron-builder 25 uses
  `scripts/harden-electron.cjs` as an `afterPack` hook (before signing), since it predates the
  `electronFuses` configuration option. See
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
