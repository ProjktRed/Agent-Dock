// Signed releases (0.22.1). The release workflow zips the Windows build and runs this script:
//
//   sign-release.mjs --zip <file.zip> --version <x.y.z> --commit <sha> --out <dir> [--platform win-x64|linux-x64]
//     writes <dir>/manifest.json (name, version, commit, platform, file, sha256, size, builtAt) and
//     <dir>/manifest.sig: an Ed25519 signature over the exact bytes of manifest.json, made with the
//     private key in the RELEASE_SIGNING_KEY environment variable (PEM). The app installs a release
//     only when this signature verifies against the public key built into it.
//     --platform linux-x64 (0.33) signs the AppImage instead and writes manifest-linux-x64.json/.sig.
//     --index <files.json> [--delta <zip> --delta-from <x.y.z>] (0.33) add the file index and the
//     changed-files zip (scripts/release-delta.mjs) to the manifest, each with its SHA-256 and size.
//     --platform linux-x64 --delta <x-from-y.adpatch> --delta-from <y> (0.38) adds the AppImage patch.
//
//   sign-release.mjs --generate-key <private-key.pem>
//     creates a new key pair once: the private key goes to the given file (store it as the GitHub
//     secret RELEASE_SIGNING_KEY, then delete the file), the public key is printed for
//     src/main/release-key.ts.
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCT = "agent-dock";
export const PLATFORM = "win-x64";
export const PLATFORMS = { "win-x64": { ext: ".zip", manifest: "manifest" }, "linux-x64": { ext: ".AppImage", manifest: "manifest-linux-x64" } };

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** The manifest's exact bytes are what gets signed and verified, so no canonical form is needed. */
export async function buildManifest({ zip, version, commit, platform = PLATFORM, index, delta, deltaFrom, now = new Date() }) {
  if (!PLATFORMS[platform]) throw new Error(`platform must be one of ${Object.keys(PLATFORMS).join(", ")}`);
  if (!zip.endsWith(PLATFORMS[platform].ext)) throw new Error(`a ${platform} release file must end in ${PLATFORMS[platform].ext}`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must be x.y.z, got ${version}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be a full 40-character SHA");
  const manifest = { name: PRODUCT, version, commit, platform, file: path.basename(zip), sha256: await sha256File(zip), size: statSync(zip).size, builtAt: now.toISOString() };
  const describe = async (file) => ({ file: path.basename(file), sha256: await sha256File(file), size: statSync(file).size });
  if (index) manifest.index = await describe(index);
  if (delta) {
    // Windows: a changed-files zip checked against the file index. Linux: one binary patch of the AppImage,
    // whose result is checked against the AppImage's own SHA-256 above.
    if (platform === "linux-x64" ? !delta.endsWith(".adpatch") : !index) throw new Error(platform === "linux-x64" ? "a Linux delta is an .adpatch file" : "a delta needs the file index");
    if (!/^\d+\.\d+\.\d+$/.test(deltaFrom ?? "")) throw new Error("--delta-from must be the x.y.z version the delta starts from");
    manifest.delta = { from: deltaFrom, ...(await describe(delta)) };
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function signManifest(manifestText, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("RELEASE_SIGNING_KEY must be an Ed25519 private key");
  return sign(null, Buffer.from(manifestText, "utf8"), key).toString("base64");
}

export function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, ""), next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  try {
    if (args["generate-key"]) {
      const file = String(args["generate-key"]);
      if (existsSync(file)) throw new Error(`${file} already exists; refusing to overwrite a key`);
      const { privateKeyPem, publicKeyPem } = generateKeyPair();
      writeFileSync(file, privateKeyPem, { mode: 0o600 });
      console.log(`Private key written to ${file}. Add it as the GitHub secret RELEASE_SIGNING_KEY, then delete the file.`);
      console.log(`Public key (paste into src/main/release-key.ts):\n${publicKeyPem}`);
    } else {
      const pem = process.env.RELEASE_SIGNING_KEY;
      if (!pem) throw new Error("RELEASE_SIGNING_KEY is not set (the release workflow reads it from the repository secret)");
      if (!args.zip || !args.version || !args.commit || !args.out) throw new Error("usage: sign-release.mjs --zip <file> --version <x.y.z> --commit <sha> --out <dir>");
      const platform = args.platform ? String(args.platform) : PLATFORM;
      const manifest = await buildManifest({ zip: args.zip, version: args.version, commit: args.commit, platform, index: args.index, delta: args.delta, deltaFrom: args["delta-from"] });
      const base = PLATFORMS[platform].manifest;
      writeFileSync(path.join(args.out, `${base}.json`), manifest);
      writeFileSync(path.join(args.out, `${base}.sig`), `${signManifest(manifest, pem)}\n`);
      console.log(`Signed ${path.basename(args.zip)} ${args.version} (${args.commit.slice(0, 7)}).`);
    }
  } catch (error) {
    console.error(`[sign-release] ${error.message}`);
    process.exitCode = 1;
  }
}
