import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { applyPatch } from "@shared/block-patch";

// Signed release channel (0.22.1). The app downloads the newest GitHub Release, and installs it only
// when its manifest is signed by the release key built into the app, names this product and
// platform, is newer than the installed version, and the downloaded zip matches the manifest's
// SHA-256 and size. No Node.js or git is needed: the new app's own executable runs the swap.
// Linux (0.33): the release also carries a signed AppImage with its own manifest; the app replaces
// its AppImage file and relaunches.

export interface ReleaseAsset { file: string; sha256: string; size: number }
export interface ReleaseManifest {
  name: string; version: string; commit: string; platform: string; file: string; sha256: string; size: number; builtAt: string;
  /** 0.33: every file of the build with its SHA-256 and size, and the files changed since `delta.from`. */
  index?: ReleaseAsset; delta?: ReleaseAsset & { from: string };
}
export interface ReleaseInfo { manifest: ReleaseManifest; zipUrl: string; notes: string; tag: string; indexUrl?: string; deltaUrl?: string }
const PRODUCT = "agent-dock", MAX_ZIP = 1024 * 1024 * 1024;
export type ReleasePlatform = "win-x64" | "linux-x64";
/** This machine's release platform, or null where no signed build exists. */
export const releasePlatform = (platform: string = process.platform): ReleasePlatform | null => (platform === "win32" ? "win-x64" : platform === "linux" ? "linux-x64" : null);
/** Windows keeps the original asset names, so apps from before 0.33 still find their manifest. */
const MANIFEST_ASSETS: Record<ReleasePlatform, [string, string]> = { "win-x64": ["manifest.json", "manifest.sig"], "linux-x64": ["manifest-linux-x64.json", "manifest-linux-x64.sig"] };
const FILE_PATTERN: Record<ReleasePlatform, RegExp> = { "win-x64": /^[\w.-]+\.zip$/, "linux-x64": /^[\w.-]+\.AppImage$/ };

/** a > b for x.y.z versions. */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** Verifies the signature over the manifest's exact bytes and its contents; returns the manifest or throws. */
export function verifyManifest(manifestText: string, signatureB64: string, publicKeyPem: string, platform: ReleasePlatform = "win-x64"): ReleaseManifest {
  if (!publicKeyPem.trim()) throw new Error("This build has no release key, so signed releases cannot be verified.");
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The release key is not an Ed25519 key.");
  let ok = false;
  try { ok = verify(null, Buffer.from(manifestText, "utf8"), key, Buffer.from(signatureB64.trim(), "base64")); } catch { ok = false; }
  if (!ok) throw new Error("The release signature does not match; the release was not installed.");
  const m = JSON.parse(manifestText) as ReleaseManifest;
  if (m.name !== PRODUCT || m.platform !== platform) throw new Error(`The release is for ${m.name}/${m.platform}, not ${PRODUCT}/${platform}.`);
  if (!/^\d+\.\d+\.\d+$/.test(m.version) || !/^[0-9a-f]{40}$/.test(m.commit) || !/^[0-9a-f]{64}$/.test(m.sha256) || !(m.size > 0 && m.size < MAX_ZIP) || !FILE_PATTERN[platform].test(m.file)) throw new Error("The release manifest is malformed.");
  const asset = (a: ReleaseAsset | undefined, pattern: RegExp) => !a || (pattern.test(a.file) && /^[0-9a-f]{64}$/.test(a.sha256) && a.size > 0 && a.size < MAX_ZIP);
  if (!asset(m.index, /^[\w.-]+\.json$/) || !asset(m.delta, /^[\w.-]+\.zip$/) || (m.delta && (!m.index || !/^\d+\.\d+\.\d+$/.test(m.delta.from)))) throw new Error("The release manifest is malformed.");
  return m;
}

type Fetch = typeof fetch;
const HEADERS = { "user-agent": "Agent-Dock-Updater", accept: "application/vnd.github+json" };

