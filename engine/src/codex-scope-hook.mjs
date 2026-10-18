// Codex PreToolUse hook. Usage: node codex-scope-hook.mjs <policy.json> <log.ndjson>
// Exit 0 allows the tool call; exit 2 with the exact reason on stderr blocks it.
import { runHook } from "./guard/hook-runner.mjs";
import codex from "./guard/adapters/codex.mjs";

const [policyPath, logPath] = process.argv.slice(2);
const result = await runHook(codex, { policyPath, logPath });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
