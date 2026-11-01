import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { askable, askUser, definitelyRefused, hookTimeoutSeconds } from "../src/guard/ask.mjs";
import { runHook } from "../src/guard/hook-runner.mjs";
import codex from "../src/guard/adapters/codex.mjs";
import claude from "../src/guard/adapters/claude.mjs";
import { protectedPathsFor } from "../src/guard/protected-paths.mjs";

const temp = () => mkdtempSync(path.join(os.tmpdir(), "guard-ask-"));
function setup(minutes = 0.02) {
  const workspace = temp(), stateDir = temp(), dir = path.join(stateDir, "approvals");
  writeFileSync(path.join(workspace, ".env"), "SECRET=x");
  const policy = { workspace, protectedPaths: protectedPathsFor({ workspace, stateDir }), allowedPaths: [], qaCommand: "", toolGuard: false, allowGitCommit: false, protectionOnly: true, ask: { dir, timeoutMs: minutes * 60_000 } };
  const policyPath = path.join(stateDir, "policy.json"), logPath = path.join(stateDir, "log.ndjson");
  writeFileSync(policyPath, JSON.stringify(policy));
  return { workspace, stateDir, dir, policy, policyPath, logPath };
}
const bash = (command, cwd) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });

/** Answers the first request that appears, as the app would. */
function answerWhenAsked(dir, decision) {
  const timer = setInterval(() => {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".request.json")); } catch { return; }
    if (!files.length) return;
    const request = JSON.parse(readFileSync(path.join(dir, files[0]), "utf8"));
    writeFileSync(path.join(dir, `${request.id}.decision.json`), JSON.stringify({ id: request.id, decision }));
    clearInterval(timer);
  }, 20);
  return () => clearInterval(timer);
}

test("only unverified actions are askable: protected paths and edits stay refused outright", () => {
  const { policy, workspace } = setup();
  const command = (text) => ({ kind: "command", tool: "Bash", commands: [text], cwd: workspace });
  assert.equal(definitelyRefused(policy, command("cat .env")), true);
  assert.equal(definitelyRefused(policy, command(`type "${path.join(workspace, ".env")}"`)), true);
  // Shells join quoted pieces and drop escapes (release review 0.40.0): these are all `cat .env`.
  for (const text of ["cat .e''nv", 'cat ".e"nv', "cat .e\\nv", "Get-Content .e`nv"]) assert.equal(definitelyRefused(policy, command(text)), true, text);
  assert.equal(definitelyRefused(policy, command(`cd "${workspace}" && git ls-files | head -40`)), false);
  assert.equal(definitelyRefused(policy, command("rg --files -g '!.git'")), false);
  assert.equal(definitelyRefused(policy, { kind: "unknown", tool: "webrun", input: { url: "https://example.com" }, cwd: workspace }), false);
  assert.equal(definitelyRefused(policy, { kind: "unknown", tool: "x", input: { path: ".env" }, cwd: workspace }), true);
  assert.equal(definitelyRefused(policy, { kind: "edit", tool: "Edit", input: {}, paths: ["a.txt"], cwd: workspace }), true);
  const stop = { effect: "stop", reason: "r" };
  assert.equal(askable(policy, command("rg --files"), stop, codex), true);
  assert.equal(askable(policy, command("rg --files"), stop, { id: "cline" }), false, "Cline's guard cannot wait");
  assert.equal(askable({ ...policy, ask: null }, command("rg --files"), stop, codex), false);
  assert.equal(askable(policy, command("rg --files"), { effect: "allow" }, codex), false);
});

