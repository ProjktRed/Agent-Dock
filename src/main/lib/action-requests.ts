import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActionRequest } from "@shared/types";

/**
 * Ask instead of refuse (engine guard/ask.mjs): a Codex or Claude Code hook waiting on an action the guard could
 * not verify writes <state>/approvals/<id>.request.json and polls for <id>.decision.json, which only the app
 * writes. The state folder is protected from agents and the id (128 random bits) never reaches them.
 */
const ID = /^[0-9a-f]{32}$/;
export const approvalsDir = (stateDir: string) => path.join(stateDir, "approvals");

/** Unanswered, unexpired requests, oldest first (at most 20). */
export async function readActionRequests(stateDir: string, now = Date.now()): Promise<ActionRequest[]> {
  const dir = approvalsDir(stateDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: ActionRequest[] = [];
  for (const name of names) {
    const id = name.replace(/\.request\.json$/, "");
    if (id === name || !ID.test(id) || names.includes(`${id}.decision.json`) || names.includes(`${id}.done.json`)) continue;
    const r = await readFile(path.join(dir, name), "utf8").then((t) => JSON.parse(t) as ActionRequest, () => null);
    if (!r || r.id !== id || !(Date.parse(r.expiresAt) > now)) continue;
    out.push({ id, cli: String(r.cli ?? "Agent"), tool: r.tool ? String(r.tool) : null, text: String(r.text ?? "").slice(0, 2000), reason: String(r.reason ?? "").slice(0, 500), cwd: String(r.cwd ?? ""), taskId: r.taskId ? String(r.taskId) : null, createdAt: String(r.createdAt), expiresAt: String(r.expiresAt) });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 20);
}

/** Answers a request once: false when it is gone, expired or already answered. remember: allowed for the rest of the run. */
export async function decideActionRequest(stateDir: string, id: string, decision: "allow" | "deny", by: string, remember = false): Promise<boolean> {
  if (!ID.test(id)) return false;
  if (!(await readActionRequests(stateDir)).some((r) => r.id === id)) return false;
  // Created exclusively: the first answer (dialog or Telegram) wins; a later one finds the file and changes nothing.
  try {
    await writeFile(path.join(approvalsDir(stateDir), `${id}.decision.json`), JSON.stringify({ id, decision, by, at: new Date().toISOString(), ...(decision === "allow" && remember ? { remember: true } : {}) }), { mode: 0o600, flag: "wx" });
    return true;
  } catch { return false; }
}
