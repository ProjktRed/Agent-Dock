/** The most useful line of an engine crash: the last `Error: …` line, else the last non-empty line. */
export function lastError(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const error = [...lines].reverse().find((l) => /^(\w*Error|Usage):/.test(l));
  return (error ?? lines.at(-1) ?? "No output was written to the engine log.").slice(0, 400);
}
