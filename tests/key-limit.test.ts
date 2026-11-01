import { describe, expect, it } from "vitest";
import { isOpenRouter, openRouterKeyLimit } from "../src/main/lib/key-limit";

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("uncapped-key warning", () => {
  it("asks only OpenRouter, and warns only when it reports no limit", async () => {
    expect(isOpenRouter("https://openrouter.ai/api/v1/")).toBe(true);
    expect(isOpenRouter("https://api.openai.com/v1")).toBe(false);
    let seen: { url: string; auth: string | null } | null = null;
    const capture = (async (url: string, init: RequestInit) => { seen = { url, auth: new Headers(init.headers).get("authorization") }; return new Response(JSON.stringify({ data: { limit: null, usage: 3 } })); }) as unknown as typeof fetch;
    expect(await openRouterKeyLimit("sk-or-test", capture)).toBe("uncapped");
    expect(seen).toEqual({ url: "https://openrouter.ai/api/v1/key", auth: "Bearer sk-or-test" });
    expect(await openRouterKeyLimit("k", reply(200, { data: { limit: 5 } }))).toBe("capped");
    // Anything unclear is no reason to warn.
    expect(await openRouterKeyLimit("k", reply(401, { error: "bad key" }))).toBeNull();
    expect(await openRouterKeyLimit("k", reply(200, { data: {} }))).toBeNull();
    expect(await openRouterKeyLimit("k", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
});
