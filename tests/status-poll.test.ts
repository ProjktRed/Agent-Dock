import { describe, expect, it } from "vitest";
import { skipPoll } from "../src/main/lib/status";

describe("status polling", () => {
  // Test report (0.38.1): a project that was not the active one, stopped with Stop now, showed "running" forever.
  it("polls a stopped project once more while its last status still shows it running", () => {
    expect(skipPoll({ active: false, alive: false, last: { processAlive: true } })).toBe(false);
    expect(skipPoll({ active: false, alive: false, last: { processAlive: false } })).toBe(true);
    expect(skipPoll({ active: false, alive: false, last: undefined })).toBe(false);
    expect(skipPoll({ active: false, alive: true, last: { processAlive: true } })).toBe(false);
    expect(skipPoll({ active: true, alive: false, last: { processAlive: false } })).toBe(false);
  });
});
