import { runNodeLoop } from "./recovery-loop.mjs";
export { loadElevateCase, computeElevateFingerprint, elevateAvailability } from "./elevate-case.mjs";

// Both triggers use identical persisted phases, schema, usage recovery and handoff.
export function runManualElevate(options) {
  return runNodeLoop({ ...options, manualElevation: true, stopAfterTask: true });
}
