import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canRerun, prepareRerun, savedTaskIds } from "../src/main/projects";

describe("run one task again", () => {
  it("offers only kept tasks and queues a copy under a new id", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rerun-"));
    mkdirSync(path.join(dir, "tasks"));
    writeFileSync(path.join(dir, "tasks", "T1_slug.json"), JSON.stringify({ id: "T1 slug", name: "Slug", prompt: "Add slug", allowedPaths: ["src/slug.js"], qaCommand: "npm test", savedAt: "x" }));
    const saved = await savedTaskIds(dir);
    expect([canRerun(saved, "T1 slug"), canRerun(saved, "T2")]).toEqual([true, false]);
    const file = await prepareRerun(dir, "T1 slug", 1_000_000);
    const task = JSON.parse(readFileSync(file, "utf8"));
    expect(task).toEqual({ id: "T1 slug-again-lfls", name: "Slug (again)", prompt: "Add slug", allowedPaths: ["src/slug.js"], qaCommand: "npm test" });
    await expect(prepareRerun(dir, "T2")).rejects.toThrow(/was not kept/);
  });
});
