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

/** Codex's web search for one invocation: live for research roles when on, off otherwise. */
export const codexWebSearchArgs = (on) => ["-c", `web_search=${on ? '"live"' : '"disabled"'}`];
