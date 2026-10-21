// Uncapped-key warning: before a run, providers that can report a key's spending limit are asked for it.
// Only OpenRouter can today (GET /api/v1/key). The key goes only to the provider it belongs to.

export const isOpenRouter = (baseUrl: string) => /^https:\/\/openrouter\.ai\/api\/v1\/?$/i.test(String(baseUrl).trim());

/** "uncapped", "capped" or null when the provider did not answer clearly (never a reason to warn). */
export async function openRouterKeyLimit(key: string, fetchFn: typeof fetch = fetch, timeoutMs = 8000): Promise<"capped" | "uncapped" | null> {
  try {
    const r = await fetchFn("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const data = ((await r.json()) as { data?: { limit?: unknown } })?.data;
    if (!data || !("limit" in data)) return null;
    return data.limit === null ? "uncapped" : typeof data.limit === "number" ? "capped" : null;
  } catch { return null; }
}
