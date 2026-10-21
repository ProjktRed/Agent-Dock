import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readJson, writeJson } from "./json-file";

// Signed remote approvals (0.20.1). When a run waits for you (manual review, a block, a usage limit
// or a Supervisor plan proposal), the app can send the choices to Telegram (buttons) or email (one
// reply line). Every choice carries a code: an HMAC over the request, project, state, action and
// expiry, keyed by a secret that never leaves this machine. A code works once, for that action
// only, until it expires, and only while the state it was issued for still holds. The app must be
// running (it can sit in the tray); it re-checks everything before acting, exactly like a click.

export type ApprovalAction = "approve-plan" | "dismiss-plan" | "resume" | "elevate" | "resolve" | "retry-qa" | "stop";
export const ACTION_LABELS: Record<ApprovalAction, string> = {
  "approve-plan": "Approve", "dismiss-plan": "Dismiss", resume: "Resume", elevate: "Elevate", resolve: "Resolve block", "retry-qa": "Retry QA", stop: "Stop",
};
const TTL_MS = 12 * 60 * 60_000;
const MAX_WRONG = 5;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface ApprovalRequest {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  message: string;
  actions: ApprovalAction[];
  /** What the request is about (plan:<proposal id> or state:<runState>:<task>:<reason>); re-checked before acting. */
  target: string;
  createdAt: number;
  expiresAt: number;
  wrong?: number;
  usedAt?: number;
  result?: string;
  telegramMessageId?: number;
  emailed?: boolean;
}

export interface TelegramChannel { token: string; chatId: string }
export interface EmailChannel { apiKey: string; inbox: string; to: string[] }
interface Persisted { requests: ApprovalRequest[]; telegramOffset: number; seenEmail: string[] }

/** 10 characters from an HMAC-SHA256 over everything the code authorizes. */
export function signApproval(key: Buffer, r: Pick<ApprovalRequest, "id" | "projectId" | "target" | "expiresAt">, action: ApprovalAction): string {
  const mac = createHmac("sha256", key).update([r.id, r.projectId, r.target, action, r.expiresAt].join("|")).digest();
  let out = "";
  for (let i = 0; i < 10; i++) out += ALPHABET[mac[i] % 32];
  return out;
}

const TOKEN = /\bAD-([0-9A-F]{8})-([A-Z-]+?)-([A-Z2-9]{10})\b/g;
/** The reply's own text: everything before quoted history. */
export function replyText(text: string): string {
  const lines = String(text ?? "").split(/\r?\n/);
  const cut = lines.findIndex((l) => /^\s*>/.test(l) || /^On .+wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || /^From:\s/i.test(l.trim()));
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n");
}
/** Codes in an email reply; only one distinct code may appear before the quoted history. */
export function emailTokens(text: string): { id: string; action: ApprovalAction; code: string }[] {
  const found = new Map<string, { id: string; action: ApprovalAction; code: string }>();
  for (const m of replyText(text).toUpperCase().matchAll(TOKEN)) {
    const action = m[2].toLowerCase() as ApprovalAction;
    if (action in ACTION_LABELS) found.set(m[0], { id: m[1].toLowerCase(), action, code: m[3] });
  }
  return [...found.values()];
}
export const emailToken = (r: ApprovalRequest, action: ApprovalAction, key: Buffer) => `AD-${r.id}-${action.toUpperCase()}-${signApproval(key, r, action)}`;