test("wildcards that could name a protected path, and shells that read code from input, are refused outright (kadono 0.40.0 probe)", async () => {
  const { policy, workspace } = setup();
  const command = (text) => ({ kind: "command", tool: "Bash", commands: [text], cwd: workspace });
  for (const text of ["cat .e*", "cat .en?", "cat .[e]nv", "cat .e[[:alpha:]]v", "cat .{env,txt}", "cat .{git,x}/config", "cat .e${UNSET:-*}", "set -- nv; cat .e$@", "X=*; cat .e$X", "cat .e$(echo '*')", "cat *env", "Get-Content .e*", `cat ${path.join(workspace, ".e*")}`]) assert.equal(definitelyRefused(policy, command(text)), true, text);
  // Before any .env exists the rule's own name still counts.
  const empty = setup().policy; const fresh = mkdtempSync(path.join(os.tmpdir(), "guard-ask-")); empty.workspace = fresh; empty.protectedPaths = protectedPathsFor({ workspace: fresh, stateDir: fresh + "-state" });
  assert.equal(definitelyRefused(empty, { kind: "command", tool: "Bash", commands: ["cat .e*"], cwd: fresh }), true);
  for (const text of ["rg foo *.js", "ls src/*.ts"]) assert.equal(definitelyRefused(policy, command(text)), false, text);
  for (const text of ["bash", "powershell -NoProfile", "python", "git status && sh", "xargs cat", "node -r fs", "python -W ignore", "bash -O extglob", "powershell -NoProfile -ExecutionPolicy Bypass", "env -u FOO bash", "sudo -u nobody bash", "nice -n 5 bash", "bash /dev/stdin", "node /proc/self/fd/0", "bash /proc/thread-self/fd/0", "env X='|' bash", "bash /proc/thread-self/fd/'0'", 'echo "foo\\" | bash"; bash', "echo $(bash)", "if true; then bash; fi", "while x; do sh; done", "echo `python`", "env X=\\| bash"]) assert.equal(definitelyRefused(policy, command(text)), true, text);
  for (const text of ["bash -c 'npm test'", "node build.js", "echo ls | bash", "node --version", "python -V", "pwsh --version", "python -m pytest", "powershell -ExecutionPolicy Bypass -File build.ps1", "cat $HOME/notes.txt", 'rg "node|python" src', "git log --oneline | head", "node --test", "node --run test", "echo 'console.log(42)' | node"]) assert.equal(definitelyRefused(policy, command(text)), false, text);
  // A link in the workspace to the command's own input is no script.
  if (process.platform !== "win32") { symlinkSync("/dev/stdin", path.join(workspace, "run.sh")); assert.equal(definitelyRefused(policy, command("bash run.sh")), true, "link to /dev/stdin"); }
  // The guard itself refuses them for Codex, whatever the mode.
  const { dir, policyPath, logPath, workspace: ws } = setup();
  const out = await runHook(codex, { policyPath, logPath, input: bash("bash", ws) });
  assert.match(JSON.stringify(out), /read their code from input/);
  assert.throws(() => readdirSync(dir), "never put to you");
});

test("code inside a command is asked about, not refused as if it named a protected path", () => {
  const { policy, workspace, stateDir } = setup();
  const command = (text) => ({ kind: "command", tool: "Bash", commands: [text], cwd: workspace });
  // The icon writer an agent used: `c>>>1):c>>>1`, `raw[o]=e?240:40` and `icons',{recursive:true}` are code.
  const iconWriter = `node -e "const fs=require('fs');for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;raw[o]=e?240:40;fs.mkdirSync('src-tauri/icons',{recursive:true})"`;
  assert.equal(definitelyRefused(policy, command(iconWriter)), false);
  // Protected names hidden in the same punctuation, or behind a variable, stay refused outright.
  assert.equal(definitelyRefused(policy, command("Get-Content -Path:.env")), true);
  assert.equal(definitelyRefused(policy, command(`node -e "require('fs').readFileSync('.env')"`)), true);
  assert.equal(definitelyRefused(policy, command("x=.env cat")), true);
  process.env.GUARD_ASK_TEST_STATE = stateDir;
  try {
    // This platform's separator: `\` is part of a file name on Linux.
    assert.equal(definitelyRefused(policy, command("type $env:GUARD_ASK_TEST_STATE" + path.sep + "policy.json")), true);
    assert.equal(definitelyRefused(policy, command("cat %GUARD_ASK_TEST_STATE%/policy.json")), true);
    assert.equal(definitelyRefused(policy, command("Get-Content ${env:GUARD_ASK_TEST_STATE}" + path.sep + "policy.json")), true);
    assert.equal(definitelyRefused(policy, command(`Get-Content -Path:${path.join(stateDir, "policy.json")}`)), true);
    assert.equal(definitelyRefused(policy, command(`cat "${stateDir}${path.sep}policy.json"`)), true);
  } finally { delete process.env.GUARD_ASK_TEST_STATE; }
});

