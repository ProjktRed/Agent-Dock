import type { RoleStage } from "@shared/types";

/** Where a workflow role runs in the cycle. */
export const STAGES: { value: RoleStage; label: string; desc: string }[] = [
  { value: "before-implementation", label: "Before implementation", desc: "Runs once per task before the worker starts. Its guidance is added to every implementation prompt for that task." },
  { value: "before-qa", label: "Before QA", desc: "Reviews each finished attempt before QA. QA and Assessment read its findings; as a gate it can send the change back for correction." },
  { value: "after-pass", label: "After QA passes", desc: "Runs after the task is committed. Writes a report (role-reports.ndjson in the project's state folder); never changes the result." },
];
export const stageLabel = (stage: RoleStage) => STAGES.find((s) => s.value === stage)?.label ?? stage;
