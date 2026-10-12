// Codex PreToolUse hook (see codex-scope-guard.mjs). Usage: node codex-scope-hook.mjs <policy.json> <log.ndjson>
// Exit 0 allows the tool call; exit 2 with a reason on stderr blocks it. Every decision is logged so
// the worker can verify the hook actually ran. Any error blocks (fail closed).
import { appendFileSync, readFileSync } from "node:fs";
import { checkToolUse } from "./codex-scope-guard.mjs";

const [policyFile, logFile] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let reason;
  let tool = null;
  try {
    const policy = JSON.parse(readFileSync(policyFile, "utf8"));
    const event = JSON.parse(input);
    tool = event.tool_name ?? null;
    reason = checkToolUse(policy, event);
  } catch (error) {
    reason = `Scope hook could not check this call (${error.message}); blocked.`;
  }
  try { appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), tool, allowed: !reason, reason: reason ?? null }) + "\n"); } catch { /* log is best effort */ }
  if (reason) {
    process.stderr.write(reason);
    process.exit(2);
  }
  process.exit(0);
});
