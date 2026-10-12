import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RoleStage, WorkflowRole } from "@shared/types";
import { parseSkillFile } from "./skills";

export const ROLE_STAGES: RoleStage[] = ["before-implementation", "before-qa", "after-pass"];

/** A folder-safe id from a role name ("Security reviewer" → "security-reviewer"). */
export function roleSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "role";
}

/** ROLE.md: frontmatter (name, description, stage, gate, enabled) + the role's instructions. */
export function parseRoleFile(text: string, id: string, dir: string): WorkflowRole {
  const parsed = parseSkillFile(text);
  const front: Record<string, string> = {};
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  for (const line of match?.[1].split(/\r?\n/) ?? []) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) front[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  const warnings: string[] = [];
  const stage = ROLE_STAGES.includes(front.stage as RoleStage) ? (front.stage as RoleStage) : "before-qa";
  if (!ROLE_STAGES.includes(front.stage as RoleStage)) warnings.push(`Unknown stage “${front.stage ?? ""}”; using before QA.`);
  if (!parsed.name) warnings.push("ROLE.md has no `name` in its frontmatter.");
  if (!parsed.body.trim()) warnings.push("ROLE.md has no instructions; the engine skips roles without instructions.");
  return {
    id,
    name: parsed.name ?? id,
    description: parsed.description,
    stage,
    gate: stage === "before-qa" && front.gate === "true",
    enabled: front.enabled !== "false",
    instructions: parsed.body.trim(),
    dir,
    warnings,
  };
}

const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

export function serializeRole(role: Pick<WorkflowRole, "name" | "description" | "stage" | "gate" | "enabled" | "instructions">): string {
  return [
    "---",
    `name: ${clean(role.name)}`,
    `description: ${clean(role.description)}`,
    `stage: ${role.stage}`,
    `gate: ${role.stage === "before-qa" && role.gate}`,
    `enabled: ${role.enabled}`,
    "---",
    "",
    role.instructions.trim(),
    "",
  ].join("\n");
}

/** User workflow roles, one folder per role holding ROLE.md, under <userData>/roles. */
export class RolesService {
  roles: WorkflowRole[] = [];

  constructor(readonly dir: string) {}

  async load(): Promise<WorkflowRole[]> {
    const found: WorkflowRole[] = [];
    try {
      for (const entry of await readdir(this.dir, { withFileTypes: true })) {
        const file = path.join(this.dir, entry.name, "ROLE.md");
        if (entry.isDirectory() && existsSync(file)) found.push(parseRoleFile(await readFile(file, "utf8"), entry.name, path.join(this.dir, entry.name)));
      }
    } catch {
      // no roles yet
    }
    this.roles = found.sort((a, b) => ROLE_STAGES.indexOf(a.stage) - ROLE_STAGES.indexOf(b.stage) || a.name.localeCompare(b.name));
    return this.roles;
  }

  /** Create (no id) or update a role. A new role's id comes from its name and never changes afterwards. */
  async save(role: Omit<WorkflowRole, "dir" | "warnings" | "id"> & { id?: string }): Promise<WorkflowRole[]> {
    if (!role.name.trim()) throw new Error("A role needs a name.");
    let id = role.id;
    if (!id) {
      const base = roleSlug(role.name);
      id = base;
      for (let n = 2; existsSync(path.join(this.dir, id)); n++) id = `${base}-${n}`;
    }
    if (!/^[\w-]{1,64}$/.test(id)) throw new Error("Invalid role id.");
    await mkdir(path.join(this.dir, id), { recursive: true });
    await writeFile(path.join(this.dir, id, "ROLE.md"), serializeRole(role));
    return this.load();
  }

  async remove(id: string): Promise<WorkflowRole[]> {
    if (!/^[\w-]{1,64}$/.test(id)) throw new Error("Invalid role id.");
    await rm(path.join(this.dir, id), { recursive: true, force: true });
    return this.load();
  }

  /** Copy a folder holding ROLE.md (or folders of them) into the roles folder. */
  async importFolder(source: string): Promise<{ roles: WorkflowRole[]; imported: number }> {
    const candidates = existsSync(path.join(source, "ROLE.md"))
      ? [source]
      : (await readdir(source, { withFileTypes: true })).filter((e) => e.isDirectory() && existsSync(path.join(source, e.name, "ROLE.md"))).map((e) => path.join(source, e.name));
    if (!candidates.length) throw new Error("No ROLE.md found in that folder or its subfolders.");
    for (const dir of candidates) {
      const parsed = parseRoleFile(await readFile(path.join(dir, "ROLE.md"), "utf8"), "", dir);
      const base = roleSlug(parsed.name || path.basename(dir));
      let id = base;
      for (let n = 2; existsSync(path.join(this.dir, id)); n++) id = `${base}-${n}`;
      await mkdir(this.dir, { recursive: true });
      await cp(dir, path.join(this.dir, id), { recursive: true });
    }
    return { roles: await this.load(), imported: candidates.length };
  }
}
