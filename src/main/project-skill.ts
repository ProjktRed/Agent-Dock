import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectSkillInfo } from "@shared/types";
import { askWorkspace, type CallWords, type Fetch, type PlannerRun } from "./planner";
import { parseSkillFile, SKILL_MAX_CHARS } from "./skills";

/**
 * The project skill: a SKILL.md drafted from the workspace by a read-only agent, reviewed by you, and given to
 * the project's agents (every role) at each start. It lives in the project's state folder, so the repository
 * stays unchanged; a project that wants it versioned can copy it into its own skills folder.
 */
export const PROJECT_SKILL_DIR = "project-skill";
/** Leaves room for the role's other skills in the engine's per-role limit. */
export const PROJECT_SKILL_MAX_CHARS = 10_000;
const WORDS: CallWords = { who: "skill writer", cancelled: "Writing the skill was cancelled.", minutes: "The skill writer did not finish within 10 minutes." };

/** The engine roles that get it (keys of assigned-skills.json, engine/src/task-handoff-skill.mjs). */
export const PROJECT_SKILL_ROLES = ["implementation", "qa", "assessment", "resolver", "elevate"];

export const projectSkillFile =(stateDir: string) => path.join(stateDir, PROJECT_SKILL_DIR, "SKILL.md");

/** A skill name from the project name: lowercase letters, digits and hyphens. */
export function projectSkillName(projectName: string): string {
  const slug = projectName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `project-${slug || "workspace"}`;
}

export function buildSkillPrompt(projectName: string, summary: string | null): string {
  const name = projectSkillName(projectName);
  return [
    `Write a SKILL.md for the agents that work on the project "${projectName}": an implementation worker, a QA reviewer and an assessor that plans one small task at a time.`,
    summary
      ? "The workspace was summarised for you below: its file list, manifests and the start of its most relevant source files. Use only what it shows."
      : "Inspect the workspace (read-only) first: manifests, README, build and test configuration, the main source folders and a few representative files. Do not edit, create or delete any file.",
    "",
    "The skill gives them what they cannot see at a glance and would otherwise get wrong. Only facts you checked in the workspace; name real files, commands and folders. No generic advice that fits any project.",
    "",
    "Output only the file, nothing before or after it, in exactly this shape:",
    "---",
    `name: ${name}`,
    `description: <one sentence: what this project is and when this skill applies>`,
    "---",
    "",
    `# ${projectName}`,
    "## Layout: the main folders and what lives where, entry points.",
    "## Commands: install, build, run, test, lint and typecheck, exactly as the project defines them (scripts, Makefile, CI), and which to run before a change is done.",
    "## Conventions: language and framework versions, code style the code actually follows, naming, how tests are written and where they go, error handling, imports.",
    "## Boundaries: generated, vendored or protected files not to edit by hand; secrets and config to leave alone.",
    "## Pitfalls: anything surprising you found (platform quirks, slow or flaky tests, ordering, required environment).",
    "",
    `Keep it under ${Math.round(PROJECT_SKILL_MAX_CHARS * 0.8).toLocaleString("en-US")} characters. Bullets, not prose. Leave out a section with nothing project-specific to say.`,
    ...(summary ? ["", "Workspace summary:", summary] : []),
  ].join("\n");
}

/** Strips code fences and chatter around the file, sets the expected name, and caps the length. */
export function cleanSkillText(raw: string, projectName: string): string {
  let text = String(raw).replace(/\r\n/g, "\n").trim();
  const fenced = text.match(/```(?:markdown|md)?\n(---\n[\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("---\n");
  if (start > 0) text = text.slice(start);
  const parsed = parseSkillFile(text);
  if (parsed.name !== null) text = text.replace(/^(---\n[\s\S]*?)^name:.*$/m, `$1name: ${projectSkillName(projectName)}`);
  return text.slice(0, PROJECT_SKILL_MAX_CHARS).trimEnd() + "\n";
}

/** Null when the engine can use the text as a skill; otherwise why not. */
export function skillTextProblem(text: string): string | null {
  const parsed = parseSkillFile(text);
  if (!parsed.name) return "The skill needs a front matter block with a name (--- name: … ---).";
  if (!parsed.description.trim()) return "The skill needs a description in its front matter.";
  if (!parsed.body.trim()) return "The skill has no instructions after its front matter.";
  if (text.length > PROJECT_SKILL_MAX_CHARS) return `The skill is longer than ${PROJECT_SKILL_MAX_CHARS.toLocaleString("en-US")} characters; shorten it.`;
  return null;
}

/** Drafts the skill; one retry with the problem when the first answer is not a usable skill. */
export async function generateProjectSkill(workspace: string, projectName: string, planner: PlannerRun, signal: AbortSignal, fetchImpl?: Fetch): Promise<string> {
  if (signal.aborted) throw new Error(WORDS.cancelled);
  const ask = (feedback: string) => askWorkspace(workspace, (summary) => buildSkillPrompt(projectName, summary) + feedback, planner, signal, { fetchImpl, words: WORDS });
  let text = cleanSkillText(await ask(""), projectName);
  const problem = skillTextProblem(text);
  if (problem) {
    text = cleanSkillText(await ask(`\n\nYour previous answer could not be used: ${problem} Answer again with only the file in the exact shape above.`), projectName);
    const again = skillTextProblem(text);
    if (again) throw new Error(`The skill writer's answer is not a usable skill: ${again}`);
  }
  return text;
}

export async function readProjectSkill(stateDir: string, enabled: boolean): Promise<ProjectSkillInfo> {
  const file = projectSkillFile(stateDir);
  const text = existsSync(file) ? await readFile(file, "utf8").catch(() => null) : null;
  return { text, path: file, enabled: enabled && text !== null };
}

/** Saves reviewed text (null removes the skill). */
export async function saveProjectSkill(stateDir: string, text: string | null): Promise<void> {
  const file = projectSkillFile(stateDir);
  if (text === null) return rm(path.dirname(file), { recursive: true, force: true });
  const clean = String(text).replace(/\r\n/g, "\n").trimEnd() + "\n";
  const problem = skillTextProblem(clean);
  if (problem) throw new Error(problem);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, clean);
}

/** What the engine receives: the skill's name and instructions, or null when it is off, missing or unusable. */
export async function projectSkillDelivery(stateDir: string, enabled: boolean): Promise<{ name: string; instructions: string } | null> {
  if (!enabled) return null;
  const text = await readFile(projectSkillFile(stateDir), "utf8").catch(() => null);
  if (!text || skillTextProblem(text)) return null;
  const parsed = parseSkillFile(text);
  return parsed.body.trim().length <= SKILL_MAX_CHARS ? { name: parsed.name!, instructions: parsed.body.trim() } : null;
}