test("an unverified command runs once you allow it, and stays refused when you refuse it or do not answer", async () => {
  for (const [decision, exitCode, reason] of [["allow", 0, null], ["deny", 2, /you refused it/], [null, 2, /no answer in time/]]) {
    const { dir, policyPath, logPath, workspace } = setup();
    const stop = decision ? answerWhenAsked(dir, decision) : () => {};
    try {
      const result = await runHook(codex, { policyPath, logPath, input: bash("rg --files", workspace) });
      assert.equal(result.exitCode, exitCode, String(decision));
      if (reason) assert.match(result.stderr, reason);
      const log = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").at(-1));
      assert.equal(log.asked, decision ?? "timeout");
      assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".request.json")), [], "the request is withdrawn once answered or expired");
    } finally { stop(); }
  }
});

test("a command naming a protected file is refused at once, with no question", async () => {
  const { dir, policyPath, logPath, workspace } = setup();
  const result = await runHook(claude, { policyPath, logPath, input: bash("cat .env", workspace) });
  assert.match(JSON.stringify(result), /Protected-path policy refused/);
  assert.throws(() => readdirSync(dir));
});

test("the request carries what you need to decide, never more than 2000 characters of command", async () => {
  const { policy, workspace } = setup(0.005);
  let seen = null;
  const sleep = async () => { if (!seen) { const f = readdirSync(policy.ask.dir).find((x) => x.endsWith(".request.json")); if (f) seen = JSON.parse(readFileSync(path.join(policy.ask.dir, f), "utf8")); } await new Promise((r) => setTimeout(r, 5)); };
  assert.equal(await askUser(policy, { kind: "command", tool: "Bash", commands: ["x".repeat(5000)], cwd: workspace }, "unverified", codex, { sleep }), "timeout");
  assert.equal(seen.cli, "Codex");
  assert.equal(seen.text.length, 2000);
  assert.match(seen.id, /^[0-9a-f]{32}$/);
  assert.ok(Date.parse(seen.expiresAt) > Date.parse(seen.createdAt));
  assert.equal(hookTimeoutSeconds({ timeoutMs: 600_000 }), 630);
  assert.equal(hookTimeoutSeconds(null), 30);
});

test("Allow for this run: the same action is allowed without asking until the run ends; anything different still asks", async () => {
  const { dir, policyPath, logPath, workspace, policy } = setup();
  const run = async (command) => {
    const result = await runHook(codex, { policyPath, logPath, input: bash(command, workspace) });
    return { exitCode: result.exitCode, asked: JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").at(-1)).asked };
  };
  try {
    // The app's "Allow for this run" button writes the decision with remember: true.
    const remember = setInterval(() => {
      for (const f of (() => { try { return readdirSync(dir); } catch { return []; } })().filter((x) => x.endsWith(".request.json"))) {
        const r = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        try { writeFileSync(path.join(dir, `${r.id}.decision.json`), JSON.stringify({ id: r.id, decision: "allow", remember: true }), { flag: "wx" }); } catch { /* answered */ }
      }
    }, 20);
    try { assert.deepEqual(await run("rg --files"), { exitCode: 0, asked: "allow-run" }); } finally { clearInterval(remember); }
    assert.deepEqual(await run("rg --files"), { exitCode: 0, asked: "remembered" });
    assert.deepEqual(await run("git ls-files | head -5"), { exitCode: 2, asked: "timeout" }, "a different command asks again");
    const { useActionAsk, startAskRun } = await import("../src/guard/ask.mjs");
    useActionAsk({ stateDir: path.dirname(dir), minutes: 1 });
    await startAskRun();
    useActionAsk({});
    assert.deepEqual(await run("rg --files"), { exitCode: 2, asked: "timeout" }, "a new run forgets it");
    // A remembered entry never covers a protected path: those are refused before the list is read.
    mkdirSync(path.join(dir, "allowed-for-run"), { recursive: true });
    assert.match(JSON.stringify(await runHook(codex, { policyPath, logPath, input: bash("cat .env", workspace) })), /Protected-path policy refused/);
    assert.equal(policy.ask.dir, dir);
  } finally { /* nothing left running */ }
});

test("your yes is re-checked: a policy rewritten while you decided refuses the action", async () => {
  const { dir, policyPath, logPath, workspace, policy } = setup();
  const timer = setInterval(() => {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".request.json")); } catch { return; }
    if (!files.length) return;
    const request = JSON.parse(readFileSync(path.join(dir, files[0]), "utf8"));
    writeFileSync(policyPath, JSON.stringify({ ...policy, allowedPaths: ["changed.txt"] }));
    writeFileSync(path.join(dir, `${request.id}.decision.json`), JSON.stringify({ id: request.id, decision: "allow" }));
    clearInterval(timer);
  }, 20);
  try {
    const result = await runHook(codex, { policyPath, logPath, input: bash("rg --files", workspace) });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /policy changed while you were asked/);
  } finally { clearInterval(timer); }
});

