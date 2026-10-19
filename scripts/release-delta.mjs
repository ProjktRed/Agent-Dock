// Smaller updates (0.33). The release workflow describes every file of the Windows build in a file
// index, and, when the previous release published its index, collects the files that changed into a
// folder that becomes the delta zip:
//
//   release-delta.mjs index --dir dist/win-unpacked --out AgentDock-<v>-win-x64.files.json
//   release-delta.mjs changed --dir dist/win-unpacked --index <new.files.json> --previous <old.files.json> --out delta/
//
// sign-release.mjs then signs both into the manifest (index and delta: file, sha256, size). The app
// uses the delta only when it runs exactly the delta's base version, rebuilds the new version from
// its own files plus the changed ones, and installs it only if every file matches the signed index.
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
      for (const rel of changed) {
        mkdirSync(path.dirname(path.join(args.out, rel)), { recursive: true });
        copyFileSync(path.join(args.dir, rel), path.join(args.out, rel));
      }
      console.log(`${changed.length} changed file(s) copied to ${args.out}.`);
    } else throw new Error("usage: release-delta.mjs index|changed ...");
  } catch (error) {
    console.error(`[release-delta] ${error.message}`);
    process.exitCode = 1;
  }
}
