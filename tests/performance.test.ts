import { describe, expect, it } from "vitest";
import type { Agent, Project } from "@shared/types";
import { buildEngineArgs } from "../src/main/lib/engine-args";
import { DEFAULT_CLIS, DEFAULT_SETTINGS, defaultAgents } from "../src/main/defaults";
import { describeEvent } from "../src/renderer/src/lib/events";
import type { WorkflowRole } from "@shared/types";

const project: Project = { id: "p", name: "P", path: "C:\\work", repoUrl: null, objective: "Ship", description: "", createdAt: "", archived: false, stateDir: "C:\\state", roleOverrides: {}, workflowOverrides: {} };
const base = () => defaultAgents({ qa: "gpt-6.1-sol", assessment: "gpt-6.1-sol", elevate: "gpt-6-astra", reasoning: "medium" });
const launch = (agents: Agent[]) => buildEngineArgs({ project, agents, clis: DEFAULT_CLIS, settings: structuredClone(DEFAULT_SETTINGS) });
const flag = (args: string[], key: string) => args[args.indexOf(key) + 1];

it('forwards effective auto-continue to the engine instead of relying on a later app poll',()=>{
  const settings=structuredClone(DEFAULT_SETTINGS);settings.workflow.autoContinue=true;
  const plan=buildEngineArgs({project:{...project,workflowOverrides:{autoContinue:false}},agents:base(),clis:DEFAULT_CLIS,settings});
  expect(flag(plan.args,'--auto-continue')).toBe('false');
  expect(flag(launch(base()).args,'--auto-continue')).toBe(String(DEFAULT_SETTINGS.workflow.autoContinue));
});

describe("usage-limit backup configuration", () => {
  const configured = () => {
    const agents = base();
    const backup = { ...agents.find(a => a.role === "qa")!, id: "backup", name: "Backup", cliId: "claude", model: "sonnet", reasoning: "high", fast: true };
    return [...agents.map(a => a.role === "assessment" ? { ...a, backupAgentId: backup.id } : a), backup];
  };
  it("launches backup settings for Assessment and Resolver with the backup executable", () => {
    const plan = launch(configured());
    expect(plan.problems).toEqual([]);
    for (const role of ["assessment", "resolver"]) {
      expect(["cli", "model", "effort", "fast"].map(k => flag(plan.args, `--${role}-backup-${k}`))).toEqual(["claude", "sonnet", "high", "true"]);
    }
  });
  it("blocks missing, disabled, self and same-CLI backups", () => {
    for (const mode of ["missing", "disabled", "self", "same-cli"]) {
      const agents = configured().map(a => a.id === "backup" ? { ...a, enabled: mode !== "disabled", cliId: mode === "same-cli" ? "codex" : a.cliId } : a);
      const assessment = agents.find(a => a.role === "assessment")!;
      const input = mode === "missing" ? agents.filter(a => a.id !== "backup") : mode === "self" ? agents.map(a => a.id === assessment.id ? { ...a, backupAgentId: a.id } : a) : agents;
      expect(launch(input).problems.join(" ")).toMatch(/backup/i);
    }
  });
  it("validates a backup's model against its own CLI", () => {
    const agents = configured().map(a => a.id === "backup" ? { ...a, model: "gpt-invalid" } : a);
    expect(launch(agents).problems.join(" ")).toMatch(/not a Claude Code model/);
  });
  it("uses the backup's selected executable and rejects conflicting executables for one CLI kind", () => {
    const custom = { ...DEFAULT_CLIS.find(c => c.kind === "claude")!, id: "custom-claude", name: "Custom Claude", builtIn: false, location: "C:\\custom\\claude.exe" };
    const list = configured().map(a => a.id === "backup" ? { ...a, cliId: custom.id } : a);
    const build = (agents: Agent[]) => buildEngineArgs({ project, agents, clis: [...DEFAULT_CLIS, custom], settings: structuredClone(DEFAULT_SETTINGS) });
    expect(flag(build(list).args, "--claude-command")).toBe("C:\\custom\\claude.exe");
    const conflicting = list.map(a => a.role === "elevation" ? { ...a, cliId: "claude", model: "opus" } : a);
    expect(build(conflicting).problems.join(" ")).toMatch(/different executables/i);
  });
  it("renders fallback as a role switch with the actual model", () => {
    expect(describeEvent({ timestamp: "", type: "orchestrator-fallback", role: "qa", fromCli: "codex", toCli: "claude", model: "sonnet" })).toMatch(/QA.*Codex.*Claude Code.*sonnet/);
  });
});

describe("second-opinion gate", () => {
  const role: WorkflowRole = { id: "second-opinion-qa", name: "Second-opinion QA", description: "Independent acceptance review", stage: "before-qa", gate: true, enabled: true, instructions: "Review acceptance criteria using engine evidence.", dir: "", warnings: [] };
  const plan = (agents: Agent[], roles = [role]) => buildEngineArgs({ project, agents, roles, clis: DEFAULT_CLIS, settings: structuredClone(DEFAULT_SETTINGS) });
  it("blocks an enabled second opinion without an agent and requires the other CLI", () => {
    expect(plan(base()).problems.join(" ")).toMatch(/Second-opinion QA.*agent/i);
    const same = { ...base().find(a => a.role === "qa")!, id: "second", role: "custom" as const, customRole: role.id };
    expect(plan([...base(), same]).problems.join(" ")).toMatch(/different CLI/i);
    const valid = plan([...base(), { ...same, cliId: "claude", model: "sonnet" }]);
    expect(valid.problems).toEqual([]);
    expect(valid.roles).toMatchObject([{ id: "second-opinion-qa", cli: "claude", gate: true, stage: "before-qa" }]);
  });
  it("is opt-in and cannot silently become advisory or lose its instructions", () => {
    expect(plan(base(), [{ ...role, enabled: false }]).problems).toEqual([]);
    for (const changed of [{ ...role, gate: false }, { ...role, instructions: " " }, { ...role, stage: "after-pass" as const }]) {
      expect(plan(base(), [changed]).problems.join(" ")).toMatch(/Second-opinion QA/i);
    }
  });
});