test("Allow for this run is bound to the task, the run, the policy and the whole call, and stores no command", async () => {
  const { dir, workspace, policy } = setup();
  const action = { kind: "command", tool: "Bash", commands: ["rg --files token=abc123def456ghi"], input: { command: "rg --files token=abc123def456ghi" }, cwd: workspace };
  const answer = setInterval(() => {
    for (const f of (() => { try { return readdirSync(dir); } catch { return []; } })().filter((x) => x.endsWith(".request.json"))) {
      const r = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      try { writeFileSync(path.join(dir, `${r.id}.decision.json`), JSON.stringify({ id: r.id, decision: "allow", remember: true }), { flag: "wx" }); } catch { /* answered */ }
    }
  }, 20);
  const base = { ...policy, taskId: "T1", ask: { ...policy.ask, runId: "run-1" } };
  try { assert.equal(await askUser(base, action, "unverified", codex), "allow-run"); } finally { clearInterval(answer); }
  const quick = (p, a = action) => askUser({ ...p, ask: { ...p.ask, timeoutMs: 50 } }, a, "unverified", codex, { pollMs: 10 });
  assert.equal(await quick(base), "remembered");
  assert.equal(await quick({ ...base, taskId: "T2" }), "timeout", "another task");
  assert.equal(await quick({ ...base, ask: { ...base.ask, runId: "run-2" } }), "timeout", "another run");
  assert.equal(await quick({ ...base, allowedPaths: ["x.txt"] }), "timeout", "another policy");
  assert.equal(await quick(base, { ...action, input: { ...action.input, extra: 1 } }), "timeout", "same text, different call");
  const [saved] = readdirSync(path.join(dir, "allowed-for-run")).map((f) => readFileSync(path.join(dir, "allowed-for-run", f), "utf8"));
  assert.doesNotMatch(saved, /abc123def456ghi/, "only digests and a redacted preview are kept");
});

test("oversized hook input is refused in each CLI's own format", async () => {
  const { policyPath, logPath } = setup();
  const { Readable } = await import("node:stream");
  const big = JSON.stringify({ tool_name: "Bash", tool_input: { command: "x".repeat(2_100_000) } });
  for (const adapter of [codex, claude]) {
    const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { value: Object.assign(Readable.from([big]), { setEncoding() {} }), configurable: true });
    try {
      const result = await runHook(adapter, { policyPath, logPath });
      assert.equal(typeof result.exitCode, "number");
      assert.match(JSON.stringify(result), /oversized hook input/);
      if (adapter === claude) assert.match(result.stdout, /"permissionDecision":"deny"/);
      else assert.equal(result.exitCode, 2);
    } finally { Object.defineProperty(process, "stdin", stdin); }
  }
});

test("Codex MCP and unknown tools are refused whatever toolGuard says, and the reason names the tool (0b)", async () => {
  const { decide } = await import("../src/guard/decide.mjs");
  const { policy, workspace } = setup();
  for (const toolGuard of [false, true]) for (const tool of ["mcp__github__create_issue", "some_new_tool"]) {
    const decision = decide({ ...policy, toolGuard, protectionOnly: false, allowedPaths: ["a.txt"] }, codex.toAction({ tool_name: tool, tool_input: { q: 1 }, cwd: workspace }), { adapter: codex });
    assert.equal(decision.effect, "stop", `${tool} toolGuard=${toolGuard}`);
    assert.match(decision.reason, new RegExp(`${tool} is not a tool the guard knows`));
  }
});

