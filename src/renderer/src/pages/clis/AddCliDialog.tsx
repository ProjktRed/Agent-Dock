import { Fragment, useState } from "react";
import type { CliConnection, CliHealth, CliKind, PathDetection } from "@shared/types";
import { cleanError, useApp } from "../../store";
import { connectionMeta, uid } from "../../lib/format";
import { Modal, Spinner, St } from "../../components/ui";
import { CAPPED_KEY_HINT } from "@shared/key-limit";

const TYPES: { kind: CliKind; label: string; desc: string; exe: boolean; defaultLocation: string }[] = [
  { kind: "codex", label: "Codex CLI", desc: "OpenAI coding agent · orchestrator", exe: true, defaultLocation: "codex" },
  { kind: "claude", label: "Claude Code", desc: "Anthropic CLI · orchestrator", exe: true, defaultLocation: "claude" },
  { kind: "cline", label: "Cline CLI", desc: "Implementation worker", exe: true, defaultLocation: "cline" },
  { kind: "opencode", label: "OpenCode", desc: "Implementation worker", exe: true, defaultLocation: "opencode" },
  { kind: "ollama", label: "Ollama", desc: "Local model runtime", exe: false, defaultLocation: "http://127.0.0.1:11434" },
  { kind: "llamacpp", label: "llama.cpp server", desc: "OpenAI-compatible local server", exe: false, defaultLocation: "http://127.0.0.1:8080/v1" },
  { kind: "openai", label: "OpenAI-compatible API", desc: "Any /v1 endpoint", exe: false, defaultLocation: "https://" },
];
const STEPS = ["Type", "Location", "Settings", "Test", "Capabilities", "Save"];

