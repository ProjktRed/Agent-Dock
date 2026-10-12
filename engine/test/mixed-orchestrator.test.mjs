import test from "node:test";
import assert from "node:assert/strict";
import { RoleRoutedOrchestrator, isMixed, roleClis, useMixedDefaults } from "../src/mixed-orchestrator.mjs";
import { ROLE_EFFORT, roleModel, useOrchestratorModels } from "../src/codex-worker.mjs";

test("role CLIs default to --orchestrator; Resolver follows Assessment", () => {
  assert.deepEqual(roleClis({}), { qa: "codex", assessment: "codex", resolver: "codex", elevate: "codex" });
  const clis = roleClis({ orchestrator: "codex", "assessment-cli": "claude" });
  assert.deepEqual(clis, { qa: "codex", assessment: "claude", resolver: "claude", elevate: "codex" });
  assert.equal(isMixed(clis), true);
  assert.equal(isMixed(roleClis({ orchestrator: "claude" })), false);
  assert.throws(() => roleClis({ "qa-cli": "gemini" }), /qa-cli must be codex or claude/);
});

test("mixed roles take their own CLI's default model", () => {
  useOrchestratorModels({ qa: "gpt-6.1-sol", assessment: "gpt-6.1-sol", resolver: "gpt-6.1-sol", elevate: "gpt-6-astra", reasoning: "medium" });
  useMixedDefaults({ qa: "codex", assessment: "claude", resolver: "claude", elevate: "claude" });
  assert.equal(roleModel("qa"), "gpt-6.1-sol");
  assert.equal(roleModel("assessment"), "sonnet");
  assert.equal(roleModel("elevate"), "opus");
  assert.equal(ROLE_EFFORT.assessment, "medium");
  useOrchestratorModels({ qa: "gpt-6.1-sol", assessment: "gpt-6.1-sol", resolver: "gpt-6.1-sol", elevate: "gpt-6-astra", reasoning: "medium" });
});

test("each operation goes to its role's worker; idle checks and counts cover every worker once", async () => {
  const calls = [];
  const worker = (name) => ({
    activeCount: name === "claude" ? 1 : 0,
    assertIdle: async () => calls.push(`${name}.idle`),
    assess: async () => calls.push(`${name}.assess`),
    review: async (packet, context) => calls.push(`${name}.review:${packet}:${context}`),
    assessCorrection: async () => calls.push(`${name}.correction`),
    reassessManualReview: async () => calls.push(`${name}.elevate`),
    resolveBlocked: async () => calls.push(`${name}.resolve`),
  });
  const codex = worker("codex");
  const claude = worker("claude");
  const routed = new RoleRoutedOrchestrator({ qa: codex, assessment: claude, resolver: claude, elevate: codex });
  await routed.assess({});
  await routed.review("p", "c");
  await routed.assessCorrection({});
  await routed.reassessManualReview({});
  await routed.resolveBlocked({});
  await routed.assertIdle();
  assert.deepEqual(calls, ["claude.assess", "codex.review:p:c", "claude.correction", "codex.elevate", "claude.resolve", "codex.idle", "claude.idle"]);
  assert.equal(routed.activeCount, 1);
});
