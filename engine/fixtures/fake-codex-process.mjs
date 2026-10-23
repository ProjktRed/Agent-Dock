import { readFile, writeFile } from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
if (process.argv.includes("--approve-for-me") && process.argv.includes("--sandbox")) {
  console.error("Conflicting approval and sandbox arguments");
  process.exit(2);
}
const pidFile = process.argv[2];
if (process.env.FAKE_CODEX_ARGS_FILE) {
  await writeFile(process.env.FAKE_CODEX_ARGS_FILE, JSON.stringify(process.argv.slice(3)));
}
let pids = [];
try { pids = JSON.parse(await readFile(pidFile)); } catch {}
pids.push(process.pid);
await writeFile(pidFile, JSON.stringify(pids));
// Present for exactly this process's life (PIDs are reused quickly on Windows, a marker is not).
const marker = `${pidFile}.alive-${process.pid}`;
writeFileSync(marker, "");
process.on("exit", () => { try { unlinkSync(marker); } catch {} });
let input = "";
for await (const chunk of process.stdin) input += chunk;
const output = process.argv[process.argv.indexOf("--output-last-message") + 1];
await writeFile(output, input);
// A tool call, with or without the protection hook having logged a decision next to the prompt.
if (process.env.FAKE_CODEX_TOOL) {
  console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls", status: "completed" } }));
  if (process.env.FAKE_CODEX_TOOL === "hooked") writeFileSync(output.replace(/result\.json$/, "scope-hook.ndjson"), JSON.stringify({ tool: "Bash", allowed: true, reason: null }) + "\n");
}
// A call that never ends (process-bounds.mjs ends it).
if (process.env.FAKE_CODEX_HANG) await new Promise(() => setInterval(() => {}, 1000));
// Producing task JSON is not enough: the manager must wait for actual exit.
await new Promise((resolve) => setTimeout(resolve, 150));
