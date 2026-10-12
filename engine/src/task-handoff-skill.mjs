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

export function managerHandoffSkill() {
  return shared;
}

export function clineHandoffSkill(task, correction = "") {
  const mode = taskSkillMode(task, correction);
  const reference = readFileSync(new URL(`references/${mode}.md`, root), "utf8");
  return `${shared}\n\nSelected task skill: ${mode}\n${reference}`;
}
