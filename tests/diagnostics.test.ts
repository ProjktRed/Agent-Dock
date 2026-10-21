import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { zipFiles } from "../src/main/lib/zip";
import { collectDiagnostics, homeMasker, safeClis } from "../src/main/diagnostics";
import { DEFAULT_SETTINGS } from "../src/main/defaults";
import type { CliConnection, Project } from "../src/shared/types";

/** Reads the archive back through its central directory, as zip tools do. */
function unzip(zip: Buffer): Record<string, string> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const size = zip.readUInt32LE(at + 20), crc = zip.readUInt32LE(at + 16), nameLength = zip.readUInt16LE(at + 28), local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = inflateRawSync(zip.subarray(dataAt, dataAt + size));
    expect(crc32(data) >>> 0).toBe(crc);
    files[name] = data.toString("utf8");
    at += 46 + nameLength;
  }
  return files;
}

describe("diagnostics export", () => {
  it("writes a zip that reads back byte for byte, including UTF-8 names", async () => {
    const big = "line\n".repeat(50_000);
    const zip = zipFiles([{ name: "a.txt", data: "hello" }, { name: "dir\\ü.json", data: "{}" }, { name: "big.log", data: big }]);
    expect(unzip(zip)).toEqual({ "a.txt": "hello", "dir/ü.json": "{}", "big.log": big });
    expect(zip.length).toBeLessThan(big.length / 10);
    // The zip reader that ships with Windows (bsdtar in System32) lists it too.
    if (process.platform === "win32") {
      const dir = await mkdtemp(path.join(os.tmpdir(), "zip-"));
      try {
        await writeFile(path.join(dir, "t.zip"), zip);
        const listing = execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-tf", "t.zip"], { cwd: dir, encoding: "utf8" });
        // tar prints names in the console code page, so only the ASCII ones are compared (the bundle's own names are ASCII).
        const names = listing.split(/\r?\n/).filter(Boolean);
        expect(names).toHaveLength(3);
        expect([names[0], names[2]]).toEqual(["a.txt", "big.log"]);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });

  it("masks the home folder in every slash style and hides secret environment values", () => {
    const mask = homeMasker("C:\\Users\\alice");
    expect(mask("C:\\Users\\alice\\proj and C:/Users/alice/x and \"C:\\\\Users\\\\alice\\\\y\"")).toBe("~\\proj and ~/x and \"~\\\\y\"");
    const clis = safeClis([{ id: "c", env: [{ key: "API_KEY", value: "sk-123", secret: true }, { key: "MODE", value: "fast", secret: false }, { key: "EMPTY", value: "", secret: true }] } as unknown as CliConnection]);
    expect(clis[0].env).toEqual([{ key: "API_KEY", value: "[secret]", secret: true }, { key: "MODE", value: "fast", secret: false }, { key: "EMPTY", value: "", secret: true }]);
  });

  it("collects each project's state with secrets removed and leaves code, prompts and the raw action log out", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "diag-state-"));
    try {
      const secret = "supersecretvalue123";
      await writeFile(path.join(stateDir, "live.json"), JSON.stringify({ stage: "BLOCKED", note: `key ${secret}` }));
      await writeFile(path.join(stateDir, "qa-packet.json"), JSON.stringify({ diff: "PRIVATE_CODE" }));
      await writeFile(path.join(stateDir, "action-log.ndjson"), "RAW_ACTION_LOG\n");
      await writeFile(path.join(stateDir, "activity.ndjson"), Array.from({ length: 2500 }, (_, i) => JSON.stringify({ i, token: i === 2499 ? secret : "" })).join("\n") + "\n");
      await writeFile(path.join(stateDir, "app-engine.log"), "x".repeat(600 * 1024) + "\nLAST LINE\n");
      await mkdir(path.join(stateDir, "runs"));
      for (let i = 0; i < 12; i++) await writeFile(path.join(stateDir, "runs", `2026-10-${String(i + 1).padStart(2, "0")}.json`), JSON.stringify({ i }));
      await mkdir(path.join(stateDir, "codex"));
      await writeFile(path.join(stateDir, "codex", "prompt.txt"), "MODEL_PROMPT");
      await writeFile(path.join(stateDir, "task-board.json"), JSON.stringify({ version: 1, revision: 3, order: ["abc123def456"] }));
      const project = { id: "p1", name: "My/App", stateDir, archived: false } as unknown as Project;
      const entries = await collectDiagnostics({
        about: { version: "0.23.6" }, settings: DEFAULT_SETTINGS, agents: [], clis: [], roles: [], projects: [project, { ...project, id: "p2" }],
        statuses: { p1: { stage: "BLOCKED" } }, verifyActionLog: async () => ({ ok: true, entries: 1 }),
        redact: (text) => text.split(secret).join("[redacted:secret]"),
      });
      const files = Object.fromEntries(entries.map((e) => [e.name, String(e.data)]));
      const all = Object.values(files).join("\n");
      expect(all).not.toContain(secret);
      expect(all).not.toMatch(/PRIVATE_CODE|RAW_ACTION_LOG|MODEL_PROMPT/);
      expect(files["projects/My_App/state/live.json"]).toContain("[redacted:secret]");
      expect(files["projects/My_App (2)/status.json"]).toBe("null\n");
      expect(files["projects/My_App/activity-tail.ndjson"].trim().split("\n")).toHaveLength(2000);
      expect(files["projects/My_App/app-engine-tail.log"].endsWith("LAST LINE\n")).toBe(true);
      expect(files["projects/My_App/app-engine-tail.log"].length).toBeLessThanOrEqual(512 * 1024);
      expect(Object.keys(files).filter((n) => n.startsWith("projects/My_App/runs/"))).toHaveLength(10);
      expect(files["projects/My_App/runs/2026-10-12.json"]).toBeDefined();
      expect(JSON.parse(files["projects/My_App/state/task-board.json"]).revision).toBe(3);
      expect(JSON.parse(files["projects/My_App/action-log-verify.json"])).toEqual({ ok: true, entries: 1 });
      expect(files["README.txt"]).toContain("Look through the files before you share them.");
      expect(unzip(zipFiles(entries))["about.json"]).toContain("0.23.6");
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});
