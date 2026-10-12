import { readFile, writeFile } from "node:fs/promises";
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
let input = "";
for await (const chunk of process.stdin) input += chunk;
const output = process.argv[process.argv.indexOf("--output-last-message") + 1];
await writeFile(output, input);
// Producing task JSON is not enough: the manager must wait for actual exit.
await new Promise((resolve) => setTimeout(resolve, 150));
