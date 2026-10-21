import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

const queues = new Map<string, Promise<void>>();

async function replace(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await renameWithRetry(temporary, file);
}

/**
 * Windows can briefly lock the target (indexers, antivirus): retry for up to about five seconds, as the
 * engine does (engine/src/fs-retry.mjs). The temporary file is removed when the rename finally fails.
 */
export async function renameWithRetry(from: string, to: string, { budgetMs = 5_000, renameImpl = rename } = {}): Promise<void> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !["EPERM", "EACCES", "EBUSY"].includes(code) || waited >= budgetMs) {
        await rm(from, { force: true }).catch(() => undefined);
        throw error;
      }
      const delay = Math.min(250, 10 * 2 ** Math.min(attempt, 5));
      await new Promise((resolve) => setTimeout(resolve, delay));
      waited += delay;
    }
  }
}

/** Atomic, per-file serialised JSON write. */
export function writeJson(file: string, value: unknown): Promise<void> {
  const previous = queues.get(file) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => replace(file, value));
  queues.set(file, operation);
  return operation.finally(() => {
    if (queues.get(file) === operation) queues.delete(file);
  });
}

/**
 * The end of a text file holding at least `lines` complete lines (or the whole file), read
 * backwards in growing chunks: logs only grow, and polling must not re-read all of them.
 */
export async function readTail(file: string, lines: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const chunks: Buffer[] = [];
    let position = size;
    let newlines = 0;
    let chunk = 64 * 1024;
    while (position > 0 && newlines <= lines) {
      const start = Math.max(0, position - chunk);
      const buffer = Buffer.alloc(position - start);
      await handle.read(buffer, 0, buffer.length, start);
      chunks.unshift(buffer);
      for (const byte of buffer) if (byte === 10) newlines++;
      position = start;
      chunk *= 2;
    }
    // Joined as bytes, so a character split between chunks stays intact; a partial first line is dropped.
    const text = Buffer.concat(chunks).toString("utf8");
    return position > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

/** Reads the last `limit` NDJSON records, skipping malformed lines (a partially written tail is possible). */
export async function readNdjsonTail<T>(file: string, limit: number): Promise<T[]> {
  let text: string;
  try {
    text = await readTail(file, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-limit);
  const records: T[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // ignore torn line
    }
  }
  return records;
}
