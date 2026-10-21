// Parallel tasks on a local model server (0.38). Every task engine sends its requests to the same server,
// so a round has at most as many tasks as the server answers at once: llama.cpp's slots (llama-server
// --parallel N, reported as total_slots), or for Ollama the number you set (OLLAMA_NUM_PARALLEL, which
// Ollama does not report). Task engines never start the server (--local-server-managed external).

const DEFAULT_LLAMACPP_URL = "http://127.0.0.1:8080/v1";

/** llama.cpp's slot count from /props (per model in router mode), or null when it does not say. */
export async function llamaCppSlots(fetchImpl, baseUrl, routerModel = null) {
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "").replace(/\/v1$/, "")}/props${routerModel ? `?model=${encodeURIComponent(routerModel)}` : ""}`);
    if (!response?.ok) return null;
    const value = Number((await response.json())?.total_slots);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

/** The lanes a local provider allows: { lanes, reason } (reason set when fewer than asked). Cloud providers keep theirs. */
export async function localLanes({ provider, lanes, options, baseUrl = null, fetchImpl = globalThis.fetch }) {
  if (lanes <= 1) return { lanes, reason: null };
  if (provider === "llamacpp") {
    const slots = await llamaCppSlots(fetchImpl, baseUrl ?? options["llamacpp-url"] ?? DEFAULT_LLAMACPP_URL, options["llamacpp-models-dir"] ? options.model : null);
    if (slots === null) return { lanes: 1, reason: "llama.cpp did not report its slots, so tasks run one at a time" };
    return slots >= lanes ? { lanes, reason: null } : { lanes: slots, reason: `llama.cpp has ${slots} slot${slots === 1 ? "" : "s"} (llama-server --parallel), so at most ${slots} task${slots === 1 ? "" : "s"} at once` };
  }
  if (provider === "ollama") {
    const at = Number(options["ollama-parallel"] ?? 1);
    const allowed = Number.isInteger(at) && at > 0 ? at : 1;
    return allowed >= lanes ? { lanes, reason: null } : { lanes: allowed, reason: `the Ollama connection answers ${allowed} request${allowed === 1 ? "" : "s"} at once (OLLAMA_NUM_PARALLEL), so at most ${allowed} task${allowed === 1 ? "" : "s"} at once` };
  }
  return { lanes, reason: null };
}
