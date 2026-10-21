import path from "node:path";

// The window loads app://agent-dock/… instead of file://, so the GrantFileProtocolExtraPrivileges fuse
// can be off (0.38): pages on file:// get extra privileges (fetching any local file, for one). The
// handler serves only files inside the built renderer folder.

export const APP_SCHEME = "app";
export const APP_HOST = "agent-dock";
export const appUrl = (query: Record<string, string> = {}) => `${APP_SCHEME}://${APP_HOST}/index.html${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`;

/** The file an app:// URL names inside `root`, or null for another host, a path outside it, or a malformed URL. */
export function resolveAppPath(root: string, url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.hostname !== APP_HOST) return null;
  let rel: string;
  try { rel = decodeURIComponent(parsed.pathname); } catch { return null; }
  if (rel.includes("\0")) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, `.${rel === "/" ? "/index.html" : rel}`);
  return file === base || !file.startsWith(base + path.sep) ? null : file;
}
