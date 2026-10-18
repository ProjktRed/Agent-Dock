import { redactText } from "./redact.mjs";

const installed = Symbol.for("agent-dock-engine.process-diagnostics");

export function diagnostic(type, fields = {}) {
  const entry = { timestamp: new Date().toISOString(), diagnostic: type, ...fields };
  // The engine log is kept and shown in the app: no secrets in it.
  process.stderr.write(`${redactText(JSON.stringify(entry))}\n`);
}

export function installTopLevelDiagnostics() {
  if (process[installed]) return;
  process[installed] = true;
  process.on("uncaughtExceptionMonitor", (error) => {
    diagnostic("UNCAUGHT_EXCEPTION", { error: error?.stack ?? String(error) });
  });
  process.on("unhandledRejection", (reason) => {
    diagnostic("UNHANDLED_REJECTION", { error: reason?.stack ?? String(reason) });
    process.exitCode = 1;
  });
}
