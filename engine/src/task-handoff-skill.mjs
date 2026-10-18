import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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
// "auto:implementation" holds the implementation skills used only when relevant: Assessment sees their
// names and descriptions and picks them per task with a "Skills:" line in the task prompt.
const SKILL_CHARS = 16_000, ROLE_CHARS = 40_000, AUTO_SKILLS = 150, AUTO_PICK = 3, DESCRIPTION_CHARS = 250;
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
  if (value.auto !== undefined) {
    const pool = value.auto?.implementation ?? [];
    if (!value.auto || typeof value.auto !== "object" || Object.keys(value.auto).some((k) => k !== "implementation") || !Array.isArray(pool)) throw new Error("Skills file: auto must be {implementation:[...]}");
    if (pool.length > AUTO_SKILLS) throw new Error(`Skills file: at most ${AUTO_SKILLS} automatic skills`);
    // The index: name, description and folder. Text is read only when a task picks the skill
    // (inline instructions are accepted too, for tests and small catalogs).
    roles["auto:implementation"] = pool.map((skill) => {
      if (typeof skill?.name !== "string" || !/^[\w .:-]{1,80}$/.test(skill.name)) throw new Error("Skills file: automatic skill has an invalid name");
      if (typeof skill.description !== "string" || !skill.description.trim()) throw new Error(`Skills file: automatic skill ${skill.name} needs a description`);
      const inline = typeof skill.instructions === "string" && skill.instructions.trim();
      if (inline && skill.instructions.length > SKILL_CHARS) throw new Error(`Skills file: automatic skill ${skill.name} is over ${SKILL_CHARS} characters`);
      if (!inline && !(typeof skill.dir === "string" && path.isAbsolute(skill.dir))) throw new Error(`Skills file: automatic skill ${skill.name} needs its folder or instructions`);
      return { name: skill.name, description: skill.description.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_CHARS), ...(inline ? { instructions: skill.instructions.trim() } : { dir: skill.dir }) };
    });
  }
  return roles;
}

export function useAssignedSkills(roles) { assigned = roles ?? {}; loaded.clear(); }

export function readAssignedSkills(file) {
  if (!file) return {};
  return parseAssignedSkills(JSON.parse(readFileSync(file, "utf8")));
}

export function assignedSkillsText(role) {
  return skillsBlock(assigned[role] ?? []);
}

/** Assessment's view of the automatic skills: names and descriptions only. */
export function autoSkillCatalogText() {
  const pool = assigned["auto:implementation"] ?? [];
  if (!pool.length) return "";
  return ["", `Skills available to the implementation worker when relevant. If one or more clearly apply to the task you choose, add one line to the task prompt: "Skills: <name>, <name>" (exact names, at most ${AUTO_PICK}). Leave the line out when none apply.`,
    ...pool.map((skill) => `- ${skill.name}: ${skill.description}`)].join("\n");
}

/** Automatic skills Assessment named in the task's "Skills:" line; unknown names are ignored. */
export function selectedAutoSkills(task) {
  const pool = assigned["auto:implementation"] ?? [];
  const line = String(task?.prompt ?? "").match(/^Skills:[ \t]*(.+)$/im)?.[1] ?? "";
  const names = [...new Set(line.split(",").map((n) => n.trim().replace(/[.;]$/, "")).filter(Boolean))];
  return names.map((name) => pool.find((skill) => skill.name.toLowerCase() === name.toLowerCase())).filter(Boolean).slice(0, AUTO_PICK);
}

const loaded = new Map();
/**
 * A picked skill's text: SKILL.md without frontmatter, plus its other Markdown files when everything fits the
 * per-skill limit (as the app delivers assigned skills). Null when the folder is gone or SKILL.md is too long.
 */
export function loadSkillText(skill) {
  if (skill.instructions) return skill.instructions;
  if (loaded.has(skill.dir)) return loaded.get(skill.dir);
  let text = null;
  try {
    const body = readFileSync(path.join(skill.dir, "SKILL.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    if (body && body.length <= SKILL_CHARS) {
      const extras = [];
      const walk = (dir, rel) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
          else if (entry.isFile() && /\.md$/i.test(entry.name) && relPath !== "SKILL.md") extras.push(relPath);
        }
      };
      walk(skill.dir, "");
      let full = body;
      for (const rel of extras.sort()) full += `\n\n### File: ${rel}\n${readFileSync(path.join(skill.dir, rel), "utf8").trim()}`;
      text = full.length <= SKILL_CHARS ? full : body;
    }
  } catch {
    text = null;
  }
  loaded.set(skill.dir, text);
  return text;
}

/** Always-assigned implementation skills plus this task's selected ones, within the per-role limit. */
export function implementationSkills(task) {
  const skills = [...(assigned.implementation ?? [])];
  let total = skills.reduce((sum, skill) => sum + skill.instructions.length, 0);
  for (const skill of selectedAutoSkills(task)) {
    if (skills.some((s) => s.name === skill.name)) continue;
    const instructions = loadSkillText(skill);
    if (!instructions || total + instructions.length > ROLE_CHARS) continue;
    skills.push({ name: skill.name, instructions });
    total += instructions.length;
  }
  return skills;
}

function skillsBlock(skills) {
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
  return `${shared}\n\nSelected task skill: ${mode}\n${reference}${skillsBlock(implementationSkills(task))}`;
}
