# Security

Agent Dock runs coding agents that can read and change files on your computer, so security
problems matter. Please report them privately.

## Reporting a vulnerability

Use **Report a vulnerability** on this repository's **Security** tab (GitHub private vulnerability
reporting). Do not open a public issue. Include the version (Settings › Updates), what an attacker
can do, and steps to reproduce.

You should get a first answer within a week. Fixes ship as a new signed release; the release notes
credit the reporter unless you ask otherwise.

## What counts

- An agent or a project file getting around the tool guard, protected paths, scope checks or the
  QA-only commit rule.
- Secrets (API keys, tokens) leaking into logs, prompts, notifications or the diagnostics export.
- An update being installed without a valid release signature.
- The engine dashboard or remote approvals accepting requests they should refuse.

## What is out of scope

The guards are not an operating-system sandbox. A project check (`npm test` and the code it runs) can
read the project's files; Agent Dock detects and undoes changes to its own settings and engine files
during a run, but does not stop the check itself. A compromised CLI, or another process already running
as your user, is outside what Agent Dock can defend against (see "Security boundaries" in the README).
