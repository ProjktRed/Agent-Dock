import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emailToken, emailTokens, RemoteApprovals, signApproval, type ApprovalAction, type ApprovalRequest } from "../src/main/lib/remote-approvals";

const key = Buffer.alloc(32, 7);
const TOKEN = "123456789:" + "A".repeat(35);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

function setup({ chatId = "4242", email = true, valid = true } = {}) {
  const calls: { url: string; body: any }[] = [];
  const executed: [string, ApprovalAction, string][] = [];
  let updates: unknown[] = [], inbox: unknown[] = [];
  let clock = 1_000_000;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body });
    const json = String(url).endsWith("/sendMessage") ? { result: { message_id: 77 } } : String(url).endsWith("/getUpdates") ? { result: updates.splice(0) } : String(url).includes("/messages?") ? { messages: inbox.splice(0) } : {};
    return { ok: true, status: 200, json: async () => json } as Response;
  }) as typeof fetch;
  return mkdtemp(path.join(os.tmpdir(), "approvals-")).then((dir) => {
    dirs.push(dir);
    const approvals = new RemoteApprovals({
      key, file: path.join(dir, "remote-approvals.json"), fetchImpl, now: () => clock,
      channels: () => ({ telegram: { token: TOKEN, chatId }, email: email ? { apiKey: "am_key_0123456789", inbox: "bot@agentmail.to", to: ["me@example.com"] } : null }),
      stillValid: async () => valid,
      execute: async (r, action, via) => { executed.push([r.id, action, via]); return "done"; },
    });
    return { approvals, calls, executed, push: (u: unknown) => updates.push(u), mail: (m: unknown) => inbox.push(m), tick: (ms: number) => { clock += ms; } };
  });
}
const ask = { projectId: "p1", projectName: "Demo", title: "Needs your review", message: "Lint keeps failing", actions: ["resume", "stop"] as ApprovalAction[], target: "state:attention:T1:Lint" };

