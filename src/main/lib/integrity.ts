import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Files a packaged app runs from outside app.asar (whose own integrity Electron checks): the engine and the
 * update swap script. The build writes their hashes into app.asar as engine-manifest.json; the app compares
 * the installed files with it before it loads or starts the engine.
 */
export const MANIFEST_ROOTS = ["engine/src", "engine/skills", "engine/ui", "engine/package.json", "scripts/swap.mjs"];
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
    else if (info.isFile()) out[relative] = sha256(readFileSync(absolute));
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

/** Compares the installed engine with the manifest the build put next to the main bundle. */
export function engineFileProblems(resourcesDir: string, manifestFile: string): string[] {
  let expected: FileManifest;
  try { expected = JSON.parse(readFileSync(manifestFile, "utf8")) as FileManifest; } catch { return ["the engine file list is missing from this build"]; }
  return manifestProblems(expected, hashFiles(resourcesDir));
}
