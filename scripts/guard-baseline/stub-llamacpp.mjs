#!/usr/bin/env node
// A llama.cpp-compatible OpenAI-style server whose chat completions are scripted
// from a scenario file, so a real Cline process performs a fixed sequence of tool
// calls. Only the endpoints the engine (engine/src/cline-runtime-config.mjs) and
// Cline actually reach are implemented; everything else is logged and 404s.
import http from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const FIXED_METRICS = {
  "prompt_tokens_total": 1234,
  "prompt_seconds_total": 1.5,
  "tokens_predicted_total": 567,
  "tokens_predicted_seconds_total": 3.25,
};

const json = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
};

/** A chat request with no tools is Cline housekeeping (title, summary, compaction): never scripted. */
const isAuxiliary = (body) => !Array.isArray(body?.tools) || body.tools.length === 0;

function requestDigest(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const names = tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean);
  const runCommands = tools.find((tool) => (tool?.function?.name ?? tool?.name) === "run_commands");
  const schema = runCommands?.function?.parameters ?? runCommands?.parameters ?? null;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return {
    model: body?.model ?? null,
    stream: Boolean(body?.stream),
    auxiliary: isAuxiliary(body),
    toolNames: [...names].sort(),
    toolChoice: body?.tool_choice ?? null,
    messageRoles: messages.map((message) => message?.role ?? null),
    runCommandsEnum: Array.isArray(schema?.properties?.commands?.items?.enum)
      ? [...schema.properties.commands.items.enum].sort()
      : null,
    runCommandsSchemaKeys: schema ? Object.keys(schema.properties ?? {}).sort() : null,
  };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  return "";
}

/** Tool results Cline sent back, so a baseline can show what the guard replied to the model. */
function toolResultsOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const results = [];
  for (const message of messages) {
    if (message?.role === "tool") results.push({ toolCallId: message.tool_call_id ?? null, text: textFromContent(message.content) });
  }
  return results;
}

