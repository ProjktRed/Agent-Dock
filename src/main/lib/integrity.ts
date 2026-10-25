import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Files a packaged app runs from outside app.asar (whose own integrity Electron checks): the engine and the
 * update swap script. The build writes their hashes into app.asar as engine-manifest.json; the app compares
 * the installed files with it before it loads or starts the engine.
 */
export const MANIFEST_ROOTS = ["engine/src", "engine/skills", "engine/ui", "engine/package.json", "engine/node_modules", "scripts/swap.mjs"];
/** Not packaged (package.json build filter) and never run: source maps and type declarations of the engine's dependencies. */
const NOT_PACKAGED = /\.(?:map|d\.[cm]?ts)$/i;
export const MANIFEST_FILE = "engine-manifest.json";

export type FileManifest = Record<string, string>;

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** sha256 of every file under the roots (paths relative to base, with forward slashes); missing roots are skipped. */
export function hashFiles(base: string, roots: string[] = MANIFEST_ROOTS): FileManifest {
  const out: FileManifest = {};
  const visit = (relative: string) => {
    const absolute = path.join(base, relative);
    let info;
    try { info = statSync(absolute); } catch { return; }
    if (info.isDirectory()) for (const name of readdirSync(absolute).sort()) visit(path.posix.join(relative, name));
    else if (info.isFile() && !NOT_PACKAGED.test(relative)) out[relative] = sha256(readFileSync(absolute));
  };
  for (const root of roots) visit(root);
  return out;
}

/** What differs from the manifest: changed, missing and added files. */
export function manifestProblems(expected: FileManifest, actual: FileManifest): string[] {
  const problems: string[] = [];
  for (const [file, hash] of Object.entries(expected)) {
    if (!(file in actual)) problems.push(`${file} is missing`);
    else if (actual[file] !== hash) problems.push(`${file} was changed`);
  }
  for (const file of Object.keys(actual)) if (!(file in expected)) problems.push(`${file} was added`);
  return problems;
}

/**
 * The watch during runs (every few seconds): everything but the engine's dependencies, whose ~550 files take
 * ~150 ms to hash. Those are checked with the rest before the engine is loaded or started.
 */
export const WATCH_ROOTS = MANIFEST_ROOTS.filter((root) => root !== "engine/node_modules");

/** Compares the installed engine (the files under roots) with the manifest the build put next to the main bundle. */
export function engineFileProblems(resourcesDir: string, manifestFile: string, roots: string[] = MANIFEST_ROOTS): string[] {
  let expected: FileManifest;
  try { expected = JSON.parse(readFileSync(manifestFile, "utf8")) as FileManifest; } catch { return ["the engine file list is missing from this build"]; }
  const under = (file: string) => roots.some((root) => file === root || file.startsWith(`${root}/`));
  return manifestProblems(Object.fromEntries(Object.entries(expected).filter(([file]) => under(file))), hashFiles(resourcesDir, roots));
}
