import path from "node:path";
import { atomicWriteJson } from "./dashboard-state.mjs";

// Every task the loop starts is kept as <state>/tasks/<id>.json, so the app can run one again later
// (Task history › Run again). Only the task's own definition is saved, never recovery state.
const FIELDS = ["id", "name", "prompt", "allowedPaths", "qaCommand", "planItems", "skills"];

/** The file name for a task id: letters, digits, dot, dash and underscore only. */
export const taskFileName = (id) => `${String(id).replace(/[^\w.-]+/g, "_").slice(0, 120)}.json`;

export async function saveTaskDefinition(stateDir, task) {
  if (!task?.id || !task.prompt || !Array.isArray(task.allowedPaths)) return null;
  const saved = Object.fromEntries(FIELDS.filter((key) => task[key] !== undefined).map((key) => [key, task[key]]));
  const file = path.join(stateDir, "tasks", taskFileName(task.id));
  await atomicWriteJson(file, { ...saved, savedAt: new Date().toISOString() }).catch(() => {});
  return file;
}
