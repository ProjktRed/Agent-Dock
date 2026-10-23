import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Every git process this test starts is a stub that answers after 20 ms; it counts how many run at once.
const counter = vi.hoisted(() => ({ now: 0, most: 0 }));
vi.mock("node:child_process", () => ({
  execFile: (_command: string, _args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
    counter.now++;
    counter.most = Math.max(counter.most, counter.now);
    setTimeout(() => { counter.now--; callback(null, "", ""); }, 20);
  },
}));
const { gitInfo } = await import("../src/main/lib/git");

describe("git status for many projects (test report F8)", () => {
  it("reads at most three workspaces at once", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dock-git-burst-"));
    try {
      const dirs = Array.from({ length: 12 }, (_, i) => { const dir = path.join(root, `p${i}`); mkdirSync(path.join(dir, ".git"), { recursive: true }); return dir; });
      const infos = await Promise.all(dirs.map((dir) => gitInfo(dir)));
      expect(infos.every((info) => info.isRepo)).toBe(true);
      expect(counter.most).toBe(15);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