export function AddCliDialog({ onClose }: { onClose: () => void }) {
  const { setClis, toast, snap } = useApp();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<CliKind | null>(null);
  const type = TYPES.find((t) => t.kind === kind);
  const [location, setLocation] = useState("");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [startup, setStartup] = useState(15);
  const [request, setRequest] = useState(8);
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<PathDetection | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<CliHealth | null>(null);

  const draft = (): CliConnection => ({
    id: uid(kind ?? "cli"),
    kind: kind!,
    name: name.trim() || type!.label,
    location: location.trim(),
    builtIn: false,
    startupTimeoutSeconds: startup,
    requestTimeoutSeconds: request,
    contextCap: null,
    defaultModel: null,
    manualModels: [],
    env: [],
    hasSecret: Boolean(secret),
  });

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await window.api.testConnection(draft(), secret || null));
    } catch (e) {
      toast("error", cleanError(e));
    } finally {
      setTesting(false);
    }
  };

  const passed = result?.state === "connected";
  const canNext = [Boolean(kind), Boolean(location.trim()), Boolean(name.trim() || type), passed, true, true][step];

  const save = async () => {
    try {
      setClis(await window.api.saveCli(draft(), secret || null));
      toast("success", `${draft().name} saved`);
      onClose();
    } catch (e) {
      toast("error", cleanError(e));
    }
  };

  return (
    <Modal label="Add CLI or runtime" title="Add CLI or runtime" wide onClose={onClose}>
      <div className="steps" aria-label="Setup steps">
        {STEPS.map((l, i) => (
          <Fragment key={l}>
            <span className={`step ${i === step ? "cur" : i < step ? "done" : ""}`}><span className="n">{i < step ? "✓" : i + 1}</span>{l}</span>
            {i < STEPS.length - 1 && <span className="step-sep" />}
          </Fragment>
        ))}
      </div>
      <div className="well pad" style={{ minHeight: 300 }}>
        {step === 0 && (
          <div className="stack fade-in" style={{ gap: 14 }}>
            <div className="sub">Integration type</div>
            <div className="tiles">
              {TYPES.map((t) => (
                <button key={t.kind} className={`opt ${kind === t.kind ? "on" : ""}`} onClick={() => { setKind(t.kind); setLocation(t.defaultLocation); setName(snap.clis.some((c) => c.name === t.label) ? `${t.label} (2)` : t.label); setRequest(t.exe ? 20 : 8); setResult(null); setDetection(null); }} aria-pressed={kind === t.kind}>
                  <span><b style={{ fontWeight: 600, display: "block" }}>{t.label}</b><span className="sub">{t.desc}</span></span>
                </button>
              ))}
            </div>
          </div>
        )}
        {step === 1 && type && (
          <div className="stack fade-in" style={{ gap: 14 }}>
            {type.exe ? (
              <>
                <label className="field"><span>Executable path or command on PATH</span>
                  <div className="row">
                    <input className="input mono" value={location} onChange={(e) => setLocation(e.target.value)} />
                    <button className="btn" onClick={async () => { setDetecting(true); setDetection(await window.api.detectOnPath(type.defaultLocation)); setDetecting(false); }}>{detecting && <Spinner />}Detect on PATH</button>
                  </div>
                </label>
                {detection && (
                  <div className="stack fade-in" style={{ gap: 4 }}>
                    <div className="eyebrow">{detection.found.length ? "Found" : "Not found"}</div>
                    {detection.found.length === 0 && <div className="sub">“{detection.command}” is not on PATH. Install it or enter the full path to the executable.</div>}
                    {detection.found.map((f) => (
                      <button key={f.path} className={`radio ${location === f.path ? "on" : ""}`} role="radio" aria-checked={location === f.path} onClick={() => setLocation(f.path)}>
                        <span className="rd" /><span className="mono grow">{f.path}</span><span className="sub">{f.version ? `v${f.version}` : "version unknown"}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <label className="field"><span>Endpoint</span><input className="input mono" value={location} onChange={(e) => setLocation(e.target.value)} /><span className="hint">{kind === "ollama" ? "Ollama base URL" : kind === "openai" ? "OpenAI-compatible URL, e.g. https://openrouter.ai/api/v1 or https://opencode.ai/inference/openai/v1" : "OpenAI-compatible base URL, usually ending in /v1"}</span></label>
            )}
          </div>
        )}
        {step === 2 && type && (
          <div className="grid-f fade-in">
            <label className="field"><span>Display name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <span />
            <label className="field"><span>Startup timeout (s)</span><input className="input" inputMode="numeric" value={startup} onChange={(e) => setStartup(Number(e.target.value) || 15)} /></label>
            <label className="field"><span>Request timeout (s)</span><input className="input" inputMode="numeric" value={request} onChange={(e) => setRequest(Number(e.target.value) || 8)} /></label>
            {kind === "openai" ? (
              <label className="field" style={{ gridColumn: "1 / -1" }}><span>API key (optional)</span><input className="input mono" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Saved encrypted with Windows DPAPI; never shown again" /><span className="hint">{CAPPED_KEY_HINT}</span></label>
            ) : (
              <div className="banner" style={{ gridColumn: "1 / -1" }}><span className="dot info" style={{ marginTop: 5 }} /><span>{type.exe ? "Authentication is handled by the CLI itself. If the test reports sign-in required, sign in from a terminal (e.g. codex login, claude auth login)." : "Local runtimes need no credentials."}</span></div>
            )}
          </div>
        )}
        {step === 3 && (
          <div className="stack fade-in" style={{ gap: 12 }}>
            <div className="row"><span className="sub grow">Runs a short handshake: version, sign-in status and model listing. No model is called.</span><button className="btn" onClick={runTest} disabled={testing}>{testing && <Spinner />}Run test</button></div>
            {result && (
              <>
                <div className={`banner ${passed ? "" : "errb"}`}><St kind={passed ? "done" : "blocked"} /><span><b style={{ fontWeight: 600 }}>{connectionMeta[result.state].label}</b> · {result.detail}</span></div>
                <div className="mono log selectable">{result.log.join("\n") || "No log"}</div>
              </>
            )}
          </div>
        )}
        {step === 4 && result && (
          <div className="stack fade-in" style={{ gap: 8 }}>
            <div className="sub">Detected from the tool's own output. Anything not detected stays unknown.</div>
            <ul className="list">
              {result.capabilities.map((c) => <li key={c.name}><St kind={c.state === "detected" ? "done" : c.state === "partial" ? "part" : c.state === "unsupported" ? "blocked" : "pending"} /><span className="grow">{c.name}</span><span className="sub">{c.detail}</span></li>)}
              {result.capabilities.length === 0 && <li className="sub">No capabilities reported.</li>}
            </ul>
            <div className="sub">Models: {result.models.length ? result.models.slice(0, 6).map((m) => m.id).join(", ") + (result.models.length > 6 ? "…" : "") : "none discovered"}</div>
          </div>
        )}
        {step === 5 && type && (
          <div className="stack fade-in" style={{ gap: 12 }}>
            <h3 className="h3">Ready to save</h3>
            <dl className="kv two">
              <div><dt>Name</dt><dd>{name || type.label}</dd></div>
              <div><dt>Type</dt><dd>{type.label}</dd></div>
              <div style={{ gridColumn: "1 / -1" }}><dt>Location</dt><dd className="mono">{result?.resolvedPath ?? location}</dd></div>
              <div><dt>Test</dt><dd className="ok">Passed</dd></div>
              <div><dt>Version</dt><dd>{result?.version ?? "—"}</dd></div>
            </dl>
          </div>
        )}
      </div>
      <div className="row">
        <span className="sub grow">{step === 3 && !passed ? "The test must pass to continue." : ""}</span>
        <button className="btn ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        {step < 5 ? <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</button> : <button className="btn primary" onClick={save}>Save integration</button>}
      </div>
    </Modal>
  );
}
