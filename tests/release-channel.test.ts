import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRelease, downloadRelease, newerVersion, verifyManifest } from "../src/main/release-channel";
import { buildManifest, generateKeyPair, signManifest } from "../scripts/sign-release.mjs";
import { isUninstaller, swap } from "../scripts/swap.mjs";
import { stagingDir } from "../src/main/updater";
import { DEFAULT_RELEASE_REPO, DEFAULT_SETTINGS, FORMER_SOURCE, SOURCE_URL, updateChannel } from "../src/shared/defaults";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), "release-")); dirs.push(d); return d; };
const COMMIT = "a".repeat(40);
const keys = generateKeyPair();

async function signedRelease(version = "0.30.0") {
  const dir = await tmp();
  const zip = path.join(dir, `AgentDock-${version}-win-x64.zip`);
  writeFileSync(zip, Buffer.from("PK fake zip bytes for the test"));
  const manifest = await buildManifest({ zip, version, commit: COMMIT });
  return { dir, zip, manifest, sig: signManifest(manifest, keys.privateKeyPem), bytes: readFileSync(zip) };
}

function fakeGitHub(release: Awaited<ReturnType<typeof signedRelease>>, { tag = "v0.30.0", sig = release.sig, zipBytes = release.bytes } = {}) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    const ok = (body: BodyInit) => new Response(body, { status: 200 });
    if (String(url).endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: tag, body: "Signed release notes\nmore", assets: [
      { name: "manifest.json", browser_download_url: "https://dl/manifest.json" }, { name: "manifest.sig", browser_download_url: "https://dl/manifest.sig" },
      { name: path.basename(release.zip), browser_download_url: "https://dl/zip" }] }), { status: 200 });
    if (String(url).endsWith("manifest.json")) return ok(release.manifest);
    if (String(url).endsWith("manifest.sig")) return ok(sig);
    if (String(url).endsWith("/zip")) return ok(zipBytes);
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("signed releases", () => {
  it("compares versions", () => {
    expect(newerVersion("0.30.0", "0.22.1")).toBe(true);
    expect(newerVersion("0.22.10", "0.22.9")).toBe(true);
    expect(newerVersion("0.22.1", "0.22.1")).toBe(false);
    expect(newerVersion("0.21.9", "0.22.0")).toBe(false);
  });

  it("verifies only the exact manifest signed by the release key, for this product", async () => {
    const r = await signedRelease();
    expect(verifyManifest(r.manifest, r.sig, keys.publicKeyPem).version).toBe("0.30.0");
    expect(() => verifyManifest(r.manifest.replace("0.30.0", "0.31.0"), r.sig, keys.publicKeyPem)).toThrow(/signature does not match/);
    expect(() => verifyManifest(r.manifest, r.sig, generateKeyPair().publicKeyPem)).toThrow(/signature does not match/);
    expect(() => verifyManifest(r.manifest, "not-base64!!", keys.publicKeyPem)).toThrow(/signature does not match/);
    expect(() => verifyManifest(r.manifest, r.sig, "")).toThrow(/no release key/);
    const other = r.manifest.replace('"agent-dock"', '"other-app"');
    expect(() => verifyManifest(other, signManifest(other, keys.privateKeyPem), keys.publicKeyPem)).toThrow(/not agent-dock/);
    expect(() => signManifest(r.manifest, generateKeyPairRsa())).toThrow(/Ed25519/);
  });

  it("offers a newer verified release and nothing else", async () => {
    const r = await signedRelease();
    const gh = fakeGitHub(r);
    const info = await checkRelease("ProjktRed/Agent-Dock", "0.22.1", keys.publicKeyPem, gh.fetchImpl);
    expect(info?.manifest.version).toBe("0.30.0");
    expect(info?.zipUrl).toBe("https://dl/zip");
    expect(gh.urls[0]).toBe("https://api.github.com/repos/ProjktRed/Agent-Dock/releases/latest");
    expect(await checkRelease("ProjktRed/Agent-Dock", "0.30.0", keys.publicKeyPem, gh.fetchImpl)).toBeNull();
    await expect(checkRelease("ProjktRed/Agent-Dock", "0.22.1", keys.publicKeyPem, fakeGitHub(r, { sig: signManifest(r.manifest, generateKeyPair().privateKeyPem) }).fetchImpl)).rejects.toThrow(/signature/);
    await expect(checkRelease("not a repo", "0.22.1", keys.publicKeyPem, gh.fetchImpl)).rejects.toThrow(/owner\/name/);
    const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(checkRelease("ProjktRed/Agent-Dock", "0.22.1", keys.publicKeyPem, missing)).rejects.toThrow(/No published release/);
  });

  it("keeps a download only when its size and SHA-256 match the signed manifest", async () => {
    const r = await signedRelease();
    const out = await tmp();
    const info = (await checkRelease("o/r", "0.1.0", keys.publicKeyPem, fakeGitHub(r).fetchImpl))!;
    const file = await downloadRelease(info, out, fakeGitHub(r).fetchImpl);
    expect(readFileSync(file)).toEqual(r.bytes);
    const tampered = Buffer.from(r.bytes); tampered[0] ^= 1;
    await expect(downloadRelease(info, out, fakeGitHub(r, { zipBytes: tampered }).fetchImpl)).rejects.toThrow(/does not match the signed manifest/);
    expect(existsSync(path.join(out, info.manifest.file))).toBe(false);
    await expect(downloadRelease(info, out, fakeGitHub(r, { zipBytes: Buffer.concat([r.bytes, Buffer.from("extra")]) }).fetchImpl)).rejects.toThrow(/larger than the signed manifest/);
  });

  it.runIf(process.platform === "win32")("swaps the install folder in one step and keeps nothing half-copied", async () => {
    const root = await tmp();
    const from = path.join(root, "new"), installDir = path.join(root, "App");
    mkdirSync(from); mkdirSync(installDir);
    writeFileSync(path.join(from, "AgentDock.exe"), "new"); writeFileSync(path.join(installDir, "AgentDock.exe"), "old"); writeFileSync(path.join(installDir, "stale.txt"), "x");
    await swap({ from, installDir, shortcuts: false });
    expect(readFileSync(path.join(installDir, "AgentDock.exe"), "utf8")).toBe("new");
    expect(existsSync(path.join(installDir, "stale.txt"))).toBe(false);
    expect(existsSync(`${installDir}.new`) || existsSync(`${installDir}.old`)).toBe(false);
    await expect(swap({ from: path.join(root, "nothing"), installDir, shortcuts: false })).rejects.toThrow(/does not contain/);
  });

  it.runIf(process.platform === "win32")("keeps the installer's uninstaller when an update replaces the files", async () => {
    const root = await tmp();
    const from = path.join(root, "new"), installDir = path.join(root, "AgentDock");
    mkdirSync(from); mkdirSync(installDir);
    writeFileSync(path.join(from, "AgentDock.exe"), "new");
    writeFileSync(path.join(installDir, "AgentDock.exe"), "old"); writeFileSync(path.join(installDir, "Uninstall Agent Dock.exe"), "uninstaller");
    await swap({ from, installDir, shortcuts: false });
    expect(readFileSync(path.join(installDir, "AgentDock.exe"), "utf8")).toBe("new");
    expect(readFileSync(path.join(installDir, "Uninstall Agent Dock.exe"), "utf8")).toBe("uninstaller");
    expect([isUninstaller("Uninstall Agent Dock.exe"), isUninstaller("AgentDock.exe"), isUninstaller("Uninstall.txt")]).toEqual([true, false, false]);
  });

  it("puts update files beside a release:local install, and under LOCALAPPDATA for an installed app", () => {
    const programs = path.join("C:", "Users", "a", "AppData", "Local", "Programs"), local = path.join("C:", "L");
    expect(stagingDir(path.join(programs, "Agent Dock", "App", "AgentDock.exe"), local)).toBe(path.join(programs, "Agent Dock", "Updates"));
    expect(stagingDir(path.join(programs, "AgentDock", "AgentDock.exe"), local)).toBe(path.join(local, "Agent Dock", "Updates"));
  });

  it("release builds always update from signed releases, published in the source repository by default", () => {
    const git = { updates: { ...DEFAULT_SETTINGS.updates, channel: "git" as const } };
    expect(updateChannel(git, "release")).toBe("release");
    expect(updateChannel(git, "dev")).toBe("git");
    expect(updateChannel({ updates: { channel: "release" } }, "dev")).toBe("release");
    expect(DEFAULT_SETTINGS.updates.releaseRepo).toBe(DEFAULT_RELEASE_REPO);
    expect(DEFAULT_RELEASE_REPO).toBe("ProjktRed/Agent-Dock");
    // The repository was briefly named Agent-Dock-Dev; that address maps back to the real one.
    for (const old of ["https://github.com/ProjktRed/Agent-Dock-Dev.git", "https://github.com/ProjktRed/Agent-Dock-Dev", "https://github.com/projktred/agent-dock-dev.git"]) expect(FORMER_SOURCE.test(old)).toBe(true);
    for (const other of [SOURCE_URL, "https://github.com/ProjktRed/Agent-Dock", "C:\\src\\Agent-Dock"]) expect(FORMER_SOURCE.test(other)).toBe(false);
  });
});

function generateKeyPairRsa(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}
