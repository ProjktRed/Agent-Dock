import { readFile } from "node:fs/promises";
import { managerHandoffSkill } from "./task-handoff-skill.mjs";
import { REASONING_EFFORTS } from "./loop-options.mjs";
import { READ_ONLY_SANDBOX } from "./codex-worker.mjs";

// User-defined workflow roles (--roles-file). Every role is read-only: it never edits files,
// commits or changes HEAD, so scope/HEAD verification and QA's single commit stay intact.
export const ROLE_STAGES = ["before-implementation", "before-qa", "after-pass"];
const STAGE_PURPOSE = {
  "before-implementation": "You run once per task before the implementation worker starts. Give the implementer concise, concrete guidance for this task in `guidance`.",
  "before-qa": "You review the worker's change after it finishes and before independent QA. Report concrete problems in `findings`; QA and Assessment read them.",
  "after-pass": "The task passed QA and was committed. Write a short report in `summary` (and `findings` if useful). Nothing you return changes the result.",
};

export const roleOutputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "changes-needed"] },
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    guidance: { type: "string" },
  },
  required: ["verdict", "summary", "findings", "guidance"],
};

export function parseRoleResult(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed role result");
  if (!roleOutputSchema.properties.verdict.enum.includes(value.verdict)) throw new Error("Malformed role result: verdict");
  if (typeof value.summary !== "string" || typeof value.guidance !== "string") throw new Error("Malformed role result: text fields");
  if (!Array.isArray(value.findings) || value.findings.some((f) => typeof f !== "string")) throw new Error("Malformed role result: findings");
  return { verdict: value.verdict, summary: value.summary, findings: value.findings, guidance: value.guidance };
}

/** Validate the roles file contents; disabled roles are dropped. */
export function parseRoles(value) {
  if (!Array.isArray(value)) throw new Error("Roles file must contain a JSON array");
  const seen = new Set();
  return value.filter((role) => role?.enabled !== false).map((role, index) => {
    const where = `Role ${index + 1}${role?.name ? ` (${role.name})` : ""}`;
    if (!role || typeof role !== "object") throw new Error(`${where}: expected an object`);
    if (typeof role.id !== "string" || !/^[\w-]{1,64}$/.test(role.id)) throw new Error(`${where}: id must be 1-64 letters, digits, _ or -`);
    if (seen.has(role.id)) throw new Error(`${where}: duplicate id ${role.id}`);
    seen.add(role.id);
    if (typeof role.name !== "string" || !role.name.trim()) throw new Error(`${where}: name is required`);
    if (!ROLE_STAGES.includes(role.stage)) throw new Error(`${where}: stage must be one of ${ROLE_STAGES.join(", ")}`);
    if (!["codex", "claude"].includes(role.cli)) throw new Error(`${where}: cli must be codex or claude`);
    if (typeof role.instructions !== "string" || !role.instructions.trim()) throw new Error(`${where}: instructions are required`);
    if (role.model !== undefined && role.model !== "" && !/^[\w.:\[\]-]+$/.test(role.model)) throw new Error(`${where}: invalid model identifier`);
    if (role.effort !== undefined && role.effort !== "" && !REASONING_EFFORTS.includes(role.effort)) throw new Error(`${where}: invalid effort`);
    return {
      id: role.id,
      name: role.name.trim(),
      stage: role.stage,
      // Only a review before QA can hold the change back.
      gate: role.stage === "before-qa" && role.gate === true,
      cli: role.cli,
      model: role.model || null,
      effort: role.effort || null,
      fast: role.fast === true,
      instructions: role.instructions.trim(),
    };
  });
}

export async function readRolesFile(file) {
  if (!file) return [];
  return parseRoles(JSON.parse(await readFile(file, "utf8")));
}

export function buildRolePrompt(role, input) {
  return [
    `You are ${role.name}, a custom workflow role in a bounded automation loop (stage: ${role.stage}).`,
    managerHandoffSkill(),
    STAGE_PURPOSE[role.stage],
    "You are read-only: do not edit, create, move or delete files, stage, commit, change HEAD or git configuration, launch workers, or choose tasks. Read only what INPUT and the task need.",
    READ_ONLY_SANDBOX,
    role.gate
      ? "Return changes-needed only for concrete, verifiable problems the implementer can fix inside the task's allowedPaths; the change then goes back for correction instead of to QA. Otherwise return pass."
      : "Your verdict is advisory and never blocks the loop.",
    "Keep guidance under 1200 characters. Findings: one concrete item each, naming the file and symbol or line.",
    "Role instructions from the user:",
    role.instructions,
    "Return JSON and exit completely.",
    "INPUT: " + JSON.stringify(input),
  ].join("\n");
}

/** Runs roles on the orchestrator workers ({ codex, claude }), sharing their single lock. */
export function createRoleRunner(workers) {
  return (role, input) => {
    const worker = workers[role.cli];
    if (!worker) throw new Error(`Workflow role ${role.name} needs ${role.cli === "claude" ? "Claude Code" : "Codex"}, which is not configured`);
    return worker.invoke(buildRolePrompt(role, input), "read-only", {
      ...(role.model ? { model: role.model } : {}),
      ...(role.effort ? { reasoningEffort: role.effort } : {}),
      ...(role.fast ? { fast: true } : {}),
      schema: roleOutputSchema,
      parse: parseRoleResult,
    });
  };
}

/** Guidance appended to the implementation prompt (advisory; never overrides scope or QA). */
export function roleGuidanceText(results) {
  const lines = results.filter((r) => r.result?.guidance?.trim()).map((r) => `- ${r.name}: ${r.result.guidance.trim()}`);
  if (!lines.length) return "";
  return ["Guidance from workflow roles (advisory; the task, allowed paths and QA command above take precedence):", ...lines].join("\n");
}

export function gateFailureText(entry) {
  return [`Workflow role ${entry.name} requested changes before QA.`, entry.result.summary, ...entry.result.findings.map((f) => `- ${f}`)].filter(Boolean).join("\n");
}
