import { readFileSync } from "node:fs";

const root = new URL("../skills/bounded-task-handoff/", import.meta.url);
const shared = readFileSync(new URL("SKILL.md", root), "utf8");
const modes = new Set(["diagnose", "implement", "verify"]);

export function taskSkillMode(task, correction = "", { required = false } = {}) {
  const selected = (text) => String(text ?? "").match(/^Task skill:[ \t]*(\S+)/im)?.[1]?.replace(/[.;:]$/, "").toLowerCase();
  const choice = selected(correction) ?? selected(task.prompt ?? task.objective);
  if (required && !choice) throw new Error("Task skill selection is required in the Codex task prompt");
  const mode = choice ?? "implement";
  if (!modes.has(mode)) throw new Error(`Unknown task skill: ${mode}`);
  return mode;
}

// Skills the user assigned to each role in the app (--skills-file). Keys: implementation, assessment,
// resolver, qa, elevate, and role:<id> for workflow roles. Only SKILL.md instructions are delivered.
const SKILL_CHARS = 16_000, ROLE_CHARS = 40_000;
let assigned = {};

export function parseAssignedSkills(value) {
  if (!value || typeof value !== "object" || value.version !== 1 || !value.roles || typeof value.roles !== "object") throw new Error("Skills file must be {version:1, roles:{...}}");
  const roles = {};
  for (const [key, skills] of Object.entries(value.roles)) {
    if (!/^(?:implementation|assessment|resolver|qa|elevate|role:[\w-]{1,64})$/.test(key)) throw new Error(`Skills file: unknown role ${key}`);
    if (!Array.isArray(skills)) throw new Error(`Skills file: ${key} must be a list`);
    let total = 0;
    roles[key] = skills.map((skill) => {
      if (typeof skill?.name !== "string" || !/^[\w .:-]{1,80}$/.test(skill.name)) throw new Error(`Skills file: ${key} has an invalid skill name`);
      if (typeof skill.instructions !== "string" || !skill.instructions.trim()) throw new Error(`Skills file: skill ${skill.name} has no instructions`);
      if (skill.instructions.length > SKILL_CHARS) throw new Error(`Skills file: skill ${skill.name} is over ${SKILL_CHARS} characters`);
      total += skill.instructions.length;
      if (total > ROLE_CHARS) throw new Error(`Skills file: skills for ${key} are over ${ROLE_CHARS} characters in total`);
      return { name: skill.name, instructions: skill.instructions.trim() };
    });
  }
  return roles;
}

export function useAssignedSkills(roles) { assigned = roles ?? {}; }

export function readAssignedSkills(file) {
  if (!file) return {};
  return parseAssignedSkills(JSON.parse(readFileSync(file, "utf8")));
}

export function assignedSkillsText(role) {
  const skills = assigned[role] ?? [];
  if (!skills.length) return "";
  return ["", "Assigned skills (chosen by the user for this role). Follow them where they apply; the task scope, allowed paths, guard rules and required output format above take precedence.",
    ...skills.map((skill) => `\n## Skill: ${skill.name}\n${skill.instructions}`)].join("\n");
}

export function managerHandoffSkill(role) {
  return role ? shared + assignedSkillsText(role) : shared;
}

export function clineHandoffSkill(task, correction = "") {
  const mode = taskSkillMode(task, correction);
  const reference = readFileSync(new URL(`references/${mode}.md`, root), "utf8");
  return `${shared}\n\nSelected task skill: ${mode}\n${reference}${assignedSkillsText("implementation")}`;
}
