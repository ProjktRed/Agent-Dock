import { diagnostic } from "./diagnostics.mjs";

// Remote notification channels the engine sends itself, so an unattended run reaches you even when
// the app is closed. The app passes them in AGENT_DOCK_NOTIFY (never on the command line: webhook
// URLs carry their own secret). Desktop notifications stay with the app.
let config = { project: "", webhook: null, discord: null, digests: true };
let send = (...args) => fetch(...args);
const pending = new Set();

/** Webhooks must be https (http only to this machine); Discord URLs must be Discord webhook URLs. */
export function checkChannelUrl(kind, value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error(`The ${kind} URL is not a valid URL`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`The ${kind} URL must use https`);
  if (kind === "discord" && (!/^(?:canary\.|ptb\.)?discord(?:app)?\.com$/.test(url.hostname) || !url.pathname.startsWith("/api/webhooks/"))) throw new Error("The Discord URL must be a Discord webhook URL (https://discord.com/api/webhooks/...)");
  return url.href;
}

export function useNotify(next = {}, { fetchImpl } = {}) {
  config = { project: "", webhook: null, discord: null, digests: true, ...next };
  config.webhook = checkChannelUrl("webhook", config.webhook);
  config.discord = checkChannelUrl("discord", config.discord);
  if (fetchImpl) send = fetchImpl;
}

export function notifyFromEnv(env = process.env) {
  if (!env.AGENT_DOCK_NOTIFY) return useNotify();
  let parsed;
  try { parsed = JSON.parse(env.AGENT_DOCK_NOTIFY); } catch { throw new Error("AGENT_DOCK_NOTIFY is not valid JSON"); }
  useNotify(parsed);
}

/** Sends one notification to every configured channel; failures are logged, never thrown. */
export function notify({ type, title, message }) {
  if (type === "supervisor-digest" && !config.digests) return;
  const at = new Date().toISOString(), text = String(message ?? "").slice(0, 1800);
  const posts = [];
  if (config.webhook) posts.push([config.webhook, { source: "agent-dock", project: config.project, type, title, message: text, at }]);
  if (config.discord) posts.push([config.discord, { content: `**${title}**${config.project ? ` · ${config.project}` : ""}\n${text}`.slice(0, 1990), allowed_mentions: { parse: [] } }]);
  for (const [url, body] of posts) {
    const request = Promise.resolve()
      .then(() => send(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }))
      .then((response) => { if (response && !response.ok) throw new Error(`HTTP ${response.status}`); })
      .catch((error) => diagnostic("NOTIFY_FAILED", { channel: url === config.discord ? "discord" : "webhook", message: error.message }))
      .finally(() => pending.delete(request));
    pending.add(request);
  }
}

/** Loop events worth a remote notification besides Supervisor alerts and digests. */
export function notifyEvent(event) {
  if (event.type === "run-limit") notify({ type: event.type, title: "Run limit reached", message: event.message });
  else if (event.type === "user-attention") notify({ type: event.type, title: "Needs your attention", message: String(event.qa ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "" });
  else if (event.type === "blocked") notify({ type: event.type, title: "Run blocked", message: String(event.qa ?? event.message ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "" });
}

/** Waits (briefly) for notifications still being sent, so the last one is not lost when the engine exits. */
export async function flushNotifications() {
  await Promise.allSettled([...pending]);
}
