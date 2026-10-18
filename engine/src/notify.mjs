import { diagnostic } from "./diagnostics.mjs";

// Remote notification channels the engine sends itself, so an unattended run reaches you even when
// the app is closed. The app passes them in AGENT_DOCK_NOTIFY (never on the command line: webhook
// URLs, bot tokens and API keys are secrets). Desktop notifications stay with the app, which also
// uses checkChannel/sendChannel from here so the rules and message shapes exist once.
export const CHANNELS = ["webhook", "discord", "slack", "telegram", "email"];
/** Email is for what needs you; it never gets routine alerts or periodic digests. */
const EMAIL_TYPES = new Set(["user-attention", "blocked", "run-limit", "waiting-for-codex", "plan-proposal", "test", "approval"]);
const EMPTY = { project: "", webhook: null, discord: null, slack: null, telegram: null, email: null, digests: true };
let config = { ...EMPTY };
let send = (...args) => fetch(...args);
const pending = new Set();

/** Webhooks must be https (http only to this machine); Discord and Slack URLs must be their webhook URLs. */
export function checkChannelUrl(kind, value) {
  if (!value) return null;
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error(`The ${kind} URL is not a valid URL`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`The ${kind} URL must use https`);
  if (kind === "discord" && (!/^(?:canary\.|ptb\.)?discord(?:app)?\.com$/.test(url.hostname) || !url.pathname.startsWith("/api/webhooks/"))) throw new Error("The Discord URL must be a Discord webhook URL (https://discord.com/api/webhooks/...)");
  if (kind === "slack" && (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || !url.pathname.startsWith("/services/"))) throw new Error("The Slack URL must be a Slack incoming webhook URL (https://hooks.slack.com/services/...)");
  return url.href;
}

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/**
 * Validates and normalizes one channel's settings. URL channels take a string; telegram takes
 * { token, chatId }; email (AgentMail) takes { apiKey, inbox, to } where to is up to 5 addresses.
 */
export function checkChannel(kind, value) {
  if (value === null || value === undefined || value === "") return null;
  if (["webhook", "discord", "slack"].includes(kind)) return checkChannelUrl(kind, value);
  if (kind === "telegram") {
    const token = String(value?.token ?? "").trim(), chatId = String(value?.chatId ?? "").trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error("The Telegram bot token looks wrong (from @BotFather: 123456789:ABC…)");
    if (!/^-?\d{1,20}$/.test(chatId)) throw new Error("The Telegram chat ID must be a number (your user or group ID)");
    return { token, chatId };
  }
  if (kind === "email") {
    const apiKey = String(value?.apiKey ?? "").trim(), inbox = String(value?.inbox ?? "").trim().toLowerCase();
    const to = (Array.isArray(value?.to) ? value.to : String(value?.to ?? "").split(/[,;\s]+/)).map((a) => String(a).trim()).filter(Boolean);
    if (apiKey.length < 10 || /\s/.test(apiKey)) throw new Error("The AgentMail API key is missing");
    if (!EMAIL.test(inbox)) throw new Error("The sending inbox must be an email address (your AgentMail inbox)");
    if (!to.length || to.length > 5 || !to.every((a) => EMAIL.test(a))) throw new Error("Send to 1–5 valid email addresses");
    return { apiKey, inbox, to };
  }
  throw new Error(`Unknown notification channel: ${kind}`);
}

/** The HTTP request one channel needs for one notification: [url, fetch init]. */
export function channelRequest(kind, value, { project = "", type, title, message, at = new Date().toISOString() }) {
  const text = String(message ?? "").slice(0, 1800), head = `${title}${project ? ` · ${project}` : ""}`;
  const json = (url, body, headers = {}) => [url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }];
  if (kind === "webhook") return json(value, { source: "agent-dock", project, type, title, message: text, at });
  if (kind === "discord") return json(value, { content: `**${title}**${project ? ` · ${project}` : ""}\n${text}`.slice(0, 1990), allowed_mentions: { parse: [] } });
  if (kind === "slack") return json(value, { text: `*${head}*\n${text}`.slice(0, 3000), unfurl_links: false });
  if (kind === "telegram") return json(`https://api.telegram.org/bot${value.token}/sendMessage`, { chat_id: value.chatId, text: `${head}\n${text}`.slice(0, 4000), disable_web_page_preview: true });
  if (kind === "email") return json(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(value.inbox)}/messages/send`,
    { to: value.to, subject: `Agent Dock: ${head}`.slice(0, 200), text: `${text}\n\n— Agent Dock${project ? ` (${project})` : ""}, ${at}` }, { authorization: `Bearer ${value.apiKey}` });
  throw new Error(`Unknown notification channel: ${kind}`);
}

/** Sends one request and throws on failure (the app's "Send test" uses this). */
export async function sendChannel(kind, value, note, fetchImpl = send) {
  const [url, init] = channelRequest(kind, value, note);
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (response && !response.ok) throw new Error(`${kind} answered HTTP ${response.status}`);
  return response;
}

export function useNotify(next = {}, { fetchImpl } = {}) {
  config = { ...EMPTY, ...next };
  for (const kind of CHANNELS) config[kind] = checkChannel(kind, config[kind]);
  if (fetchImpl) send = fetchImpl;
}

export function notifyFromEnv(env = process.env) {
  if (!env.AGENT_DOCK_NOTIFY) return useNotify();
  let parsed;
  try { parsed = JSON.parse(env.AGENT_DOCK_NOTIFY); } catch { throw new Error("AGENT_DOCK_NOTIFY is not valid JSON"); }
  useNotify(parsed);
}

/**
 * Sends one notification to every configured channel; failures are logged, never thrown.
 * urgent marks something that needs you (a Supervisor alert that paused or stopped the run): it also goes to email.
 */
export function notify({ type, title, message, urgent = false }) {
  if (type === "supervisor-digest" && !config.digests) return;
  const note = { project: config.project, type, title, message, at: new Date().toISOString() };
  for (const kind of CHANNELS) {
    if (!config[kind] || (kind === "email" && !urgent && !EMAIL_TYPES.has(type))) continue;
    const request = sendChannel(kind, config[kind], note)
      .catch((error) => diagnostic("NOTIFY_FAILED", { channel: kind, message: error.message }))
      .finally(() => pending.delete(request));
    pending.add(request);
  }
}

/** Loop events worth a remote notification besides Supervisor alerts and digests. */
export function notifyEvent(event) {
  if (event.type === "run-limit") notify({ type: event.type, title: "Run limit reached", message: event.message });
  else if (event.type === "user-attention") notify({ type: event.type, title: "Needs your attention", message: String(event.qa ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "" });
  else if (event.type === "waiting-for-codex") notify({ type: event.type, title: "Waiting: usage limit", message: `${String(event.qa ?? event.message ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "The orchestrator hit its usage limit."} The run continues after Resume.` });
  else if (event.type === "blocked") notify({ type: event.type, title: "Run blocked", message: String(event.qa ?? event.message ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "" });
}

/** Waits (briefly) for notifications still being sent, so the last one is not lost when the engine exits. */
export async function flushNotifications() {
  await Promise.allSettled([...pending]);
}
