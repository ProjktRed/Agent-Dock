/**
 * live.json stage names. Four used to name the CLI they were written for; state saved by older
 * versions is read with the current names.
 */
export const LEGACY_STAGES = Object.freeze({
  "cline-working": "implementing",
  "cline-complete": "implemented",
  "codex-qa": "qa",
  WAITING_FOR_CODEX: "WAITING_FOR_LIMIT",
});

export const currentStage = (stage) => LEGACY_STAGES[stage] ?? stage;
