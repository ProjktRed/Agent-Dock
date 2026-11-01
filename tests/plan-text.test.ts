import { describe, expect, it } from "vitest";
import { planCounts } from "../src/renderer/src/lib/plan-text";

describe("plan review counts", () => {
  it("counts the phases and tasks of a generated plan, so Save can be enabled", () => {
    const plan = "# Plan\n\n## Phase 1 — Base\n- [ ] Set up\n  - [x] Nested done\n## Phase 2: More\n- [ ] Tests\nNot a task\n- plain bullet\n";
    expect(planCounts(plan)).toEqual({ phases: 2, tasks: 3 });
    expect(planCounts("Some text without a plan")).toEqual({ phases: 0, tasks: 0 });
  });
});
