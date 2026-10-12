import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SkillInfo } from "@shared/types";

export function parseSkillFile(text: string): { name: string | null; description: string; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { name: null, description: "", body: text };
  const front: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) front[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { name: front.name ?? null, description: front.description ?? "", body: match[2] };
}

async function readSkill(dir: string, source: SkillInfo["source"]): Promise<SkillInfo | null> {
  const file = path.join(dir, "SKILL.md");
  if (!existsSync(file)) return null;
  const parsed = parseSkillFile(await readFile(file, "utf8"));
  const warnings: string[] = [];
  if (!parsed.name) warnings.push("SKILL.md has no `name` in its frontmatter.");
  if (!parsed.description) warnings.push("SKILL.md has no `description`.");
  return {
    id: `${source}:${parsed.name ?? path.basename(dir)}`,
    name: parsed.name ?? path.basename(dir),
    description: parsed.description,
    dir,
    source,
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
