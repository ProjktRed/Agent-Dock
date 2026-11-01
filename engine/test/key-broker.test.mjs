import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startKeyBroker } from "../src/key-broker.mjs";
import { brokeredProviderKeys, brokerProviderKey, createProviderDescriptor, resetKeyBrokers } from "../src/runtime/provider.mjs";
import { childEnv } from "../src/parallel-run.mjs";

/** A stand-in provider: records each request, streams /chat/completions in two parts. */
async function fakeProvider() {
  const seen = [];
  let release;
  const second = new Promise((resolve) => (release = resolve));
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    if (req.url.endsWith("/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      await second;
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, release, base: `http://127.0.0.1:${server.address().port}/api/v1`, close: () => server.close() };
}

const call = (broker, path, { token = broker.token, method = "GET", body } = {}) =>
  fetch(`${broker.url.replace(/\/v1$/, "")}${path}`, { method, body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });

test("the broker adds the real key on the way to the provider; a worker's token works only here", async () => {
  const provider = await fakeProvider();
  const broker = await startKeyBroker({ upstream: provider.base, apiKey: "sk-real-key" });
  try {
    const ok = await call(broker, "/v1/models?x=1");
    assert.equal(ok.status, 200);
    assert.deepEqual(provider.seen.at(-1), { method: "GET", url: "/api/v1/models?x=1", authorization: "Bearer sk-real-key", body: "" });
    for (const token of ["wrong", "", `${broker.token}x`]) assert.equal((await call(broker, "/v1/models", { token })).status, 401);
    assert.equal(provider.seen.length, 1, "refused requests never reach the provider");
    assert.equal((await call(broker, "/v1/models", { method: "PUT" })).status, 405);
    assert.equal((await call(broker, "/other")).status, 404);
    for (const path of ["/v1/../../admin", "/v1/%2e%2e/%2e%2e/admin", "/v1//evil.example/x"]) {
      const before = provider.seen.length;
      const res = await call(broker, path);
      // Refused, or forwarded below the provider's base path: never anywhere else with the key.
      if (res.status === 200) assert.ok(provider.seen.at(-1).url.startsWith("/api/v1/"), path);
      else assert.equal(provider.seen.length, before, path);
    }
    const big = await call(broker, "/v1/chat/completions", { method: "POST", body: "x".repeat(17 * 1024 * 1024) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
  } finally { await broker.close(); provider.close(); }
});

test("streaming answers pass through as they arrive", async () => {
  const provider = await fakeProvider();
  const broker = await startKeyBroker({ upstream: provider.base, apiKey: "sk-real-key" });
  try {
    const res = await call(broker, "/v1/chat/completions", { method: "POST", body: JSON.stringify({ stream: true }) });
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /data: first/, "the first part arrives before the provider finished");
    provider.release();
    let rest = "";
    for (let part = await reader.read(); !part.done; part = await reader.read()) rest += new TextDecoder().decode(part.value);
    assert.match(rest, /\[DONE\]/);
    assert.equal(provider.seen.at(-1).body, JSON.stringify({ stream: true }));
  } finally { await broker.close(); provider.close(); }
});

test("the engine's environment, which workers inherit, holds the token instead of the key; task engines get the key back", async () => {
  const env = { AGENT_DOCK_PROVIDER_KEY: "sk-real-key", OPENROUTER_API_KEY: "sk-real-key", OTHER: "x" };
  try {
    const broker = await brokerProviderKey({ provider: "openrouter", providerApiKeyEnv: "AGENT_DOCK_PROVIDER_KEY", env });
    assert.equal(env.AGENT_DOCK_PROVIDER_KEY, broker.token);
    assert.equal(env.OPENROUTER_API_KEY, broker.token);
    assert.ok(!Object.values(env).includes("sk-real-key"));
    assert.equal(broker.upstream, "https://openrouter.ai/api/v1");
    const descriptor = createProviderDescriptor({ provider: "openrouter", model: "m", broker, env });
    assert.equal(descriptor.baseUrl, broker.url);
    assert.equal(descriptor.upstreamUrl, "https://openrouter.ai/api/v1");
    // Asked again (a lazy worker set up later), the same broker, still behind the same key.
    assert.equal((await brokerProviderKey({ provider: "openrouter", env })).token, broker.token);
    assert.deepEqual(brokeredProviderKeys(), { AGENT_DOCK_PROVIDER_KEY: "sk-real-key" });
    assert.equal(childEnv(env, null).AGENT_DOCK_PROVIDER_KEY, "sk-real-key");
    assert.equal(await brokerProviderKey({ provider: "openrouter", providerApiKeyEnv: "NO_SUCH_KEY", env: {} }), null);
  } finally { resetKeyBrokers(); }
});

test("preflight asks the provider itself with the real key, not the broker", async () => {
  const requests = [];
  const descriptor = createProviderDescriptor({
    provider: "openai", model: "m", providerBaseUrl: "https://llm.example/v1",
    broker: { url: "http://127.0.0.1:9/v1", token: "t", apiKey: "sk-real-key" }, env: { AGENT_DOCK_PROVIDER_KEY: "t" },
    fetchImpl: async (url, options) => { requests.push({ url, auth: options.headers.authorization }); return { ok: true, json: async () => ({ data: [{ id: "m" }] }) }; },
  });
  const identity = await descriptor.preflight();
  assert.deepEqual(requests, [{ url: "https://llm.example/v1/models", auth: "Bearer sk-real-key" }]);
  assert.equal(identity.baseUrl, "https://llm.example/v1");
});
