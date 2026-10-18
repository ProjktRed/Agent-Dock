// Return the original command, or the base of one narrowly permitted output
// filter. The caller must still approve and validate that base command.
export function stripCheckOutputFilter(script) {
  if (typeof script !== 'string') return null;
  if (!script.includes('|')) return script;
  if (/[\r\n]/.test(script)) return null;
  const match = script.match(/^(.*?)(?:[ \t]+2>&1)?[ \t]*\|[ \t]*(?:tail|head)[ \t]+-[0-9]+[ \t]*$/);
  if (!match) return null;
  const base = match[1].trim();
  // No chained commands, second pipe, other redirects, or output-writing checks.
  if (/[|&<>;]/.test(base) || /(?:^|\s)--write(?:\s|$)/.test(base)) return null;
  if (!/^(?:npm(?:\.cmd)? (?:test|run)\b|npx(?:\.cmd)? )/.test(base)) return null;
  return base;
}
