// Activity and live state are read by the app on every poll: no single text in them may be huge.

/** A long text cut to its start and end, saying how much was left out. */
export function clipText(text, max) {
  if (typeof text !== "string" || text.length <= max) return text;
  const half = Math.floor((max - 60) / 2);
  return `${text.slice(0, half)}\n... ${text.length - 2 * half} characters left out ...\n${text.slice(-half)}`;
}

/** The value with every string in it (inside objects and arrays too) clipped to max characters. */
export function clipDeep(value, max) {
  if (typeof value === "string") return clipText(value, max);
  if (Array.isArray(value)) return value.map((item) => clipDeep(item, max));
  if (value && typeof value === "object" && value.constructor === Object) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipDeep(item, max)]));
  return value;
}
