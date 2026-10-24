import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const keyring = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => keyring.available,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (data: Buffer) => data.toString().replace(/^enc:/, ""),
  },
}));
const { AppStore } = await import("../src/main/store");

describe("secret environment values (S-15)", () => {
  it("moves them out of clis.json into the encrypted secrets, and back into memory on load", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dock-store-"));
    try {
      mkdirSync(path.join(root, "config"));
      const env = [{ key: "MY_TOKEN", value: "tok-123456", secret: true }, { key: "REGION", value: "eu", secret: false }];
      writeFileSync(path.join(root, "config", "clis.json"), JSON.stringify([{ id: "c1", kind: "codex", name: "Codex", location: "codex", env }]));
      const store = new AppStore(root);
      await store.load();
      const onDisk = readFileSync(path.join(root, "config", "clis.json"), "utf8");
      expect(onDisk).not.toContain("tok-123456");
      expect(JSON.parse(onDisk)[0].env).toEqual([{ key: "MY_TOKEN", value: "", secret: true }, { key: "REGION", value: "eu", secret: false }]);
      expect(readFileSync(path.join(root, "config", "secrets.json"), "utf8")).not.toContain("tok-123456");
      expect(store.data.clis[0].env[0].value).toBe("tok-123456");
      expect(store.secretValues()).toContain("tok-123456");

      const again = new AppStore(root);
      await again.load();
      expect(again.data.clis[0].env[0].value).toBe("tok-123456");
      again.data.clis[0].env = again.data.clis[0].env.filter((e) => !e.secret);
      await again.saveClis();
      expect(Object.keys(JSON.parse(readFileSync(path.join(root, "config", "secrets.json"), "utf8")))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says which credential store is missing when a key cannot be saved", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dock-store-"));
    keyring.available = false;
    try {
      const store = new AppStore(root);
      await store.load();
      await expect(store.setSecret("x", "value")).rejects.toThrow(process.platform === "linux" ? /keyring/ : process.platform === "win32" ? /Windows credential/ : /Keychain|credential store/);
    } finally {
      keyring.available = true;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Defensive review (0.39.0): without a credential store, saveClis wrote secret values to clis.json as they were.
  it("never writes a secret environment value in plain text when there is no credential store", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dock-store-"));
    try {
      mkdirSync(path.join(root, "config"));
      const env = [{ key: "MY_TOKEN", value: "tok-123456", secret: true }, { key: "REGION", value: "eu", secret: false }];
      writeFileSync(path.join(root, "config", "clis.json"), JSON.stringify([{ id: "c1", kind: "codex", name: "Codex", location: "codex", env }]));
      keyring.available = false;
      const store = new AppStore(root);
      await store.load();
      await store.saveClis();
      const onDisk = readFileSync(path.join(root, "config", "clis.json"), "utf8");
      expect(onDisk).not.toContain("tok-123456");
      expect(JSON.parse(onDisk)[0].env).toEqual([{ key: "MY_TOKEN", value: "", secret: true }, { key: "REGION", value: "eu", secret: false }]);
      expect(() => store.assertSecretEnvStorable({ ...store.data.clis[0], env })).toThrow(/not saved/);
      expect(() => store.assertSecretEnvStorable({ ...store.data.clis[0], env: [env[1]] })).not.toThrow();
    } finally {
      keyring.available = true;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
