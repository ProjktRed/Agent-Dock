import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PlanPhase, PlanProgress } from "@shared/types";

export const PLAN_FILE = "IMPLEMENTATION_PLAN.md";

/**
 * Same format the engine reads (engine/src/implementation-progress.mjs):
 * `## Phase N — Title` headings followed by `- [ ]` / `- [x]` checkboxes; indentation gives depth.
 */
export function parseImplementationPlan(text: string, task: { id?: string; phase?: number } = {}): PlanProgress {
  const phases: PlanPhase[] = [];
  let phase: PlanPhase | null = null;
  for (const line of String(text).split(/\r?\n/)) {
    const heading = line.match(/^##\s+Phase\s+(\d+)(?:\s*(?:—|-|:)\s*(.*))?$/i);
    if (heading) {
      phase = { number: Number(heading[1]), title: heading[2]?.trim() || `Phase ${heading[1]}`, tasks: [], total: 0, completed: 0, percent: null };
      phases.push(phase);
      continue;
    }
    if (/^##\s/.test(line)) {
      phase = null;
      continue;
    }
    const item = line.match(/^(\s*)-\s+\[([ xX])\]\s+(.+)$/);
    if (phase && item) phase.tasks.push({ title: item[3].trim(), completed: item[2].toLowerCase() === "x", depth: Math.floor(item[1].length / 2) });
  }
  for (const p of phases) {
    p.total = p.tasks.length;
    p.completed = p.tasks.filter((t) => t.completed).length;
    p.percent = p.total ? Math.round((100 * p.completed) / p.total) : null;
  }
  const total = phases.reduce((n, p) => n + p.total, 0);
  const completed = phases.reduce((n, p) => n + p.completed, 0);
  const selected = task.phase != null ? Number(task.phase) : Number(task.id?.match(/^P(\d+)[-]/i)?.[1]);
  const currentPhase = phases.some((p) => p.number === selected) ? selected : phases.find((p) => p.completed < p.total)?.number ?? null;
  return { source: PLAN_FILE, phases, total, completed, percent: total ? Math.round((100 * completed) / total) : null, currentPhase };
}

export async function readPlan(workspace: string, task: { id?: string } = {}): Promise<PlanProgress> {
  try {
    return parseImplementationPlan(await readFile(path.join(workspace, PLAN_FILE), "utf8"), task);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ...parseImplementationPlan("", task), error: code === "ENOENT" ? "No IMPLEMENTATION_PLAN.md in this workspace" : "Implementation plan unreadable" };
  }
}

export const STARTER_PLAN = `# Implementation plan

Each phase is a \`## Phase N — Title\` heading. The automation reads the checkboxes below
to show progress; Assessment marks tasks done as they are approved.

## Phase 1 — Foundations
- [ ] Describe the first bounded task
- [ ] Describe the second bounded task
`;
