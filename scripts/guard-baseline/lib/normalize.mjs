// Determinism for the recorded baseline. Two kinds of substitution, deliberately separate:
//
//   * Path tokens ({REPO}/{RUN}/{WS}/{STATE}/{PROBE}) are *reversible*. Recorded policy snapshots
//     and recorded step inputs are denormalized again by replay.mjs against its own throwaway
//     directories, so a recording stays replayable anywhere.
//   * Volatile scalars (timestamps, UUIDs, ports, PIDs, durations) are one-way. They never appear
//     in anything replay has to feed back in.
//
// Nothing else is touched: no key sorting of artifact text, no whitespace fixing, no field
// dropping. A genuine key-order or formatting change must still surface as a diff.

import path from "node:path";

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Both separator spellings of a path, plus its file:// URL form. */
function variants(absolute) {
  const posix = absolute.replaceAll("\\", "/");
  const windows = absolute.replaceAll("/", "\\");
  const url = "file://" + (posix.startsWith("/") ? posix : "/" + posix);
  const encoded = encodeURI(url);
  return [...new Set([absolute, posix, windows, url, encoded])];
}

/**
 * tokens: { REPO, RUN, WS, STATE, PROBE, ... } → absolute paths. Longest path first so a nested
 * directory (state inside run) wins over its parent.
 */
export function makeNormalizer({ tokens, volatile = {} }) {
  const entries = Object.entries(tokens)
    .filter(([, value]) => typeof value === "string" && value)
    .map(([name, value]) => ({ name, absolute: path.resolve(value) }))
    .sort((a, b) => b.absolute.length - a.absolute.length);

  const pathRules = entries.flatMap(({ name, absolute }) =>
    variants(absolute).map((form) => ({
      // A file:// form must map to a file:// token so the URL stays a URL.
      token: form.startsWith("file://") ? `file://{${name}}` : `{${name}}`,
      pattern: new RegExp(escape(form), "g"),
    })));

  const reverseRules = entries.flatMap(({ name, absolute }) => [
    { pattern: new RegExp(escape(`file://{${name}}`), "g"), value: "file://" + (absolute.replaceAll("\\", "/").startsWith("/") ? absolute.replaceAll("\\", "/") : "/" + absolute.replaceAll("\\", "/")) },
    { pattern: new RegExp(escape(`{${name}}`), "g"), value: absolute },
  ]);

  const volatileRules = [
    { pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, value: "{TS}" },
    // Cline's own system prompt states the wall-clock day as M/D/YYYY ("2. Date: 10/12/2026"), so a
    // Tier B recording made on one day would otherwise differ from one made the next.
    { pattern: /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, value: "{DATE}" },
    { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, value: "{UUID}" },
    ...(volatile.ports ?? []).map((port) => ({ pattern: new RegExp(`:${port}\\b`, "g"), value: ":{PORT}" })),
    { pattern: /("pid"\s*:\s*)\d+/g, value: "$1{PID}" },
    { pattern: /("durationMs"\s*:\s*)\d+/g, value: "$1{MS}" },
    { pattern: /\bconv_\d+_[a-z0-9]+/g, value: "conv_{ID}" },
    { pattern: /\bagent_\{UUID\}/g, value: "agent_{UUID}" },
  ];

  const normalizeText = (text) => {
    let out = String(text);
    for (const { pattern, token } of pathRules) out = out.replace(pattern, token);
    for (const { pattern, value } of volatileRules) out = out.replace(pattern, value);
    return out;
  };

  /** Path tokens only — used on recorded step inputs, whose volatile scalars are already fixed. */
  const normalizePathsOnly = (text) => {
    let out = String(text);
    for (const { pattern, token } of pathRules) out = out.replace(pattern, token);
    return out;
  };

  const denormalizeText = (text) => {
    let out = String(text);
    for (const { pattern, value } of reverseRules) out = out.replace(pattern, value);
    return out;
  };

  const through = (value, fn) => (value === undefined ? undefined : JSON.parse(fn(JSON.stringify(value))));

  return {
    text: normalizeText,
    pathsOnly: normalizePathsOnly,
    denormalizeText,
    /** Normalize a JSON-able value (paths + volatile scalars). */
    value: (value) => through(value, normalizeText),
    /** Normalize a JSON-able value, path tokens only. */
    valuePaths: (value) => through(value, normalizePathsOnly),
    /** Turn a recorded value back into something the guard can be fed on this machine. */
    denormalize: (value) => through(value, denormalizeText),
  };
}

/** Deterministic JSON for policy snapshots: keys sorted, so only genuine value drift diffs. */
export function sortedJson(value, space = 0) {
  const sort = (node) => {
    if (Array.isArray(node)) return node.map(sort);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.keys(node).sort().map((key) => [key, sort(node[key])]));
    }
    return node;
  };
  return JSON.stringify(sort(value), null, space);
}
