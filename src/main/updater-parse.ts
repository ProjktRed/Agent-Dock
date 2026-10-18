import type { UpdateStatus } from "@shared/types";

/** `git log` format read by parseLog: fields split by US (0x1f), commits by RS (0x1e). */
export const LOG_FORMAT = "--format=%H%x1f%cI%x1f%s%x1f%b%x1e";

/** Commit trailers (Co-Authored-By, Signed-off-by…) are not changelog text. */
const TRAILER = /^[A-Za-z][\w-]*-[Bb]y: /;

/** Parse `git log` output in LOG_FORMAT. */
export function parseLog(stdout: string): UpdateStatus["commits"] {
  return stdout
    .split("\x1e")
    .map((record) => record.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash, date, subject = "", body = ""] = record.split("\x1f");
      const lines = body.replace(/\r/g, "").split("\n").filter((line) => !TRAILER.test(line.trim()));
      return { hash, date, subject, body: lines.join("\n").trim() };
    });
}

/** First column of `git ls-remote <source> refs/heads/<branch>`. */
export function parseLsRemote(stdout: string, branch: string): string | null {
  const line = stdout.split(/\r?\n/).find((l) => l.endsWith(`refs/heads/${branch}`));
  return line?.split(/\s+/)[0] ?? null;
}
