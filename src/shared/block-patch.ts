import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

// Binary patches for large files in smaller updates (0.35). Agent Dock's exe changes in every release
// (the asar integrity hash is built into it) though almost all of its bytes stay the same. A patch
// describes the new file as copies from the old file plus new bytes, found rsync-style: the old file's
// aligned blocks are indexed by a rolling checksum and the new file is scanned at every offset.
//
// Format: "ADPATCH1", a 4-byte little-endian header length, the JSON header { source, target }
// (sha256 and size of each), then the gzipped operations: "C" + offset + length (copy from the old
// file, 6-byte little-endian numbers) or "L" + length + bytes (new bytes).
// Plain TypeScript without enums so Node runs it directly in the release workflow.

export const PATCH_MAGIC = "ADPATCH1";
const BLOCK = 4096;
const MOD = 65521;
const MAX_CANDIDATES = 8;

export interface PatchHeader { source: { sha256: string; size: number }; target: { sha256: string; size: number } }

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function weak(data: Buffer, start: number, end: number): [number, number] {
  let a = 1, b = 0;
  for (let i = start; i < end; i++) { a = (a + data[i]) % MOD; b = (b + a) % MOD; }
  return [a, b];
}

/** A patch that turns `source` into `target`. */
export function makePatch(source: Buffer, target: Buffer, block = BLOCK): Buffer {
  const index = new Map<number, number[]>();
  for (let offset = 0; offset + block <= source.length; offset += block) {
    const [a, b] = weak(source, offset, offset + block);
    const key = (b << 16) | a;
    const list = index.get(key);
    if (!list) index.set(key, [offset]);
    else if (list.length < MAX_CANDIDATES) list.push(offset);
  }
  const ops: Buffer[] = [];
  let literalStart = 0;
  const num = (n: number) => { const out = Buffer.alloc(6); out.writeUIntLE(n, 0, 6); return out; };
  const flushLiteral = (end: number) => {
    if (end > literalStart) ops.push(Buffer.from("L"), num(end - literalStart), target.subarray(literalStart, end));
  };
  let pos = 0;
  let [a, b] = target.length >= block ? weak(target, 0, block) : [0, 0];
  while (pos + block <= target.length) {
    let match = -1;
    const list = index.get((b << 16) | a);
    if (list) for (const offset of list) if (source.compare(target, pos, pos + block, offset, offset + block) === 0) { match = offset; break; }
    if (match >= 0) {
      // Extend the copy past the block while the bytes keep matching.
      let length = block;
      while (pos + length < target.length && match + length < source.length && source[match + length] === target[pos + length]) length++;
      flushLiteral(pos);
      ops.push(Buffer.from("C"), num(match), num(length));
      pos += length;
      literalStart = pos;
      if (pos + block <= target.length) [a, b] = weak(target, pos, pos + block);
      continue;
    }
    // Roll the checksum one byte forward.
    const out = target[pos], incoming = target[pos + block];
    pos++;
    if (pos + block <= target.length) {
      a = (a - out + incoming + MOD) % MOD;
      b = (b - block * out + a - 1 + MOD * block) % MOD;
      if (b < 0) b += MOD;
    }
  }
  flushLiteral(target.length);
  const header = Buffer.from(JSON.stringify({ source: { sha256: sha256(source), size: source.length }, target: { sha256: sha256(target), size: target.length } } satisfies PatchHeader));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  return Buffer.concat([Buffer.from(PATCH_MAGIC), length, header, gzipSync(Buffer.concat(ops))]);
}

export function readPatchHeader(patch: Buffer): PatchHeader {
  if (patch.subarray(0, 8).toString("latin1") !== PATCH_MAGIC) throw new Error("Not an Agent Dock patch.");
  const length = patch.readUInt32LE(8);
  return JSON.parse(patch.subarray(12, 12 + length).toString("utf8")) as PatchHeader;
}

/** Applies a patch to `source`; throws unless both the source and the result match the patch's header. */
export function applyPatch(source: Buffer, patch: Buffer): Buffer {
  const header = readPatchHeader(patch);
  if (source.length !== header.source.size || sha256(source) !== header.source.sha256) throw new Error("The installed file is not the one this patch was made from.");
  const ops = gunzipSync(patch.subarray(12 + patch.readUInt32LE(8)));
  if (header.target.size > 1024 * 1024 * 1024) throw new Error("The patch target is too large.");
  const out = Buffer.alloc(header.target.size);
  let pos = 0, at = 0;
  while (at < ops.length) {
    const op = String.fromCharCode(ops[at]);
    if (op === "C") {
      const offset = ops.readUIntLE(at + 1, 6), length = ops.readUIntLE(at + 7, 6);
      if (offset + length > source.length || pos + length > out.length) throw new Error("The patch is malformed.");
      source.copy(out, pos, offset, offset + length);
      pos += length; at += 13;
    } else if (op === "L") {
      const length = ops.readUIntLE(at + 1, 6);
      if (at + 7 + length > ops.length || pos + length > out.length) throw new Error("The patch is malformed.");
      ops.copy(out, pos, at + 7, at + 7 + length);
      pos += length; at += 7 + length;
    } else throw new Error("The patch is malformed.");
  }
  if (pos !== out.length || sha256(out) !== header.target.sha256) throw new Error("The patched file does not match the patch.");
  return out;
}
