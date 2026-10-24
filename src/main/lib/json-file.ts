import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * What the app last read or wrote for each file in the watched folder (its config folder), null when it
 * had no such file. Project checks are agent-editable code (S-02): restoreWatchedFiles() undoes what
 * anything else wrote there.
 */
const known = new Map<string, string | null>();
let watchedDir: string | null = null;
const watched = (file: string) => watchedDir !== null && path.dirname(path.resolve(file)) === watchedDir;

export function watchFolder(dir: string): void {
  watchedDir = path.resolve(dir);
}

/** A watched file the app writes itself without writeJson (a launcher script). */
export function rememberContent(file: string, text: string | null): void {
  if (watched(file)) known.set(path.resolve(file), text);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(file, "utf8");
    // Only what the app had no record of yet: a later read must not accept someone else's change.
    if (!known.has(path.resolve(file))) rememberContent(file, text);
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!known.has(path.resolve(file))) rememberContent(file, null);
      return fallback;
    }
    throw error;
  }
}

const queues = new Map<string, Promise<void>>();

/** Files 0600 and folders 0700 (Windows keeps the profile folder's ACL). */
const PRIVATE_FILE = 0o600;

async function replaceText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: PRIVATE_FILE });
  await renameWithRetry(temporary, file);
  rememberContent(file, text);
}

async function replace(file: string, value: unknown): Promise<void> {
  await replaceText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function queued(file: string, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(file) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(task);
  queues.set(file, operation);
  return operation.finally(() => {
    if (queues.get(file) === operation) queues.delete(file);
  });
}

/**
 * Puts back every watched file that differs from what the app last read or wrote. The changed copy is
 * kept beside it as <name>.changed-<time> for inspection. Returns the files put back, and those that
 * could not be read or put back (a folder in a file's place, no permission): each file on its own, so
 * one bad file never hides another.
 */
export async function restoreWatchedFiles(): Promise<{ restored: string[]; failed: { file: string; error: string }[] }> {
  const restored: string[] = [], failed: { file: string; error: string }[] = [];
  await Promise.all([...known.keys()].map((file) => queued(file, async () => {
    const expected = known.get(file) ?? null;
    const actual = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (actual === expected) return;
    if (actual !== null) await renameWithRetry(file, `${file}.changed-${Date.now()}`);
    if (expected !== null) await replaceText(file, expected);
    restored.push(file);
  }).catch((error: NodeJS.ErrnoException) => { failed.push({ file, error: error?.code ?? String(error?.message ?? error) }); })));
  return { restored: restored.sort(), failed: failed.sort((a, b) => a.file.localeCompare(b.file)) };
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
  return queued(file, () => replace(file, value));
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