/** The newest signed release of `repo` ("owner/name"), verified, or null when it is not newer than `installed`. */
export async function checkRelease(repo: string, installed: string, publicKeyPem: string, fetchImpl: Fetch = fetch, platform: ReleasePlatform = "win-x64"): Promise<ReleaseInfo | null> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("The release repository must look like owner/name.");
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) throw new Error(`No published release found in ${repo} (or the repository is private).`);
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${repo}.`);
  const release = (await response.json()) as { tag_name: string; body?: string; assets: { name: string; browser_download_url: string }[] };
  const asset = (name: string) => release.assets.find((a) => a.name === name)?.browser_download_url;
  const [manifestName, sigName] = MANIFEST_ASSETS[platform];
  const manifestUrl = asset(manifestName), sigUrl = asset(sigName);
  if (!manifestUrl || !sigUrl) throw new Error(`Release ${release.tag_name} has no signed ${platform === "win-x64" ? "" : `${platform} `}manifest.`);
  const text = async (url: string) => { const r = await fetchImpl(url, { headers: { "user-agent": HEADERS["user-agent"] }, signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`); return r.text(); };
  const manifest = verifyManifest(await text(manifestUrl), await text(sigUrl), publicKeyPem, platform);
  if (!newerVersion(manifest.version, installed)) return null;
  const zipUrl = asset(manifest.file);
  if (!zipUrl) throw new Error(`Release ${release.tag_name} does not contain ${manifest.file}.`);
  const indexUrl = manifest.index ? asset(manifest.index.file) : undefined, deltaUrl = manifest.delta ? asset(manifest.delta.file) : undefined;
  return { manifest, zipUrl, notes: release.body ?? "", tag: release.tag_name, ...(indexUrl ? { indexUrl } : {}), ...(deltaUrl ? { deltaUrl } : {}) };
}

/** Downloads one release asset, checking size and SHA-256 against the signed manifest; returns the file path. */
async function downloadVerified(url: string, expected: ReleaseAsset, dir: string, fetchImpl: Fetch, onProgress: (bytes: number) => void): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, expected.file);
  const response = await fetchImpl(url, { headers: { "user-agent": HEADERS["user-agent"] }, signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const counted = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).map((chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > expected.size) throw new Error("The download is larger than the signed manifest says.");
    hash.update(chunk);
    onProgress(bytes);
    return chunk;
  });
  try { await pipeline(counted, createWriteStream(file)); }
  catch (error) { rmSync(file, { force: true }); throw error; }
  if (bytes !== expected.size || hash.digest("hex") !== expected.sha256) {
    rmSync(file, { force: true });
    throw new Error("The download does not match the signed manifest; it was deleted and nothing was installed.");
  }
  return file;
}

/** Downloads the zip, checking size and SHA-256 against the signed manifest; returns the file path. */
export function downloadRelease(info: ReleaseInfo, dir: string, fetchImpl: Fetch = fetch, onProgress: (bytes: number) => void = () => {}): Promise<string> {
  return downloadVerified(info.zipUrl, info.manifest, dir, fetchImpl, onProgress);
}

/** The delta applies only to the exact version it was made from, and only with its index. */
export const deltaUsable = (info: ReleaseInfo, installed: string): boolean => Boolean(info.manifest.delta && info.manifest.index && info.deltaUrl && info.indexUrl && info.manifest.delta.from === installed);

