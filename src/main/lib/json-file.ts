import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  // Windows can briefly lock the target (indexers, antivirus); retry like the engine does.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !["EPERM", "EACCES", "EBUSY"].includes(code) || attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, 5 * (attempt + 1))));
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

/** Reads the last `limit` NDJSON records, skipping malformed lines (a partially written tail is possible). */
export async function readNdjsonTail<T>(file: string, limit: number): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
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