function toolCallsOf(turn, scenarioName, index) {
  return (turn.toolCalls ?? []).map((call, position) => ({
    id: `call_${scenarioName}_${index}_${position}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
  }));
}

function completionBody(model, id, turn, toolCalls) {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: turn.content ?? "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? "tool_calls" : (turn.finish ?? "stop"),
      logprobs: null,
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

function streamChunks(model, id, turn, toolCalls, includeUsage) {
  const frame = (delta, finish = null) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...(includeUsage ? { usage: null } : {}),
  });
  const chunks = [frame({ role: "assistant", content: "" })];
  if (turn.content) chunks.push(frame({ content: turn.content }));
  toolCalls.forEach((call, index) => {
    chunks.push(frame({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }));
    chunks.push(frame({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }));
  });
  chunks.push(frame({}, toolCalls.length ? "tool_calls" : (turn.finish ?? "stop")));
  if (includeUsage) {
    chunks.push({ id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  }
  return chunks;
}

export async function startStub({ port = 0, scenario, logPath = null, contextTokens = 131_072 }) {
  const model = scenario.model ?? "stub-model";
  const turns = scenario.turns ?? [];
  const requests = [];
  let scriptedIndex = 0;
  let sequence = 0;

  const record = async (entry) => {
    requests.push(entry);
    if (logPath) {
      await mkdir(path.dirname(logPath), { recursive: true });
      await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
    }
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch { body = { unparsed: raw.slice(0, 2_000) }; } }
      const url = new URL(request.url, "http://127.0.0.1");
      const route = url.pathname.replace(/^\/v1(?=\/|$)/, "");
      const seq = ++sequence;

      try {
        if (request.method === "GET" && route === "/health") {
          await record({ seq, method: "GET", route: url.pathname, body: null });
          return json(response, 200, { status: "ok" });
        }
        if (request.method === "GET" && route === "/props") {
          await record({ seq, method: "GET", route: url.pathname, query: Object.fromEntries(url.searchParams), body: null });
          return json(response, 200, {
            default_generation_settings: { n_ctx: contextTokens, params: { n_predict: -1 } },
            n_ctx: contextTokens,
            total_slots: 1,
            model_path: "/stub/model.gguf",
            chat_template: "",
            build_info: "stub",
          });
        }
        if (request.method === "GET" && route === "/metrics") {
          await record({ seq, method: "GET", route: url.pathname, body: null });
          const text = Object.entries(FIXED_METRICS).map(([key, value]) => `llamacpp:${key} ${value}`).join("\n") + "\n";
          response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
          return response.end(text);
        }
        if (request.method === "GET" && (route === "/models" || route === "/model")) {
          await record({ seq, method: "GET", route: url.pathname, body: null });
          return json(response, 200, { object: "list", data: [{ id: model, object: "model", created: 0, owned_by: "llamacpp", meta: { n_ctx_train: contextTokens } }] });
        }
        if (request.method === "GET" && route === "/slots") {
          await record({ seq, method: "GET", route: url.pathname, body: null });
          return json(response, 200, [{ id: 0, n_ctx: contextTokens, is_processing: false }]);
        }
        if (request.method === "POST" && (route === "/tokenize" || route === "/detokenize" || route === "/apply-template" || route === "/embeddings")) {
          await record({ seq, method: "POST", route: url.pathname, body: { keys: Object.keys(body ?? {}) } });
          if (route === "/tokenize") return json(response, 200, { tokens: [1, 2, 3] });
          if (route === "/detokenize") return json(response, 200, { content: "" });
          if (route === "/apply-template") return json(response, 200, { prompt: "" });
          return json(response, 200, { object: "list", data: [{ object: "embedding", index: 0, embedding: [0, 0, 0] }] });
        }
        if (request.method === "POST" && (route === "/chat/completions" || route === "/completions" || route === "/completion")) {
          const auxiliary = isAuxiliary(body);
          const index = auxiliary ? -1 : Math.min(scriptedIndex, turns.length - 1);
          const turn = auxiliary ? { content: scenario.auxiliaryReply ?? "ok", finish: "stop" } : (turns[index] ?? { content: "", finish: "stop" });
          if (!auxiliary) scriptedIndex += 1;
          await record({
            seq,
            method: "POST",
            route: url.pathname,
            scriptedTurn: auxiliary ? null : index,
            digest: requestDigest(body),
            toolResults: toolResultsOf(body),
            body: { messages: (body?.messages ?? []).map((message) => ({ role: message?.role ?? null, text: textFromContent(message?.content), toolCalls: (message?.tool_calls ?? []).map((call) => ({ name: call?.function?.name, arguments: call?.function?.arguments })) })), tools: requestDigest(body).toolNames },
          });
          const id = `chatcmpl-stub-${seq}`;
          const toolCalls = auxiliary ? [] : toolCallsOf(turn, scenario.name ?? "s", index);
          if (body?.stream) {
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
            for (const chunk of streamChunks(model, id, turn, toolCalls, Boolean(body?.stream_options?.include_usage))) {
              response.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            response.write("data: [DONE]\n\n");
            return response.end();
          }
          return json(response, 200, completionBody(model, id, turn, toolCalls));
        }
        await record({ seq, method: request.method, route: url.pathname, unhandled: true, body: body ? { keys: Object.keys(body) } : null });
        return json(response, 404, { error: { message: `stub: unhandled ${request.method} ${url.pathname}`, type: "not_found" } });
      } catch (error) {
        return json(response, 500, { error: { message: `stub failure: ${error.message}` } });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    scriptedTurnsUsed: () => scriptedIndex,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = {};
  for (let i = 2; i < process.argv.length; i += 2) flags[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  if (!flags.scenario) {
    console.error("Usage: node stub-llamacpp.mjs --scenario <file.json> [--port 8099] [--log requests.jsonl]");
    process.exit(64);
  }
  const scenario = JSON.parse(await readFile(path.resolve(flags.scenario), "utf8"));
  const stub = await startStub({
    port: Number(flags.port ?? 8099),
    scenario,
    logPath: flags.log ? path.resolve(flags.log) : null,
    ...(flags["context-tokens"] ? { contextTokens: Number(flags["context-tokens"]) } : {}),
  });
  console.log(JSON.stringify({ ready: true, port: stub.port, baseUrl: stub.baseUrl, scenario: scenario.name, model: scenario.model ?? "stub-model" }));
  process.on("SIGINT", () => stub.close().then(() => process.exit(0)));
  process.on("SIGTERM", () => stub.close().then(() => process.exit(0)));
}
