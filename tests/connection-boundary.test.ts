import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliConnection } from "../src/shared/types";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (data: Buffer) => data.toString().replace(/^enc:/, ""),
  },
}));
const { AppStore } = await import("../src/main/store");
const { mergeImport, parseSettingsFile } = await import("../src/main/settings-transfer");
const { checkCli, connectionUrlProblem, detectOnPath, programNeedsConfirmation } = await import("../src/main/lib/clis");
const { DEFAULT_CLIS, DEFAULT_SETTINGS } = await import("../src/shared/defaults");

const file = (clis: unknown[]) => JSON.stringify({ format: "agent-dock-settings", version: 1, exportedAt: "t", appVersion: "v", settings: {}, agents: [], clis, roles: [] });
const conn = (over: Partial<CliConnection>) => ({ id: "x", kind: "openai", name: "X", location: "https://audit.invalid/v1", env: [], ...over });

// Second defensive review (0.39.0): an imported connection could take the id of one of the app's own
// secrets (the action log key) and send it to the connection's address in a health check.
describe("connection ids and kinds from a file or the window", () => {
  it("refuses ids that are not plain words and kinds Agent Dock does not know", () => {
    for (const id of ["actionlog:key", "approvals:key", "notify:telegram", "env:codex:KEY", "../x", "", "a".repeat(65)]) expect(() => parseSettingsFile(file([conn({ id })]))).toThrow(/invalid connection/);
    for (const kind of ["shell", "", "CODEX", "__proto__"]) expect(() => parseSettingsFile(file([conn({ kind: kind as never })]))).toThrow(/invalid connection/);
    expect(parseSettingsFile(file([conn({ id: "openai-ab12cd3" })])).clis).toHaveLength(1);
  });

  it("never lets a file change what an existing connection is", () => {
    const current = { settings: structuredClone(DEFAULT_SETTINGS), agents: [], clis: structuredClone(DEFAULT_CLIS) as CliConnection[] };
    const merged = mergeImport(current, parseSettingsFile(file([conn({ id: "ollama", kind: "openai" })])));
    expect(merged.clis.find((c) => c.id === "ollama")?.kind).toBe("ollama");
    expect(merged.summary.skipped.join()).toMatch(/different kind/);
  });

  it("keeps connection keys apart from the app's own secrets, moving keys saved under the bare id", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dock-ids-"));
    try {
      mkdirSync(path.join(root, "config"));
      writeFileSync(path.join(root, "config", "clis.json"), JSON.stringify([conn({ id: "openai-1" })]));
      writeFileSync(path.join(root, "config", "secrets.json"), JSON.stringify({ "openai-1": Buffer.from("enc:sk-old").toString("base64"), "actionlog:key": Buffer.from("enc:LOGKEY").toString("base64") }));
      const store = new AppStore(root);
      await store.load();
      expect(store.getCliSecret("openai-1")).toBe("sk-old");
      expect(Object.keys(JSON.parse(readFileSync(path.join(root, "config", "secrets.json"), "utf8"))).sort()).toEqual(["actionlog:key", "cli:openai-1"]);
      expect(store.getCliSecret("actionlog:key")).toBeNull();
      expect(store.hasCliSecret("actionlog")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never starts a program for an unknown kind of connection", async () => {
    const health = await checkCli({ ...(DEFAULT_CLIS[0] as CliConnection), kind: "shell" as never, location: process.execPath }, null);
    expect(health.state).toBe("disconnected");
    expect(health.detail).toMatch(/Unknown kind/);
    expect(health.log).toEqual([]);
  });
});

// Third defensive review (0.39.0): the window could still choose programs to run, leftover keys under a
// bare id could pass to a later connection, and the key-move dialog showed the raw address.
describe("programs, addresses and leftover keys", () => {
  it("drops every key left under a bare id, keeping the app's own and moving a saved connection's", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dock-ids-"));
    const enc = (text: string) => Buffer.from(`enc:${text}`).toString("base64");
    try {
      mkdirSync(path.join(root, "config"));
      writeFileSync(path.join(root, "config", "clis.json"), JSON.stringify([conn({ id: "openai-1" }), conn({ id: "openai-2" })]));
      writeFileSync(path.join(root, "config", "secrets.json"), JSON.stringify({ "openai-1": enc("old-copy"), "cli:openai-1": enc("current"), "openai-2": enc("moved"), "openai-gone": enc("orphan"), "approvals:key": enc("A"), "notify:telegram": enc("T") }));
      const store = new AppStore(root);
      await store.load();
      expect(Object.keys(JSON.parse(readFileSync(path.join(root, "config", "secrets.json"), "utf8"))).sort()).toEqual(["approvals:key", "cli:openai-1", "cli:openai-2", "notify:telegram"]);
      expect([store.getCliSecret("openai-1"), store.getCliSecret("openai-2"), store.getCliSecret("openai-gone")]).toEqual(["current", "moved", null]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds only Git and the supported CLIs, and never runs anything else", async () => {
    await expect(detectOnPath(process.execPath)).rejects.toThrow(/Only Git and the supported CLIs/);
    await expect(detectOnPath("*")).rejects.toThrow(/Only Git/);
    await expect(detectOnPath("node")).rejects.toThrow(/Only Git/);
  });

  it("accepts only http(s) addresses without a user name or password", () => {
    for (const ok of ["http://127.0.0.1:8080/v1", "https://openrouter.ai/api/v1", "http://[::1]:11434"]) expect(connectionUrlProblem(ok)).toBeNull();
    expect(connectionUrlProblem("https://api.openai.com@evil.example/v1")).toMatch(/user name or password/);
    expect(connectionUrlProblem("https://user:pw@example.com/v1")).toMatch(/user name or password/);
    expect(connectionUrlProblem("file:///C:/x")).toMatch(/http/);
    expect(connectionUrlProblem("javascript:alert(1)")).toMatch(/http/);
    expect(connectionUrlProblem("not a url")).toMatch(/not a valid URL/);
  });

  it("asks before running a CLI program that is neither its plain name nor found on PATH for it", async () => {
    const bin = mkdtempSync(path.join(tmpdir(), "dock-bin-"));
    const saved = process.env.PATH;
    try {
      const fake = path.join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
      writeFileSync(fake, process.platform === "win32" ? "@echo off\r\necho 1.0\r\n" : "#!/bin/sh\necho 1.0\n", { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${saved}`;
      expect(await programNeedsConfirmation({ kind: "codex", location: "codex" })).toBe(false);
      expect(await programNeedsConfirmation({ kind: "codex", location: fake })).toBe(false);
      expect(await programNeedsConfirmation({ kind: "codex", location: `"${fake}"` })).toBe(false);
      expect(await programNeedsConfirmation({ kind: "codex", location: process.execPath })).toBe(true);
      expect(await programNeedsConfirmation({ kind: "codex", location: "codex-other" })).toBe(true);
      expect(await programNeedsConfirmation({ kind: "openai", location: "https://example.com/v1" })).toBe(false);
    } finally {
      process.env.PATH = saved;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