export interface RemoteApprovalOptions {
  key: Buffer;
  file: string;
  channels: () => { telegram: TelegramChannel | null; email: EmailChannel | null };
  /** Carries out the action (same path as the app's buttons); returns a short result line. */
  execute: (r: ApprovalRequest, action: ApprovalAction, via: "telegram" | "email") => Promise<string>;
  /** Whether the request still matches the live state and the action is still possible. */
  stillValid: (r: ApprovalRequest, action: ApprovalAction) => Promise<boolean>;
  log?: (message: string) => void;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export class RemoteApprovals {
  private data: Persisted = { requests: [], telegramOffset: 0, seenEmail: [] };
  private loaded: Promise<void>;
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private now: () => number;
  private fetch: typeof fetch;
  constructor(private o: RemoteApprovalOptions) {
    this.now = o.now ?? Date.now;
    this.fetch = o.fetchImpl ?? fetch;
    this.loaded = readJson<Partial<Persisted>>(o.file, {}).then((d) => { this.data = { requests: [], telegramOffset: 0, seenEmail: [], ...d }; }).catch(() => undefined);
  }

  private save() {
    this.data.requests = this.data.requests.slice(-100);
    this.data.seenEmail = this.data.seenEmail.slice(-300);
    return writeJson(this.o.file, this.data).catch(() => undefined);
  }
  private open() {
    return this.data.requests.filter((r) => !r.usedAt && r.expiresAt > this.now());
  }
  get requests(): readonly ApprovalRequest[] {
    return this.data.requests;
  }

  /** Sends one request to Telegram and/or email; an open request for the same target is not repeated. */
  async request(input: Pick<ApprovalRequest, "projectId" | "projectName" | "title" | "message" | "actions" | "target">): Promise<ApprovalRequest | null> {
    await this.loaded;
    const { telegram, email } = this.o.channels();
    if ((!telegram || !privateChat(telegram)) && !email) return null;
    if (this.open().some((r) => r.projectId === input.projectId && r.target === input.target)) return null;
    const r: ApprovalRequest = { ...input, id: randomBytes(4).toString("hex"), createdAt: this.now(), expiresAt: this.now() + TTL_MS };
    this.data.requests.push(r);
    await this.save();
    const expires = new Date(r.expiresAt).toLocaleString("en-US");
    if (telegram && privateChat(telegram)) {
      try {
        const body = await this.telegram(telegram, "sendMessage", {
          chat_id: telegram.chatId, disable_web_page_preview: true,
          text: `${r.title} · ${r.projectName}\n${r.message}`.slice(0, 3500) + `\n\nSigned approval, works once until ${expires}.`,
          reply_markup: { inline_keyboard: [r.actions.map((a) => ({ text: ACTION_LABELS[a], callback_data: `${r.id}:${a}:${signApproval(this.o.key, r, a)}` }))] },
        });
        r.telegramMessageId = body?.result?.message_id;
      } catch (error) { this.o.log?.(`Telegram approval request failed: ${(error as Error).message}`); }
    }
    if (email) {
      const lines = r.actions.map((a) => `  ${emailToken(r, a, this.o.key)}    ${ACTION_LABELS[a]}`);
      try {
        await this.mail(email, `Agent Dock approval: ${r.title} · ${r.projectName} [${r.id}]`,
          `${r.message}\n\nTo answer, reply with exactly one of these lines as the first line of your reply:\n\n${lines.join("\n")}\n\nEach line is a signed code for that action only. It works once, until ${expires}, and only from ${email.to.join(", ")}. Agent Dock re-checks the run before acting; if the situation changed, nothing happens.`);
        r.emailed = true;
      } catch (error) { this.o.log?.(`Email approval request failed: ${(error as Error).message}`); }
    }
    await this.save();
    return r;
  }

  /** Verifies one answer and carries it out. Always returns a line to show the person who answered. */
  async answer(id: string, action: string, code: string, via: "telegram" | "email"): Promise<string> {
    await this.loaded;
    const r = this.data.requests.find((x) => x.id === id);
    if (!r) return "Unknown request.";
    if (r.usedAt) return `Already answered: ${r.result ?? "done"}`;
    if (r.expiresAt <= this.now()) return "This approval has expired. Open Agent Dock to decide.";
    if (!r.actions.includes(action as ApprovalAction)) return "That is not one of the choices for this request.";
    const expected = Buffer.from(signApproval(this.o.key, r, action as ApprovalAction)), got = Buffer.from(String(code));
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      r.wrong = (r.wrong ?? 0) + 1;
      if (r.wrong >= MAX_WRONG) Object.assign(r, { usedAt: this.now(), result: "locked after wrong codes" });
      await this.save();
      return r.usedAt ? "Too many wrong codes; this request is locked. Open Agent Dock to decide." : "The code does not match.";
    }
    // Marked used before acting, so a second tap or a resent email can never act twice.
    r.usedAt = this.now();
    if (!(await this.o.stillValid(r, action as ApprovalAction).catch(() => false))) {
      r.result = "no longer needed: the run has moved on";
      await this.save();
      return `Nothing done: ${r.result}.`;
    }
    try { r.result = await this.o.execute(r, action as ApprovalAction, via); }
    catch (error) { r.result = `failed: ${(error as Error).message}`; }
    await this.save();
    return `${ACTION_LABELS[action as ApprovalAction]}: ${r.result}`;
  }

