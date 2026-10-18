import type { RoleDraft } from "./api";

export const SECOND_OPINION_ROLE_ID = "second-opinion-qa";

/** Opt-in preset, run through the existing read-only gate workflow. */
export const SECOND_OPINION_TEMPLATE: RoleDraft & { blurb: string } = {
  id: SECOND_OPINION_ROLE_ID,
  name: "Second-opinion QA",
  description: "Independent acceptance review on another CLI before QA",
  blurb: "Checks acceptance on a different CLI using the engine's evidence",
  stage: "before-qa",
  gate: true,
  enabled: true,
  instructions: "Independently review the scoped diff against the task's acceptance criteria. Use the supplied engine test, build and scope evidence; do not rerun checks that already have trustworthy passing results. Read only the changed code and directly relevant callers when evidence is missing, conflicting or inconclusive. Return changes-needed only for concrete defects or unmet acceptance criteria, naming the file and symbol or line and the required correction. Never edit files, run writing commands or commit. QA owns final acceptance and the single task commit.",
};
