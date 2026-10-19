# Contributing to Agent Dock

Bug reports, fixes and improvements are welcome.

## Reporting a bug

Open an issue with what you did, what you expected and what happened. Attach the zip from
**Settings › Advanced › Export diagnostics**: it holds versions, settings and engine logs, with
secrets, your project code and model prompts left out. Report security problems privately instead
(see [SECURITY.md](SECURITY.md)).

## Development setup

You need Node 20 or newer, Git, and Windows for the full app (the engine also runs on Linux).

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` starts the app with its own settings folder, so it never touches an installed copy.

## Before you open a pull request

Run the same checks as CI:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:engine
```

```bash
npm run build
```

- Keep a change focused on one thing, and add or update tests for what it changes.
- The engine (`engine/`) has no dependencies; keep it that way.
- Never weaken a safety check (tool guard, protected paths, scope and HEAD checks, QA-only commits)
  to make a test pass. If a check is wrong, explain why in the pull request.
- Changes to `engine/src/guard/` or the Linux support get a review from their author (see
  [AUTHORS](AUTHORS)).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