  /** One Telegram long poll: button presses from your private chat only. */
  async pollTelegram(timeoutSeconds = 25): Promise<void> {
    await this.loaded;
    const { telegram } = this.o.channels();
    if (!telegram || !privateChat(telegram)) return;
    const body = await this.telegram(telegram, "getUpdates", { offset: this.data.telegramOffset, timeout: timeoutSeconds, allowed_updates: ["callback_query"] }, (timeoutSeconds + 10) * 1000);
    for (const update of body?.result ?? []) {
      this.data.telegramOffset = Math.max(this.data.telegramOffset, Number(update.update_id) + 1);
      const cq = update.callback_query;
      if (!cq) continue;
      const fromYou = String(cq.from?.id) === telegram.chatId && String(cq.message?.chat?.id) === telegram.chatId;
      const [id, action, code] = String(cq.data ?? "").split(":");
      const result = fromYou ? await this.answer(id, action, code, "telegram") : "Not accepted from this chat.";
      if (!fromYou) this.o.log?.(`Ignored a Telegram approval from ${cq.from?.id ?? "unknown"}`);
      await this.telegram(telegram, "answerCallbackQuery", { callback_query_id: cq.id, text: result.slice(0, 190) }).catch(() => undefined);
      if (fromYou && cq.message?.message_id) {
        await this.telegram(telegram, "editMessageText", { chat_id: telegram.chatId, message_id: cq.message.message_id, text: `${String(cq.message.text ?? "").slice(0, 3500)}\n\n→ ${result}`, disable_web_page_preview: true }).catch(() => undefined);
      }
    }
    await this.save();
  }

  /** Reads replies in the AgentMail inbox: only from your addresses, only one code before the quoted text. */
  async pollEmail(): Promise<void> {
    await this.loaded;
    const { email } = this.o.channels();
    const waiting = this.open().filter((r) => r.emailed);
    if (!email || !waiting.length) return;
    const after = new Date(Math.min(...waiting.map((r) => r.createdAt))).toISOString();
    const url = `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(email.inbox)}/messages?limit=50&after=${encodeURIComponent(after)}`;
    const response = await this.fetch(url, { headers: { authorization: `Bearer ${email.apiKey}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`AgentMail answered HTTP ${response.status}`);
    const list = ((await response.json()) as { messages?: { message_id: string; from?: string; subject?: string; preview?: string }[] }).messages ?? [];
    for (const m of list) {
      if (this.data.seenEmail.includes(m.message_id)) continue;
      this.data.seenEmail.push(m.message_id);
      const from = (String(m.from ?? "").match(/<([^>]+)>/)?.[1] ?? String(m.from ?? "")).trim().toLowerCase();
      if (!email.to.map((a) => a.toLowerCase()).includes(from)) continue;
      const tokens = emailTokens(m.preview ?? "");
      if (!tokens.length) continue;
      const result = tokens.length === 1 ? await this.answer(tokens[0].id, tokens[0].action, tokens[0].code, "email") : "More than one code in the reply; nothing done. Reply with exactly one line.";
      await this.mail({ ...email, to: [from] }, `Re: ${m.subject ?? "Agent Dock approval"}`, `${result}\n\n— Agent Dock`).catch(() => undefined);
    }
    await this.save();
  }

  /** Background polling while the app runs: Telegram continuously, email every minute when a request waits. */
  start() {
    if (this.running) return;
    this.running = true;
    const telegramLoop = async () => {
      while (this.running) {
        const { telegram } = this.o.channels();
        if (!telegram || !privateChat(telegram)) { await sleep(30_000); continue; }
        try { await this.pollTelegram(); } catch (error) { this.o.log?.(`Telegram poll failed: ${(error as Error).message}`); await sleep(30_000); }
      }
    };
    void telegramLoop();
    this.timers.push(setInterval(() => void this.pollEmail().catch((error) => this.o.log?.(`Email poll failed: ${(error as Error).message}`)), 60_000));
  }
  stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private async telegram(t: TelegramChannel, method: string, body: unknown, timeoutMs = 15_000) {
    const response = await this.fetch(`https://api.telegram.org/bot${t.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Telegram ${method} answered HTTP ${response.status}`);
    return (await response.json()) as { result?: any };
  }
  private async mail(e: EmailChannel, subject: string, text: string) {
    const response = await this.fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(e.inbox)}/messages/send`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${e.apiKey}` }, body: JSON.stringify({ to: e.to, subject: subject.slice(0, 200), text }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`AgentMail answered HTTP ${response.status}`);
  }
}

/** Approvals need a private chat with you: in a group anyone could press the buttons. */
export const privateChat = (t: TelegramChannel) => /^\d+$/.test(t.chatId);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
