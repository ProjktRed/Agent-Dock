# Building and releasing

## Run from source

Requires Node 20+ (the engine runs on the system `node` when found, otherwise on Electron's bundled
runtime), Git, and the CLIs you want to use (Codex CLI or Claude Code, OpenCode or Cline, llama.cpp
or Ollama).

```bash
npm install
```

```bash
npm run dev
```

Development runs keep their own settings, projects and secrets in `%APPDATA%\Agent Dock Dev`, apart
from an installed copy (`--user-data-dir` picks another folder).

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run build` | production bundle into `out/` |
| `npm start` | run the built app |
| `npm test` | app unit tests (vitest) |
| `npm run test:engine` | the engine's own suite (`node --test`) |
| `npm run typecheck` | TypeScript checks for main and renderer |
| `npm run package` | unpacked Windows build via electron-builder |
| `npm run package:installer` | the per-user NSIS installer |

## Build and install from source

`npm run release:local` builds the latest commit of the current branch (never uncommitted changes)
from a clean copy and installs it for your Windows account, with Start menu and desktop shortcuts.
Such a build updates itself from its Git source: on launch and in the background it compares its
commit with the source branch, offers **Update now** (or installs automatically, Settings ›
Updates), rebuilds that commit in a staging folder, then swaps the install folder and relaunches.
Updates wait while an engine is running. Options: `--source <repo path or git URL>`,
`--branch <name>`, `--install-dir <dir>`, `--commit <sha>`; set `AGENT_DOCK_HOME` to install
somewhere other than `%LOCALAPPDATA%\Programs\Agent Dock`.

## Releases (maintainers)

Pushing a tag `vX.Y.Z` that matches `package.json` runs `.github/workflows/release.yml`: checks and
tests, the per-user installer (`npm run package:installer`, electron-builder NSIS), the packaged
security check, a zip of the app, and a manifest of that zip signed with Ed25519. It publishes the
installer, zip, `manifest.json` and `manifest.sig` as a GitHub Release of this repository, using the
workflow's own token. Release notes come from `docs/release-notes/<version>.md` when that file
exists, otherwise from the commit titles. A tag ending in `-dry` runs the same build without signing
or publishing.

Setup, once: `node scripts/sign-release.mjs --generate-key release-key.pem`, add the file's contents
as the repository secret `RELEASE_SIGNING_KEY`, delete the file, and put the printed public key in
`src/main/release-key.ts`.
