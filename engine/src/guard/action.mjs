/**
 * Canonical calls are commands, edits, reads, inspections or unknown tools.
 * Adapters retain the native tool/input for rejection evidence and translate
 * protocol details (patch presence, command envelopes and read ranges) here.
 */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, out));
  return out;
}

export function parsePatchPaths(value, {requireBegin = false, trimPaths = false, existingOnly = false} = {}) {
  const text = strings(value).join('\n');
  if (requireBegin && !/\*\*\* Begin Patch/.test(text)) return null;
  const expression = existingOnly
    ? /^\*\*\* (?:Update File|Delete File): (.+)$/gm
    : trimPaths
      ? /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm
      : /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
  return [...text.matchAll(expression)].map(match => match[1]);
}

export function failedResult(value) {
  if (typeof value === 'string') {
    try { return failedResult(JSON.parse(value)); }
    catch { return /Editor operation failed|No replacement performed|text not found/i.test(value); }
  }
  if (Array.isArray(value)) return value.some(failedResult);
  return value?.success === false || value?.isError === true || Boolean(value?.error);
}
