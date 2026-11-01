import type { RunReport } from "@shared/types";

// Run report export (Overview › Runs › Export): one finished run as Markdown or a self-contained HTML
// page, to share or attach. Built only from the run's saved report; no secrets are in it (the engine
// redacts the reason before saving).

const n = (value: number) => value.toLocaleString("en-US");
const money = (usd: number) => `$${usd.toFixed(2)}`;
const length = (hours: number) => (hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${hours.toFixed(1)} h`);

/** The report as label/value rows, shared by both formats. */
export function runReportRows(r: RunReport): [string, string][] {
  const usage = r.usage ?? { tokens: 0, input: 0, cached: 0, output: 0, costUsd: 0, calls: 0 };
  const estimated = (usage as { estimatedUsd?: number }).estimatedUsd ?? 0;
  return [
    ["Mode", r.unattended ? "Unattended" : "Attended"],
    ["Task size", `${r.taskMode ?? "eco"}${r.stepDowns ? ` (${r.stepDowns} step-down${r.stepDowns === 1 ? "" : "s"})` : ""}`],
    ["Started", r.startedAt],
    ["Ended", `${r.endedAt} (${length(r.hours)})`],
    ["Result", r.status],
    ["Why it ended", (r.reason ?? "").split(/\r?\n/)[0] || "finished"],
    ["Tasks approved", String(r.tasksApproved)],
    ["QA failures", String(r.qaFailures)],
    ["Corrections", String(r.corrections)],
    ["Elevations", String(r.elevations)],
    ["Stops for attention", String(r.needsAttention)],
    ["Supervisor alerts", String(r.supervisorAlerts)],
    ["Tokens", `${n(usage.tokens)} counted (${n(usage.cached)} more read from prompt caches), ${usage.calls} model call${usage.calls === 1 ? "" : "s"}`],
    ["Spend", `${money(usage.costUsd)}${estimated ? ` (${money(estimated)} estimated from the price table)` : ""}`],
    ["Action log", r.actionLog?.ok ? `verified${r.actionLog.entries ? `, ${r.actionLog.entries} entries` : ""}` : `not verified${r.actionLog?.reason ? ` (${r.actionLog.reason})` : ""}`],
  ];
}

export function runReportMarkdown(r: RunReport, project: string): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return [
    `# ${project}: run report`,
    "",
    "| | |",
    "|---|---|",
    ...runReportRows(r).map(([label, value]) => `| ${label} | ${cell(value)} |`),
    "",
    ...(r.approved?.length ? ["## Approved tasks", "", ...r.approved.map((a) => `- ${a.taskId ?? "task"}${a.name ? `: ${a.name}` : ""} (${a.at})`), ""] : []),
    ...(r.reason && r.reason.includes("\n") ? ["## Details", "", "```", r.reason, "```", ""] : []),
    "_Exported from Agent Dock._",
    "",
  ].join("\n");
}

export function runReportHtml(r: RunReport, project: string): string {
  const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const rows = runReportRows(r).map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`).join("\n");
  const approved = r.approved?.length ? `<h2>Approved tasks</h2><ul>${r.approved.map((a) => `<li>${esc(a.taskId ?? "task")}${a.name ? `: ${esc(a.name)}` : ""} <small>(${esc(a.at)})</small></li>`).join("")}</ul>` : "";
  const details = r.reason && r.reason.includes("\n") ? `<h2>Details</h2><pre>${esc(r.reason)}</pre>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(project)}: run report</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px auto;max-width:760px;padding:0 16px;color:#1d2330;background:#fff}
h1{font-size:20px}h2{font-size:16px;margin-top:24px}table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid #e3e6ec;padding:6px 8px;text-align:left;vertical-align:top}th{width:34%;font-weight:600}
pre{background:#f4f6f9;padding:12px;overflow:auto;white-space:pre-wrap}footer{margin-top:24px;color:#6b7383;font-size:12px}
@media (prefers-color-scheme:dark){body{color:#e6e9ef;background:#151821}th,td{border-color:#2a2f3b}pre{background:#1e222d}}
</style></head><body>
<h1>${esc(project)}: run report</h1>
<table>
${rows}
</table>
${approved}${details}
<footer>Exported from Agent Dock.</footer>
</body></html>
`;
}
