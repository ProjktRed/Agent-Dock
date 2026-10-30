import dns from "node:dns/promises";

/**
 * Settings › Execution & safety › Web access for agents (--web-access true): Codex's live web search and Claude
 * Code's WebSearch and WebFetch, for Implementation and Assessment. QA never gets them (it verifies, it does not
 * research). The search and fetch run inside the agent CLI, not as shell commands, so the sandbox for agents'
 * commands still blocks network for everything they run. Off, Codex's own default (cached search) is turned off too.
 */
let enabled = false;
export function useWebAccess(on) { enabled = on === true; }
export const webAccess = () => enabled;

/** Claude Code's web tools. */
export const CLAUDE_WEB_TOOLS = Object.freeze(["WebSearch", "WebFetch"]);

// Names that stay on your machine or network: localhost, single-label names and the local-only suffixes.
const LOCAL_NAME = /^(?:[^.]+|localhost|.+\.(?:localhost|local|internal|lan|home\.arpa))$/i;

/**
 * Why the guard refuses this web address, or null (guard plan stage 10, until Agent Dock fetches pages itself).
 * Web addresses only, no user name or password in them, no IP address (the URL parser already turns forms like
 * 2130706433 or 0x7f.1 into dotted ones) and no local name. This narrows what a fetch can reach; it is no
 * exfiltration boundary, since allowed sites can host anyone's pages.
 */
export function webAddressProblem(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return "it is not a web address"; }
  if (!/^https?:$/.test(parsed.protocol)) return "only http and https addresses are allowed";
  if (parsed.username || parsed.password) return "the address carries a user name or password";
  const host = parsed.hostname.replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return "the address is an IP address, not a site name";
  if (LOCAL_NAME.test(host)) return "the address names this computer or the local network";
  return null;
}

// Addresses that aren't on the public internet: this computer, private and shared networks, link-local (cloud
// metadata), unspecified, and IPv6 unique-local; IPv4 inside IPv6 (::ffff:a.b.c.d) is checked as IPv4.
function privateAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) address = mapped[1];
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * Why a name that passed webAddressProblem still stays off the public web: it resolves (now) to a private address,
 * as names like 127.0.0.1.nip.io do. The CLI resolves the name again when it fetches, so a name that changes its
 * answer in between still gets through: this narrows the reach, it is no boundary. A name that doesn't resolve is
 * refused too (the fetch would fail anyway).
 */
export async function webAddressResolvesPrivate(url, { lookup = dns.lookup, timeoutMs = 3000 } = {}) {
  const host = new URL(String(url)).hostname.replace(/\.$/, "");
  let timer;
  const answers = await Promise.race([
    lookup(host, { all: true, verbatim: true }).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
  if (!answers?.length) return "the site name does not resolve";
  return answers.some((a) => privateAddress(a.address)) ? "the site name points to this computer or a private network" : null;
}

/** Codex's web search for one invocation: live for research roles when on, off otherwise. */
export const codexWebSearchArgs = (on) => ["-c", `web_search=${on ? '"live"' : '"disabled"'}`];
