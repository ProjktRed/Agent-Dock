import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SkillInfo } from "@shared/types";

/** Engine limits for assigned skills (engine/src/task-handoff-skill.mjs). */
export const SKILL_MAX_CHARS = 16_000;
export const ROLE_SKILLS_MAX_CHARS = 40_000;
export const AUTO_INDEX_MAX = 150;

export function parseSkillFile(text: string): { name: string | null; description: string; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { name: null, description: "", body: text };
  const front: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const raw = kv[2].trim();
    // YAML quoted scalars: "..." may escape quotes and backslashes; '...' doubles single quotes.
    front[kv[1]] = /^".*"$/.test(raw) ? raw.slice(1, -1).replace(/\\(["\\])/g, "$1") : /^'.*'$/.test(raw) ? raw.slice(1, -1).replace(/''/g, "'") : raw;
  }
  return { name: front.name ?? null, description: front.description ?? "", body: match[2] };
}

// Parsed skills by SKILL.md path; re-read only when the file's size or modification time changes.
const cache = new Map<string, { mtimeMs: number; size: number; source: SkillInfo["source"]; info: SkillInfo }>();

async function readSkill(dir: string, source: SkillInfo["source"]): Promise<SkillInfo | null> {
  const file = path.join(dir, "SKILL.md");
  if (!existsSync(file)) return null;
  const { mtimeMs, size } = await stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size && hit.source === source) return hit.info;
  const info = await parseSkill(dir, file, source);
  cache.set(file, { mtimeMs, size, source, info });
  return info;
}

async function parseSkill(dir: string, file: string, source: SkillInfo["source"]): Promise<SkillInfo> {
  const parsed = parseSkillFile(await readFile(file, "utf8"));
  const warnings: string[] = [];
  if (!parsed.name) warnings.push("SKILL.md has no `name` in its frontmatter.");
  if (!parsed.description) warnings.push("SKILL.md has no `description`.");
  let origin: string | undefined;
  try {
    const source = JSON.parse(await readFile(path.join(dir, "agent-dock-source.json"), "utf8"));
    if (typeof source.owner === "string" && typeof source.repo === "string" && typeof source.commit === "string") origin = `${source.owner}/${source.repo}@${source.commit.slice(0, 7)}`;
  } catch {
    // imported from a local folder
  }
  return {
    id: `${source}:${parsed.name ?? path.basename(dir)}`,
    name: parsed.name ?? path.basename(dir),
    description: parsed.description,
    dir,
    source,
    ...(origin ? { origin } : {}),
    instructions: parsed.body.trim(),
    warnings,
  };
}

/** Engine-bundled skills plus any folders the user imported (each holding SKILL.md, or folders of them). */
export async function listSkills(engineDir: string, importedDirs: string[]): Promise<SkillInfo[]> {
  const found: SkillInfo[] = [];
  const scan = async (root: string, source: SkillInfo["source"]) => {
    const direct = await readSkill(root, source);
    if (direct) return found.push(direct);
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skill = await readSkill(path.join(root, entry.name), source);
          if (skill) found.push(skill);
        }
      }
    } catch {
      // missing folder
    }
  };
  await scan(path.join(engineDir, "skills"), "engine");
  for (const dir of importedDirs) await scan(dir, "imported");
  return found;
}

/**
 * What the engine receives for a skill: its SKILL.md instructions plus its other Markdown files
 * (references), when everything fits the per-skill limit. Otherwise only SKILL.md.
 */
export async function skillDeliveryText(skill: SkillInfo): Promise<{ text: string; referencesLeftOut: boolean }> {
  const extras: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath);
      else if (entry.isFile() && /.md$/i.test(entry.name) && relPath !== "SKILL.md") extras.push(relPath);
    }
  };
  await walk(skill.dir, "");
  if (!extras.length) return { text: skill.instructions, referencesLeftOut: false };
  let text = skill.instructions;
  for (const rel of extras.sort()) text += `

### File: ${rel}
${(await readFile(path.join(skill.dir, rel), "utf8")).trim()}`;
  return text.length <= SKILL_MAX_CHARS ? { text, referencesLeftOut: false } : { text: skill.instructions, referencesLeftOut: true };
}
