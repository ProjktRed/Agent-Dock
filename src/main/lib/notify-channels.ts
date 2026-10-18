/** Same rules as the engine (engine/src/notify.mjs checkChannelUrl): https only (http only to this machine). */
export function checkChannelUrl(kind: "webhook" | "discord", value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(`The ${kind} URL is not a valid URL`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`The ${kind} URL must use https`);
  if (kind === "discord" && (!/^(?:canary\.|ptb\.)?discord(?:app)?\.com$/.test(url.hostname) || !url.pathname.startsWith("/api/webhooks/"))) {
    throw new Error("The Discord URL must be a Discord webhook URL (https://discord.com/api/webhooks/...)");
  }
  return url.href;
}

/** The body each channel expects; the engine sends the same shapes. */
export function channelBody(kind: "webhook" | "discord", project: string, type: string, title: string, message: string) {
  return kind === "discord"
    ? { content: `**${title}**${project ? ` · ${project}` : ""}\n${message}`.slice(0, 1990), allowed_mentions: { parse: [] } }
    : { source: "agent-dock", project, type, title, message, at: new Date().toISOString() };
}
