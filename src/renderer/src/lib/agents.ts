import type { Agent, Project, Role } from "@shared/types";

/** Renderer copy of the main-process rule (src/main/lib/engine-args.ts agentForRole). */
export function agentForRoleClient(role: Exclude<Role, "custom">, project: Project | null, agents: Agent[]): Agent | null {
  const overrideId = project?.roleOverrides[role];
  if (overrideId) {
    const chosen = agents.find((a) => a.id === overrideId);
    if (chosen) return chosen;
  }
  return agents.find((a) => a.role === role && a.enabled) ?? null;
}
