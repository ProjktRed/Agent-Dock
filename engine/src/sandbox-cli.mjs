import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { closeSandbox, sandboxedSpawn, sandboxProblem, useSandboxedChecks } from "./sandbox.mjs";

/**
 * The app's side of Settings › Experimental › Run project checks in a sandbox. Prints one JSON line.
 *   status                      { ready, problem }
 *   codex-status [--codex <program>]
 *                               Windows: Codex's elevated sandbox is set up; { ok, problem }
 *   install | uninstall         Windows: sets up or removes the sandbox account and its network filter
 *                               (srt-win, one administrator prompt); { ok, cancelled, problem }
 *   self-test --canary-dir <d> [--secret <file>]...
 *                               runs probes inside the sandbox that must fail (read your files, write
 *                               outside the worktree, reach the network, decrypt your DPAPI data) and one
 *                               that must work (write inside); { ok, results: [{ name, ok, detail }] }
 */
const exec = promisify(execFile);
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Runs inside the sandbox: each probe reports what happened, never file contents.
const PROBE = String.raw`
import { openSync, closeSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
const input = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
const out = {};
const attempt = (fn) => { try { fn(); return "allowed"; } catch (e) { return "refused: " + (e.code || e.message).toString().slice(0, 80); } };
out.writeInside = attempt(() => writeFileSync(path.join(process.cwd(), "inside.txt"), "x"));
out.writeOutside = attempt(() => writeFileSync(path.join(path.dirname(process.cwd()), "outside-" + input.tag + ".txt"), "x"));
out.reads = input.reads.map((file) => ({ file, result: attempt(() => closeSync(openSync(file, "r"))) }));
if (input.dpapi) out.dpapi = attempt(() => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "Add-Type -AssemblyName System.Security; [void][Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('" + input.dpapi + "'), $null, 'CurrentUser')"],
  { stdio: "ignore", timeout: 20000 }));
out.network = await new Promise((resolve) => {
  const socket = net.connect({ host: "1.1.1.1", port: 443 });
  const done = (r) => { socket.destroy(); resolve(r); };
  socket.setTimeout(5000, () => done("refused: timeout"));
  socket.on("connect", () => done("allowed"));
  socket.on("error", (e) => done("refused: " + e.code));
});
console.log("PROBE " + JSON.stringify(out));
`;

async function dpapiBlob() {
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('agent-dock-canary'), $null, 'CurrentUser'))"],
  { windowsHide: true, timeout: 20_000 });
  return stdout.trim();
}

function runInSandbox(command, cwd) {
  return sandboxedSpawn(command, cwd, { windowsShell: "cmd" }).then((launch) => new Promise((resolve) => {
    const child = spawn(launch.file, launch.args, { cwd, env: launch.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("error", (error) => { clearTimeout(timer); launch.release(); resolve({ exitCode: 1, output: error.message }); });
    child.on("close", (exitCode) => { clearTimeout(timer); launch.release(); resolve({ exitCode, output }); });
  }));
}

export async function selfTest({ canaryDir, secrets = [] }) {
  useSandboxedChecks(true);
  const problem = await sandboxProblem();
  if (problem) return { ok: false, problem, results: [] };
  const tag = randomBytes(6).toString("hex");
  // Windows: not in the temp folder. The sandbox account cannot look into AppData, and Node resolves every
  // folder above the script it runs, so a probe under AppData never starts. The profile folder itself is fine.
  const work = await mkdtemp(path.join(process.platform === "win32" ? os.homedir() : os.tmpdir(), ".agent-dock-sandbox-test-"));
  const canary = path.join(canaryDir, `sandbox-canary-${tag}.txt`);
  try {
    await writeFile(canary, "agent-dock-canary");
    await writeFile(path.join(work, "probe.mjs"), PROBE);
    const reads = [canary, ...secrets.filter((file) => existsSync(file))];
    const dpapi = process.platform === "win32" ? await dpapiBlob().catch(() => null) : null;
    const input = Buffer.from(JSON.stringify({ tag, reads, dpapi })).toString("base64");
    const run = await runInSandbox(`node probe.mjs ${input}`, work);
    const line = run.output.split(/\r?\n/).find((l) => l.startsWith("PROBE "));
    if (!line) return { ok: false, problem: `the probe did not run in the sandbox (exit ${run.exitCode}): ${run.output.slice(-600)}`, results: [] };
    const seen = JSON.parse(line.slice(6));
    const refused = (value) => typeof value === "string" && value.startsWith("refused");
    const results = [
      { name: "Write inside the worktree", ok: seen.writeInside === "allowed", detail: seen.writeInside },
      { name: "Write outside the worktree", ok: refused(seen.writeOutside), detail: seen.writeOutside },
      ...seen.reads.map((r) => ({ name: `Read ${r.file === canary ? "a file in Agent Dock's config folder" : r.file}`, ok: refused(r.result), detail: r.result })),
      { name: "Open a network connection", ok: refused(seen.network), detail: seen.network },
      ...(dpapi ? [{ name: "Decrypt your DPAPI-protected data", ok: refused(seen.dpapi), detail: seen.dpapi }] : []),
    ];
    return { ok: results.every((r) => r.ok), results };
  } finally {
    await closeSandbox();
    await rm(canary, { force: true }).catch(() => {});
    await rm(path.join(path.dirname(work), `outside-${tag}.txt`), { force: true }).catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function windowsSetup(action) {
  if (process.platform !== "win32") return { ok: false, problem: "only Windows needs this setup" };
  const srt = await import("@anthropic-ai/sandbox-runtime");
  const srtWin = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE });
  try {
    const result = action === "install" ? await srt.installWindowsSandboxAsync({ srtWin }) : srt.uninstallWindowsSandbox({ srtWin });
    return { ok: !result.cancelled, cancelled: Boolean(result.cancelled) };
  } catch (error) { return { ok: false, problem: error.message }; }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flags = { secret: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.replace(/^--/, "");
    if (name === "secret") flags.secret.push(rest[i + 1]);
    else flags[name] = rest[i + 1];
  }
  if (command === "status") { const problem = await sandboxProblem(); return print({ ready: !problem, problem }); }
  if (command === "install" || command === "uninstall") return print(await windowsSetup(command));
  if (command === "codex-status") {
    if (process.platform !== "win32") return print({ ok: true, problem: null });
    const { codexSandboxProblem, resolveCodexCommand } = await import("./codex-command.mjs");
    const problem = await codexSandboxProblem(await resolveCodexCommand({ explicitCommand: flags.codex }));
    return print({ ok: !problem, problem });
  }
  if (command === "self-test") {
    if (!flags["canary-dir"]) throw new Error("--canary-dir is required");
    return print(await selfTest({ canaryDir: flags["canary-dir"], secrets: flags.secret }));
  }
  throw new Error("usage: sandbox-cli.mjs status | codex-status | install | uninstall | self-test --canary-dir <dir> [--secret <file>]...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { print({ ok: false, problem: error.message }); process.exitCode = 1; });
}