describe("signed remote approvals", () => {
  it("codes are bound to the request, action, target and expiry", () => {
    const r = { id: "0a1b2c3d", projectId: "p1", target: "plan:x", expiresAt: 5 };
    const code = signApproval(key, r, "approve-plan");
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    expect(signApproval(key, r, "approve-plan")).toBe(code);
    expect(signApproval(key, r, "dismiss-plan")).not.toBe(code);
    expect(signApproval(key, { ...r, target: "plan:y" }, "approve-plan")).not.toBe(code);
    expect(signApproval(key, { ...r, expiresAt: 6 }, "approve-plan")).not.toBe(code);
    expect(signApproval(Buffer.alloc(32, 8), r, "approve-plan")).not.toBe(code);
  });

  it("email replies count only the code typed above the quoted original", () => {
    const r = { id: "0a1b2c3d", projectId: "p1", target: "t", expiresAt: 5 } as ApprovalRequest;
    const yes = emailToken(r, "resume", key), no = emailToken(r, "stop", key);
    expect(emailTokens(`${yes.toLowerCase()}\n\nOn Mon, Agent Dock wrote:\n> ${yes}\n> ${no}`)).toEqual([{ id: "0a1b2c3d", action: "resume", code: yes.slice(-10) }]);
    expect(emailTokens(`> ${yes}\n> ${no}`)).toEqual([]);
    expect(emailTokens(`${yes}\n${no}`)).toHaveLength(2);
    expect(emailTokens("AD-0a1b2c3d-DELETE-ABCDEFGHJK")).toEqual([]);
  });

  it("sends buttons and reply lines once per situation; group chats get no buttons", async () => {
    const { approvals, calls } = await setup();
    const r = (await approvals.request(ask))!;
    const tg = calls.find((c) => c.url.endsWith("/sendMessage"))!;
    expect(tg.body.reply_markup.inline_keyboard[0].map((b: { text: string }) => b.text)).toEqual(["Resume", "Stop"]);
    expect(tg.body.reply_markup.inline_keyboard[0][0].callback_data).toBe(`${r.id}:resume:${signApproval(key, r, "resume")}`);
    const mail = calls.find((c) => c.url.endsWith("/messages/send"))!;
    expect(mail.body.to).toEqual(["me@example.com"]);
    expect(mail.body.text).toContain(emailToken(r, "resume", key));
    expect(r.telegramMessageId).toBe(77);
    expect(await approvals.request(ask)).toBeNull();
    const group = await setup({ chatId: "-100123", email: false });
    expect(await group.approvals.request(ask)).toBeNull();
    expect(group.calls).toHaveLength(0);
  });

  it("acts once, only with the right code, before expiry, and only while the situation holds", async () => {
    const { approvals, executed, tick } = await setup();
    const r = (await approvals.request(ask))!;
    expect(await approvals.answer(r.id, "resume", "AAAAAAAAAA", "telegram")).toBe("The code does not match.");
    expect(await approvals.answer(r.id, "elevate", signApproval(key, r, "resume"), "telegram")).toMatch(/not one of the choices/);
    expect(await approvals.answer(r.id, "resume", signApproval(key, r, "stop"), "telegram")).toBe("The code does not match.");
    expect(await approvals.answer(r.id, "resume", signApproval(key, r, "resume"), "telegram")).toBe("Resume: done");
    expect(await approvals.answer(r.id, "stop", signApproval(key, r, "stop"), "email")).toBe("Already answered: done");
    expect(executed).toEqual([[r.id, "resume", "telegram"]]);
    const second = (await approvals.request({ ...ask, target: "state:blocked:T2:x" }))!;
    tick(13 * 60 * 60_000);
    expect(await approvals.answer(second.id, "resume", signApproval(key, second, "resume"), "telegram")).toMatch(/expired/);
    const stale = await setup({ valid: false });
    const s = (await stale.approvals.request(ask))!;
    expect(await stale.approvals.answer(s.id, "resume", signApproval(key, s, "resume"), "telegram")).toMatch(/Nothing done: no longer needed/);
    expect(stale.executed).toEqual([]);
    const locked = await setup();
    const l = (await locked.approvals.request(ask))!;
    for (let i = 0; i < 4; i++) await locked.approvals.answer(l.id, "resume", "BBBBBBBBBB", "telegram");
    expect(await locked.approvals.answer(l.id, "resume", "BBBBBBBBBB", "telegram")).toMatch(/locked/);
    expect(await locked.approvals.answer(l.id, "resume", signApproval(key, l, "resume"), "telegram")).toMatch(/Already answered: locked/);
  });

  it("Telegram presses count only from your private chat; email replies only from your addresses", async () => {
    const { approvals, calls, executed, push, mail } = await setup();
    const r = (await approvals.request(ask))!;
    const data = `${r.id}:resume:${signApproval(key, r, "resume")}`;
    push({ update_id: 10, callback_query: { id: "q1", data, from: { id: 999 }, message: { message_id: 77, chat: { id: 4242 }, text: "x" } } });
    await approvals.pollTelegram(0);
    expect(executed).toEqual([]);
    expect(calls.find((c) => c.url.endsWith("/answerCallbackQuery"))!.body.text).toMatch(/Not accepted/);
    push({ update_id: 11, callback_query: { id: "q2", data, from: { id: 4242 }, message: { message_id: 77, chat: { id: 4242 }, text: "x" } } });
    await approvals.pollTelegram(0);
    expect(executed).toEqual([[r.id, "resume", "telegram"]]);
    expect(calls.filter((c) => c.url.endsWith("/getUpdates")).at(-1)!.body.offset).toBe(11);
    expect(calls.find((c) => c.url.endsWith("/editMessageText"))!.body.text).toContain("→ Resume: done");

    const e = await setup();
    const q = (await e.approvals.request(ask))!;
    e.mail({ message_id: "m1", from: "Mallory <evil@example.com>", subject: "Re", preview: emailToken(q, "stop", key) });
    e.mail({ message_id: "m2", from: "Me <me@example.com>", subject: "Re", preview: `${emailToken(q, "stop", key)}\n\nOn Mon wrote:\n> ${emailToken(q, "resume", key)}` });
    await e.approvals.pollEmail();
    expect(e.executed).toEqual([[q.id, "stop", "email"]]);
    const reply = e.calls.filter((c) => c.url.endsWith("/messages/send")).at(-1)!;
    expect(reply.body.to).toEqual(["me@example.com"]);
    expect(reply.body.text).toMatch(/^Stop: done/);
  });
});