test("kadono 0.40.1 probe: input-reading forms are refused, normal commands and plain wildcards are not", () => {
  const { policy, workspace } = setup();
  const command = (text) => ({ kind: "command", tool: "Bash", commands: [text], cwd: workspace });
  // Bypass forms: a shell's script read as a command of its own, a pipe from a program passing its input on, runners.
  for (const text of ["sh -c bash", "bash -c 'cat | sh'", "cat | sh", "cat - | bash", "head -n 5 | bash", "tee log | sh", "npx bash", "pnpm dlx bash", "bun x bash", "uv run python", "bash -is", "sqlite3 app.db", "psql", "psql -f -", "mysql", "deno", "bun repl", String.raw`cat $'.e\x6ev'`, String.raw`cat $'.\145nv'`]) assert.equal(definitelyRefused(policy, command(text)), true, text);
  // Normal work: combined options, subcommands, queries on the command line, and wildcards that single out nothing.
  for (const text of ["bash -lc 'npm test'", "sh -ec make", "bash -xc ls", "node -pe 1+1", "perl -lne print notes.txt", "python -Bc 1", "bun install", "bun test", "bun run dev", "bunx tsc", "deno test", "deno fmt", "sqlite3 app.db 'select 1'", "psql -c 'select 1'", "psql -l", "mysql -e 'select 1'", "uv run pytest -k python", "ls *", "echo $(date)", "ls src/*", "ls */*"]) assert.equal(definitelyRefused(policy, command(text)), false, text);
  // A wildcard that still singles out a protected name is refused outright.
  for (const text of ["cat */.env", "cat .g*/*", "cat .e*", "cat .[g]it/*", "cat [.]g*/*"]) assert.equal(definitelyRefused(policy, command(text)), true, text);
});

test("cmd.exe escapes and variable expansions that hide a protected name are refused outright, from Codex and from PowerShell", () => {
  const { policy, workspace } = setup();
  const command = (text, tool = "Bash") => ({ kind: "command", tool, commands: [text], cwd: workspace });
  for (const text of ["cmd /d /s /c type .g^it", "cmd /c type .e^nv", "type .g%ComSpec:~0,0%it", "cmd /c type .e%X%nv", "cmd /v:on /c type .e!X:~0,0!nv", "cmd /d /c for %A in (n) do @type .e%Av", "for %A in (x) do type .g%~nAit", "cmd /c for /f \"delims=\" %A in (\"env\") do type .%A", "cmd /d /s /c \"for %A in (n) do type .e%Av\"", "f^or %A in (n) do type .e%Av", "cmd /c ^f^o^r %A in (n) do type .e%Av", "cmd /c fo^\nr %A in (n) do type .e%Av", "echo x & f^or /l %A in (1,1,1) do type .g%~nAit", "cmd /d /c \"for,%A in (n) do type .e%Av\"", "cmd /c for;%A,in,(n) do type .e%Av", "cmd /c for=%A=in=(n) do type .e%Av", "cmd /d /c %X% %A in (n) do type .e%Av", "cmd /v:on /c !X! %A in (n) do type .e%Av", "cmd /d /c for %A in (n) do @type .e%^Av", "for %A in (x) do type .g%~n^Ait", "for %A in (n) do type .e%Av%ComSpec:~0,0%", "cmd /d /c type .e^\nnv", "cmd /d /c for %A in (n) do type .e%^\nAv", "for %_ in (nv) do type .e%_", "for %# in (nv) do type .e%#", "for %1 in (nv) do type .e%1", "cmd /d /c for %^^ in (nv) do type .e%^^"]) assert.equal(definitelyRefused(policy, command(text)), true, text);
  const codexCmd = codex.toAction({ tool_name: "exec_command", tool_input: { command: ["cmd.exe", "/d", "/s", "/c", "type .g^it"] }, cwd: workspace });
  assert.equal(definitelyRefused(policy, { ...codexCmd, cwd: workspace }), true);
  assert.equal(definitelyRefused(policy, command("Get-Content .g^it", "PowerShell")), true);
  // Ordinary uses of ^, % and ! stay askable.
  for (const text of ["git log HEAD^", "printf %s x", "echo done!", "printf .g%sit x", "awk {printf(%s)} f", "find . -printf %p", "printf .e%dnv 1"]) assert.equal(definitelyRefused(policy, command(text)), false, text);
});
