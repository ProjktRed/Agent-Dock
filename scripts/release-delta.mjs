// Smaller updates (0.33). The release workflow describes every file of the Windows build in a file
// index, and, when the previous release published its index, collects the files that changed into a
// folder that becomes the delta zip:
//
//   release-delta.mjs index --dir dist/win-unpacked --out AgentDock-<v>-win-x64.files.json
//   release-delta.mjs changed --dir dist/win-unpacked --index <new.files.json> --previous <old.files.json> --out delta/
//                            [--previous-dir <the previous release, unpacked>]
//
// With --previous-dir (0.35), a changed file of at least 1 MB that also exists in the previous release
// goes into the delta as a binary patch (__adpatch/<path>, src/shared/block-patch.ts) when the patch is
// under half the file's size; the app checks the patched file against the signed index like any other.
//
// sign-release.mjs then signs both into the manifest (index and delta: file, sha256, size). The app
// uses the delta only when it runs exactly the delta's base version, rebuilds the new version from
// its own files plus the changed ones, and installs it only if every file matches the signed index.
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePatch } from "../src/shared/block-patch.ts";

export const PATCH_DIR = "__adpatch";
const PATCH_MIN_BYTES = 1024 * 1024;

/** Copies each changed file into `out`, or a binary patch against `previousDir` when that is much smaller. */
export function collectChanged(changed, dir, out, previousDir) {
  const summary = { copied: 0, patched: 0, bytes: 0 };
  for (const rel of changed) {
    const file = path.join(dir, rel), old = previousDir ? path.join(previousDir, rel) : null;
    if (old && existsSync(old) && statSync(file).size >= PATCH_MIN_BYTES) {
      const patch = makePatch(readFileSync(old), readFileSync(file));
      if (patch.length < statSync(file).size / 2) {
        const target = path.join(out, PATCH_DIR, rel);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, patch);
        summary.patched++; summary.bytes += patch.length;
        continue;
      }
    }
    mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    copyFileSync(file, path.join(out, rel));
    summary.copied++; summary.bytes += statSync(file).size;
  }
  return summary;
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Every file under `dir` (forward-slash relative paths, sorted) with its SHA-256 and size. */
export async function buildIndex(dir) {
  const files = [];
  const walk = async (rel) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push({ path: child, sha256: await sha256(path.join(dir, child)), size: statSync(path.join(dir, child)).size });
    }
  };
  await walk("");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}

/** Paths in `next` that are new or differ from `previous`. */
export function changedFiles(next, previous) {
  const old = new Map(previous.files.map((f) => [f.path, f.sha256]));
  return next.files.filter((f) => old.get(f.path) !== f.sha256).map((f) => f.path);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1];
  try {
    if (command === "index") {
      writeFileSync(args.out, `${JSON.stringify(await buildIndex(args.dir))}\n`);
      console.log(`Indexed ${args.dir} into ${args.out}.`);
    } else if (command === "changed") {
      const changed = changedFiles(JSON.parse(readFileSync(args.index, "utf8")), JSON.parse(readFileSync(args.previous, "utf8")));
      const summary = collectChanged(changed, args.dir, args.out, args["previous-dir"]);
      console.log(`${changed.length} changed file(s) in ${args.out}: ${summary.copied} copied, ${summary.patched} as binary patches, ${Math.round(summary.bytes / 1048576)} MB.`);
    } else throw new Error("usage: release-delta.mjs index|changed ...");
  } catch (error) {
    console.error(`[release-delta] ${error.message}`);
    process.exitCode = 1;
  }
}
