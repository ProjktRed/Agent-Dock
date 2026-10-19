import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRelease, downloadRelease, installAppImage, newerVersion, releasePlatform, verifyManifest } from "../src/main/release-channel";
import { buildManifest, generateKeyPair, signManifest } from "../scripts/sign-release.mjs";
import { isUninstaller, swap, uninstallVersionScript } from "../scripts/swap.mjs";
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

  it("Linux: a signed AppImage has its own manifest, and neither platform accepts the other's", async () => {
    expect([releasePlatform("win32"), releasePlatform("linux"), releasePlatform("darwin")]).toEqual(["win-x64", "linux-x64", null]);
    const dir = await tmp();
    const appImage = path.join(dir, "AgentDock-0.33.0-linux-x86_64.AppImage");
    writeFileSync(appImage, Buffer.from("ELF fake AppImage"));
    await expect(buildManifest({ zip: appImage, version: "0.33.0", commit: COMMIT })).rejects.toThrow(/must end in .zip/);
    const manifest = await buildManifest({ zip: appImage, version: "0.33.0", commit: COMMIT, platform: "linux-x64" });
    const sig = signManifest(manifest, keys.privateKeyPem);
    expect(verifyManifest(manifest, sig, keys.publicKeyPem, "linux-x64").file).toBe(path.basename(appImage));
    expect(() => verifyManifest(manifest, sig, keys.publicKeyPem)).toThrow(/not agent-dock\/win-x64/);
    const win = await signedRelease();
    expect(() => verifyManifest(win.manifest, win.sig, keys.publicKeyPem, "linux-x64")).toThrow(/not agent-dock\/linux-x64/);
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: "v0.33.0", assets: [
        { name: "manifest.json", browser_download_url: "https://dl/manifest.json" }, { name: "manifest.sig", browser_download_url: "https://dl/manifest.sig" },
        { name: "manifest-linux-x64.json", browser_download_url: "https://dl/manifest-linux-x64.json" }, { name: "manifest-linux-x64.sig", browser_download_url: "https://dl/manifest-linux-x64.sig" },
        { name: path.basename(appImage), browser_download_url: "https://dl/appimage" }] }), { status: 200 });
      if (String(url).endsWith("manifest-linux-x64.json")) return new Response(manifest);
      if (String(url).endsWith("manifest-linux-x64.sig")) return new Response(sig);
      if (String(url).endsWith("manifest.json")) return new Response(win.manifest);
      if (String(url).endsWith("manifest.sig")) return new Response(win.sig);
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const info = await checkRelease("o/r", "0.32.0", keys.publicKeyPem, fetchImpl, "linux-x64");
    expect([info?.manifest.platform, info?.zipUrl]).toEqual(["linux-x64", "https://dl/appimage"]);
  });

  it("Linux: the AppImage is replaced whole and stays executable; a missing AppImage path is refused", async () => {
    const dir = await tmp();
    const target = path.join(dir, "Agent Dock.AppImage"), downloaded = path.join(dir, "new.AppImage");
    writeFileSync(target, "old"); writeFileSync(downloaded, "new");
    installAppImage(downloaded, target);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(existsSync(`${target}.update`)).toBe(false);
    expect(() => installAppImage(downloaded, "")).toThrow(/not running from an AppImage/);
    expect(() => installAppImage(downloaded, path.join(dir, "missing.AppImage"))).toThrow(/not running from an AppImage/);
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

describe("Apps list version after an update", () => {
  it("targets the uninstall entry whose uninstaller is in the install folder, with a plain version only", () => {
    const script = uninstallVersionScript(String.raw`C:\Users\A\AppData\Local\Programs\AgentDock\ `.trim(), "0.31.2")!;
    expect(script).toContain(String.raw`Contains('c:\users\a\appdata\local\programs\agentdock\')`);
    expect(script).toContain("DisplayVersion '0.31.2'");
    expect(uninstallVersionScript(String.raw`C:\App`, "0.31.2-beta.1")).toContain("'0.31.2-beta.1'");
    for (const bad of [undefined, "", "1.2", "1.2.3'; Remove-Item x", "1.2.3 x"]) expect(uninstallVersionScript(String.raw`C:\App`, bad)).toBeNull();
  });
});

describe("smaller (delta) updates", () => {
  const write = (dir: string, rel: string, text: string) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };

  it("indexes a build, finds changed files, and signs both into the manifest", async () => {
    const { buildIndex, changedFiles } = await import("../scripts/release-delta.mjs");
    const oldBuild = await tmp(), newBuild = await tmp();
    for (const [rel, text] of [["AgentDock.exe", "exe"], ["resources/app.asar", "old app"], ["resources/gone.txt", "x"]]) write(oldBuild, rel, text);
    for (const [rel, text] of [["AgentDock.exe", "exe"], ["resources/app.asar", "new app"], ["resources/added.txt", "y"]]) write(newBuild, rel, text);
    const [oldIndex, newIndex] = [await buildIndex(oldBuild), await buildIndex(newBuild)];
    expect(newIndex.files.map((f: { path: string }) => f.path)).toEqual(["AgentDock.exe", "resources/added.txt", "resources/app.asar"]);
    expect(changedFiles(newIndex, oldIndex)).toEqual(["resources/added.txt", "resources/app.asar"]);
    const dir = await tmp();
    const zip = path.join(dir, "AgentDock-0.34.0-win-x64.zip"), index = path.join(dir, "AgentDock-0.34.0-win-x64.files.json"), delta = path.join(dir, "AgentDock-0.34.0-from-0.33.0-win-x64.zip");
    writeFileSync(zip, "full"); writeFileSync(index, JSON.stringify(newIndex)); writeFileSync(delta, "changed");
    await expect(buildManifest({ zip, version: "0.34.0", commit: COMMIT, delta, deltaFrom: "0.33.0" })).rejects.toThrow(/needs the file index/);
    const manifest = await buildManifest({ zip, version: "0.34.0", commit: COMMIT, index, delta, deltaFrom: "0.33.0" });
    const m = verifyManifest(manifest, signManifest(manifest, keys.privateKeyPem), keys.publicKeyPem);
    expect([m.index?.file, m.delta?.from, m.delta?.size]).toEqual([path.basename(index), "0.33.0", 7]);
    const bad = manifest.replace('"from": "0.33.0"', '"from": "latest"');
    expect(() => verifyManifest(bad, signManifest(bad, keys.privateKeyPem), keys.publicKeyPem)).toThrow(/malformed/);
  });

  it("uses a delta only from its exact base version, and rebuilds only files that match the signed index", async () => {
    const { buildIndex } = await import("../scripts/release-delta.mjs");
    const { assembleFromDelta, deltaUsable } = await import("../src/main/release-channel");
    const asset = { file: "a.json", sha256: "a".repeat(64), size: 1 };
    const info = { manifest: { delta: { ...asset, file: "d.zip", from: "0.33.0" }, index: asset }, indexUrl: "i", deltaUrl: "d" } as unknown as Parameters<typeof deltaUsable>[0];
    expect([deltaUsable(info, "0.33.0"), deltaUsable(info, "0.32.0"), deltaUsable({ ...info, deltaUrl: undefined }, "0.33.0")]).toEqual([true, false, false]);
    const installed = await tmp(), target = await tmp(), changed = await tmp(), out = path.join(await tmp(), "rebuilt");
    for (const [rel, text] of [["AgentDock.exe", "exe"], ["resources/app.asar", "old app"], ["Uninstall AgentDock.exe", "u"]]) write(installed, rel, text);
    for (const [rel, text] of [["AgentDock.exe", "exe"], ["resources/app.asar", "new app"], ["resources/added.txt", "y"]]) write(target, rel, text);
    for (const [rel, text] of [["resources/app.asar", "new app"], ["resources/added.txt", "y"]]) write(changed, rel, text);
    const index = await buildIndex(target);
    await assembleFromDelta(index, changed, installed, out);
    expect(readFileSync(path.join(out, "resources", "app.asar"), "utf8")).toBe("new app");
    expect(existsSync(path.join(out, "Uninstall AgentDock.exe"))).toBe(false);
    writeFileSync(path.join(changed, "resources", "app.asar"), "tampered");
    await expect(assembleFromDelta(index, changed, installed, out)).rejects.toThrow(/app\.asar does not match/);
    await expect(assembleFromDelta({ files: [{ path: "../evil", sha256: "a".repeat(64), size: 1 }] }, changed, installed, out)).rejects.toThrow(/Unsafe path/);
  });
});
