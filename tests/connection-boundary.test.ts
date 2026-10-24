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
const { checkCli } = await import("../src/main/lib/clis");
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
