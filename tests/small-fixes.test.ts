import { describe, expect, it } from "vitest";
import { parseRoleFile, serializeRole } from "../src/main/roles";
import { parseInvocationUsage } from "../src/main/lib/usage";

describe("0.38.1 audit leftovers", () => {
  // AD-10: quotes around a role name were lost on save and load.
  it("role names and descriptions survive a save and load as written", () => {
    const role = { name: '"Strict" reviewer: v2', description: "Checks 'everything' # twice \ once", stage: "before-qa" as const, gate: false, fix: false, enabled: true, instructions: "Do it." };
    const back = parseRoleFile(serializeRole(role), "r", "/roles/r");
    expect([back.name, back.description, back.instructions]).toEqual([role.name, role.description, "Do it."]);
  });

  // AD-12: a null row threw and dropped the invocation's usage.
  it("a null or numeric row does not drop an invocation's usage", () => {
    const events = ["null", "42", JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } })].join("\n");
    expect(parseInvocationUsage(events)).toEqual({ provider: "OpenAI · Codex", input: 10, cached: 2, output: 5 });
  });
});
