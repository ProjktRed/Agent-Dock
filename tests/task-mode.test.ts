import { describe, expect, it } from "vitest";
import type { Agent, CliConnection, LimitsState, ProviderLimits } from "@shared/types";
import { maxLimitsOf, suggestTaskMode, taskModeOf } from "../src/shared/task-mode";
import { DEFAULT_CLIS, defaultAgents } from "../src/main/defaults";

const clis = (): CliConnection[] => structuredClone(DEFAULT_CLIS);
const impl = (over: Partial<Agent>): Agent => ({ ...defaultAgents({ qa: "q", assessment: "a", elevate: "e", reasoning: "medium" }).find((a) => a.role === "implementation")!, ...over });
const cliId = (kind: string) => clis().find((c) => c.kind === kind)!.id;
const limits = (claude: Partial<ProviderLimits>): LimitsState => ({ codex: null, claude: { provider: "claude", ok: true, fetchedAt: "", source: "", plan: null, status: "ok", statusText: "", windows: [], extras: [], ...claude } } as LimitsState);

describe("task size mode", () => {
  it("defaults to eco and cleans max limits", () => {
    expect(taskModeOf({})).toBe("eco");
    expect(taskModeOf({ taskMode: "max" })).toBe("max");
    expect(maxLimitsOf({ maxLimits: { files: 12.7, newLines: -5, readFiles: Number.NaN, timeoutMinutes: 60 } })).toEqual({ files: 12, newLines: 0, readFiles: 0, timeoutMinutes: 60 });
  });

  it("suggests standard for Pro, Max or API plans and large local models, never max", () => {
    const claude = impl({ cliId: cliId("claude"), provider: undefined });
    expect(suggestTaskMode({ implementation: claude, clis: clis(), limits: limits({ plan: "Max" }) }).mode).toBe("standard");
    expect(suggestTaskMode({ implementation: claude, clis: clis(), limits: limits({ plan: "Pro" }) }).mode).toBe("standard");
    expect(suggestTaskMode({ implementation: claude, clis: clis(), limits: limits({ plan: "Free" }) }).mode).toBe("eco");
    expect(suggestTaskMode({ implementation: claude, clis: clis(), limits: limits({ ok: false, error: "Claude Code reported no plan limits (API-key accounts have no plan windows)" }) }).mode).toBe("standard");
    expect(suggestTaskMode({ implementation: claude, clis: clis(), limits: null }).mode).toBe("eco");
    const local = impl({ cliId: cliId("cline"), provider: "llamacpp", contextTokens: 98_304 });
    expect(suggestTaskMode({ implementation: local, clis: clis() })).toMatchObject({ mode: "eco", reason: expect.stringMatching(/96K context/) });
    expect(suggestTaskMode({ implementation: { ...local, contextTokens: 262_144 }, clis: clis() }).mode).toBe("standard");
    expect(suggestTaskMode({ implementation: null, clis: clis() }).mode).toBe("eco");
  });
});