const fileSha256 = async (file: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/**
 * Rebuilds the new version in `outDir`: each indexed file comes from the changed files when present,
 * from a binary patch (__adpatch/<path>, 0.35) applied to the installed file, otherwise from the installed
 * app, and must match the signed index (SHA-256 and size). Files not in the index are left out. Throws
 * on the first mismatch, so the caller can fall back to the full zip.
 */
export async function assembleFromDelta(index: { files: { path: string; sha256: string; size: number }[] }, changedDir: string, installDir: string, outDir: string): Promise<string> {
  if (!Array.isArray(index?.files) || !index.files.length) throw new Error("The file index is empty.");
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  for (const entry of index.files) {
    const rel = String(entry.path);
    if (!rel || rel.startsWith("/") || rel.split("/").some((part) => part === ".." || part === "") || /[\\:]/.test(rel)) throw new Error(`Unsafe path in the file index: ${rel}`);
    const changed = path.join(changedDir, ...rel.split("/"));
    const patch = path.join(changedDir, "__adpatch", ...rel.split("/"));
    const installed = path.join(installDir, ...rel.split("/"));
    const source = existsSync(changed) ? changed : installed;
    if (!existsSync(source)) throw new Error(`${rel} is missing from the installed app.`);
    const target = path.join(outDir, ...rel.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    if (!existsSync(changed) && existsSync(patch)) writeFileSync(target, applyPatch(readFileSync(installed), readFileSync(patch)));
    else copyFileSync(source, target);
    if (statSync(target).size !== entry.size || (await fileSha256(target)) !== entry.sha256) throw new Error(`${rel} does not match the signed file index.`);
  }
  if (!existsSync(path.join(outDir, "AgentDock.exe"))) throw new Error("The rebuilt update has no AgentDock.exe.");
  return outDir;
}

/** Smaller update: downloads the index and the changed files, verifies both, and rebuilds the app; returns its folder. */
export async function applyDelta(info: ReleaseInfo, dir: string, installDir: string, fetchImpl: Fetch = fetch): Promise<string> {
  const indexFile = await downloadVerified(info.indexUrl!, info.manifest.index!, dir, fetchImpl, () => {});
  const deltaZip = await downloadVerified(info.deltaUrl!, info.manifest.delta!, dir, fetchImpl, () => {});
  const changedDir = path.join(dir, `${info.manifest.version}-changed`);
  await expandZip(deltaZip, changedDir);
  return assembleFromDelta(JSON.parse(readFileSync(indexFile, "utf8")), changedDir, installDir, path.join(dir, info.manifest.version));
}

/** Expands a verified zip into an empty folder with Windows' own Expand-Archive. */
async function expandZip(zip: string, dir: string): Promise<void> {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const quote = (p: string) => `'${p.replaceAll("'", "''")}'`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dir)} -Force`], { windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Extracting the update failed (exit ${code}).`))));
  });
}

/** Extracts the verified zip with Windows' own Expand-Archive and returns the folder with AgentDock.exe. */
export async function extractRelease(zip: string, dir: string): Promise<string> {
  await expandZip(zip, dir);
  for (const candidate of [dir, path.join(dir, "win-unpacked")]) if (existsSync(path.join(candidate, "AgentDock.exe"))) return candidate;
  throw new Error("The update does not contain AgentDock.exe.");
}

/**
 * Linux: replaces the running AppImage (the path in $APPIMAGE) with the verified download. The new
 * file is written next to it and renamed over it, so the AppImage is never half-written; the running
 * app keeps its mounted copy until it quits.
 */
export function installAppImage(downloaded: string, target: string) {
  if (!target || !path.isAbsolute(target) || !existsSync(target)) throw new Error("Agent Dock is not running from an AppImage, so it cannot update itself here.");
  const next = `${target}.update`;
  try {
    copyFileSync(downloaded, next);
    chmodSync(next, 0o755);
    renameSync(next, target);
  } catch (error) {
    rmSync(next, { force: true });
    throw new Error(`Replacing the AppImage failed: ${(error as Error).message}`);
  }
}

/** Hands off to the new app's swap script (resources/scripts/swap.mjs), run by the new exe in Node mode. */
export function launchSwap({ unpacked, installDir, waitPid, resultFile, logFd, version }: { unpacked: string; installDir: string; waitPid: number; resultFile: string; logFd: number; version?: string }) {
  const script = path.join(unpacked, "resources", "scripts", "swap.mjs");
  if (!existsSync(script)) throw new Error("The update has no swap script; it cannot install itself.");
  spawn(path.join(unpacked, "AgentDock.exe"), [script, "--from", unpacked, "--install-dir", installDir, "--wait-pid", String(waitPid), "--relaunch", "--result", resultFile, ...(version ? ["--version", version] : [])], {
    cwd: path.dirname(unpacked), detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  }).unref();
}
