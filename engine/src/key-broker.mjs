import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";

/**
 * Provider key broker: Cline and OpenCode on a cloud provider talk to this engine on 127.0.0.1 with a token
 * made for the run, and the engine adds the real API key on the way to the provider. No worker process, nor
 * anything a worker starts, ever holds the key: its environment, config files and command line carry only the
 * token, which works nowhere but here and dies with the engine.
 *
 * Only the configured provider's address (below its base path) is reachable, with GET and POST; requests over
 * 16 MB are refused. Streaming responses pass through as they arrive.
 */
const REQUEST_LIMIT = 16 * 1024 * 1024;
const FORWARD_REQUEST = ["content-type", "accept", "user-agent", "http-referer", "x-title", "openai-beta"];
const FORWARD_RESPONSE = ["content-type", "cache-control", "x-request-id", "retry-after"];

const pick = (headers, names) => Object.fromEntries(names.filter((n) => headers[n] !== undefined && headers[n] !== null).map((n) => [n, headers[n]]));

function send(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `Agent Dock key broker: ${message}` } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > REQUEST_LIMIT) { reject(Object.assign(new Error("request too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Starts the broker for one provider; resolves with { url (…/v1, for the worker), token, close }. */
export async function startKeyBroker({ upstream, apiKey, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error("The key broker needs the provider's API key");
  const base = new URL(`${String(upstream).replace(/\/+$/, "")}/`);
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (header) => {
    const given = Buffer.from(String(header ?? ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req.headers.authorization)) return send(res, 401, "this token is not valid here");
      if (req.method !== "GET" && req.method !== "POST") return send(res, 405, `${req.method} is not forwarded`);
      const incoming = new URL(req.url ?? "/", "http://127.0.0.1");
      if (incoming.pathname !== "/v1" && !incoming.pathname.startsWith("/v1/")) return send(res, 404, "only /v1/… is forwarded");
      const target = new URL(`${incoming.pathname.slice(4).replace(/^\/+/, "")}${incoming.search}`, base);
      // ".." and the like resolve before this check: the key goes only to the provider, below its base path.
      if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return send(res, 400, "that address is outside the provider");
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const controller = new AbortController();
      res.on("close", () => { if (!res.writableFinished) controller.abort(); });
      const response = await fetchImpl(target, { method: req.method, headers: { ...pick(req.headers, FORWARD_REQUEST), authorization: `Bearer ${apiKey}` }, body, signal: controller.signal });
      res.writeHead(response.status, pick(Object.fromEntries(response.headers), FORWARD_RESPONSE));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 502, error.status ? error.message : "the provider could not be reached");
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  server.unref();
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, token, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
