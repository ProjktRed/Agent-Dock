import path from "node:path";
import { realWithin } from "./real-path";

/** Files the renderer may open with their default app; anything else (.exe, .bat, .lnk, ...) is refused. */
const OPENABLE_FILES = new Set([".md", ".txt", ".json", ".log"]);

/**
 * Whether `shell:open` may open `target`: a folder or a plain document under one of the app's
 * known folders (projects, their state, skills, roles). `shell.openPath` runs executables, so the
 * renderer must never be able to hand it an arbitrary path.
 */
export function canOpenPath(target: unknown, roots: string[], isDirectory: boolean): boolean {
  if (typeof target !== "string" || !target.trim()) return false;
  const resolved = path.resolve(target);
  // Real locations too: a link inside a known folder may point anywhere.
  if (!roots.some((root) => root && realWithin(root, resolved))) return false;
  return isDirectory || OPENABLE_FILES.has(path.extname(resolved).toLowerCase());
}

/** Links leaving the app go to the browser only when they are web links. */
export function isExternalWebUrl(url: string): boolean {
  try {
    return ["https:", "http:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
