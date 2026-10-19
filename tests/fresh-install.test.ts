import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverClis, foundTools, runningLocal, type Probes } from "../src/main/discovery";
import { buildEngineArgs } from "../src/main/lib/engine-args";
import { DEFAULT_CLIS, DEFAULT_SETTINGS, ENGINE_DEFAULTS, defaultAgents } from "../src/shared/defaults";
import type { Project } from "../src/shared/types";

const models = { qa: "", assessment: "", elevate: "", reasoning: "" };
const probes = (commands: string[], urls: string[] = []): Probes => ({
  onPath: async (c) => commands.includes(c),
  answers: async (u) => urls.includes(u),
});
const project: Project = { id: "p", name: "P", path: "C:\\work", repoUrl: null, objective: "Ship", description: "", createdAt: "", archived: false, stateDir: "C:\\state", roleOverrides: {}, workflowOverrides: {} };

describe("a fresh install", () => {
  it("registers only the tools found on this computer", async () => {
    expect(await discoverClis([], probes([]))).toEqual([]);
    const found = await discoverClis([], probes(["claude"]));
    expect(found.map((c) => c.kind)).toEqual(["claude"]);
    const local = await discoverClis([], probes(["cline", "ollama"], ["http://127.0.0.1:8080/health"]));
    expect(local.map((c) => c.kind).sort()).toEqual(["cline", "llamacpp", "ollama"]);
  });

  it("knows which local model servers answer", async () => {
    expect(await runningLocal(DEFAULT_CLIS, probes([], ["http://127.0.0.1:11434/api/version"]))).toEqual(["ollama"]);
  });

  it("adds nothing already registered when discovery runs again", async () => {
    const first = await discoverClis([], probes(["codex"]));
    expect(await discoverClis(first, probes(["codex", "claude"]))).toMatchObject([{ kind: "claude" }]);
  });

  it("points the first agents at what was found, with no model from anyone's setup", () => {
    const claudeOnly = defaultAgents(models, foundTools(DEFAULT_CLIS.filter((c) => c.kind === "claude")));
    expect(claudeOnly.map((a) => a.cliId)).toEqual(["claude", "claude", "claude", "claude"]);
    const impl = claudeOnly.find((a) => a.role === "implementation")!;
    expect([impl.model, impl.provider]).toEqual(["", undefined]);
    const local = defaultAgents(models, foundTools(DEFAULT_CLIS.filter((c) => ["codex", "cline", "ollama"].includes(c.kind))));
    expect(local.find((a) => a.role === "implementation")).toMatchObject({ cliId: "cline", provider: "ollama", model: "" });
    // Ollama installed but not running: implement with the cloud CLI rather than a server that is down.
    const installed = DEFAULT_CLIS.filter((c) => ["codex", "cline", "ollama"].includes(c.kind));
    expect(foundTools(installed, []).local).toBeNull();
    expect(foundTools(installed, ["ollama"]).local).toBe("ollama");
    const nothing = defaultAgents(models, foundTools([]));
    expect(nothing.every((a) => a.cliId === "")).toBe(true);
  });

  it("will not launch a local model nobody chose", () => {
    const agents = defaultAgents(models, { orchestrator: "codex", local: "llamacpp" });
    const plan = buildEngineArgs({ project, agents, clis: DEFAULT_CLIS, settings: structuredClone(DEFAULT_SETTINGS) });
    expect(plan.problems).toContain("Choose a model for Implementer in Agents.");
    expect(plan.args).not.toContain("--model");
  });

  it("ships no machine-specific defaults", () => {
    expect(JSON.stringify({ DEFAULT_CLIS, ENGINE_DEFAULTS, DEFAULT_SETTINGS })).not.toMatch(/glm|8081|[A-Z]:\\\\|Users/i);
    const engine = ["loop-options.mjs", "cline-runtime-config.mjs", "cline-cli-worker.mjs"].map((f) => readFileSync(path.join(__dirname, "..", "engine", "src", f), "utf8")).join("\n");
    expect(engine).not.toMatch(/glm-4\.7|127\.0\.0\.1:8081/);
  });
});

describe("local model connections", () => {
  it("pass their own address to the engine, whatever port they use", () => {
    const clis = structuredClone(DEFAULT_CLIS).map((c) => (c.kind === "llamacpp" ? { ...c, location: "http://127.0.0.1:8081/v1" } : c.kind === "ollama" ? { ...c, location: "http://10.0.0.5:11434/" } : c));
    const pick = (provider: "llamacpp" | "ollama") => {
      const agents = defaultAgents(models, { orchestrator: "codex", local: provider }).map((a) => (a.role === "implementation" ? { ...a, model: "m" } : a));
      return buildEngineArgs({ project, agents, clis, settings: structuredClone(DEFAULT_SETTINGS) }).args;
    };
    const llama = pick("llamacpp");
    expect(llama[llama.indexOf("--llamacpp-url") + 1]).toBe("http://127.0.0.1:8081/v1");
    const ollama = pick("ollama");
    expect(ollama[ollama.indexOf("--ollama-url") + 1]).toBe("http://10.0.0.5:11434");
    expect(ollama).not.toContain("--llamacpp-url");
  });
});
