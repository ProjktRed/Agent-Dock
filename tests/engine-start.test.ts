import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager } from "../src/main/engine";
import type { Project } from "../src/shared/types";

function setup(cli: string) {
  const root = mkdtempSync(join(tmpdir(), "dock-engine-start-"));
  const engineDir = join(root, "engine");
  mkdirSync(join(engineDir, "src"), { recursive: true });
  writeFileSync(join(engineDir, "src", "cli.mjs"), cli);
  const project = { id: "p", name: "P", path: root, stateDir: join(root, "state") } as unknown as Project;
  return { root, engineDir, project };
}
const node = async () => ({ command: process.execPath, env: { ...process.env } });
// start() reads the run's control through the engine's own module, which vitest cannot import natively.
vi.spyOn(EngineManager.prototype as unknown as { state: () => Promise<unknown> }, "state").mockResolvedValue({ readControl: async () => ({}), setControl: async () => undefined });

describe("engine start", () => {
  // R-11: a run with nothing to do finishes within the startup check.
  it("a run that finishes at once with its result receipt is not a startup failure", async () => {
    const { root, engineDir, project } = setup(`import { writeFileSync } from "node:fs"; writeFileSync("loop-result.json", JSON.stringify({ status: "complete" }));\n`);
    try {
      await expect(new EngineManager(engineDir, node).start(project, [])).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("an engine that exits without a receipt is still reported", async () => {
    const { root, engineDir, project } = setup(`console.error("Error: preflight failed"); process.exit(1);\n`);
    try {
      await expect(new EngineManager(engineDir, node).start(project, [])).rejects.toThrow(/exited during startup/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  // S-02: changed engine files are never loaded or started.
  it("refuses to start or load changed engine files", async () => {
    const { root, engineDir, project } = setup(`process.exit(0);\n`);
    try {
      const manager = new EngineManager(engineDir, node, () => ["engine/src/guard/decide.mjs was changed"]);
      await expect(manager.start(project, [])).rejects.toThrow(/engine files were changed outside Agent Dock/);
      await expect(manager.validateTask({})).rejects.toThrow(/engine files were changed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
