import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * The real location of a path: links and junctions resolved, and a missing tail resolved from its
 * closest existing parent. Containment checks compare these, never the text a caller gave.
 */
export function realPath(target: string): string {
  const absolute = path.resolve(target);
  for (let ancestor = absolute; ; ancestor = path.dirname(ancestor)) {
    try {
      return path.resolve(realpathSync.native(ancestor), path.relative(ancestor, absolute));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ENOTDIR") || path.dirname(ancestor) === ancestor) return absolute;
    }
  }
}

export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Whether target is root or inside it, both by their text and by their real locations. */
export function realWithin(root: string, target: string): boolean {
  return within(path.resolve(root), path.resolve(target)) && within(realPath(root), realPath(target));
}
