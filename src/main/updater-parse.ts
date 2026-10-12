import type { UpdateStatus } from "@shared/types";

/** Parse `git log --format=%H%x09%cI%x09%s` output. */
export function parseLog(stdout: string): UpdateStatus["commits"] {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...subject] = line.split("\t");
      return { hash, date, subject: subject.join("\t") };
    });
}

/** First column of `git ls-remote <source> refs/heads/<branch>`. */
export function parseLsRemote(stdout: string, branch: string): string | null {
  const line = stdout.split(/\r?\n/).find((l) => l.endsWith(`refs/heads/${branch}`));
  return line?.split(/\s+/)[0] ?? null;
}
