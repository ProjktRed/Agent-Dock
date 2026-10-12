import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { diagnostic } from "./diagnostics.mjs";
import { fileURLToPath } from "node:url";

import { DashboardState } from "./dashboard-state.mjs";
import { elevateAvailability, loadElevateCase } from "./elevate-case.mjs";
import {loadResolverCase,resolverAvailability} from './blocked-resolver.mjs';
import {readImplementationProgress} from './implementation-progress.mjs';

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");

function gitSnapshot(workspace) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: workspace, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve({ changedFiles: [], currentSha: null });
        const records = stdout.split("\0").filter(Boolean);
        const changedFiles = [];
        for (let index = 0; index < records.length; index++) {
          const record = records[index];
          const status = record.slice(0, 2);
          const filePath = record.slice(3).replaceAll("\\", "/");
          changedFiles.push({ status, path: filePath });
          if (/[RC]/.test(status) && records[index + 1]) index += 1;
        }
        execFile("git", ["rev-parse", "HEAD"], { cwd: workspace, windowsHide: true }, (headError, head) => {
          resolve({ changedFiles, currentSha: headError ? null : head.trim() || null });
        });
      },
    );
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export function primaryStatus(live, control) {
  if(live?.resolverRunning)return 'resolving';
  if(live?.stage==='BLOCKED')return 'blocked';
  if (live?.stage === "stopped") return "stopped";
  if (live?.stage === "paused") return "paused";
  if (live?.stage === "WAITING_FOR_CODEX") return "waiting for codex";
  if(live?.elevateRunning)return 'elevating';
  if(live?.assessmentRunning)return 'assessment';
  if(live?.userAttention && live?.clineStatus!=='running' && live?.qaStatus!=='running')return 'user attention';
  if (live?.qaStatus === "pass" || live?.qaStatus === "fail") return live.qaStatus;
  if (live?.clineStatus === "running") return "working";
  return "waiting";
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Request body too large");
  }
  return JSON.parse(body || "{}");
}

async function serveAsset(response, pathname) {
  const assets = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/view-model.js": ["view-model.js", "text/javascript; charset=utf-8"],
    "/task-disclosure.js": ["task-disclosure.js", "text/javascript; charset=utf-8"],
    "/phase-progress.js": ["phase-progress.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
  };
  const asset = assets[pathname];
  if (!asset) return false;
  response.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" });
  response.end(await readFile(path.join(uiDir, asset[0])));
  return true;
}

export async function startDashboardServer({ stateDir, workspace, port = 4173, onControl = async () => {} }) {
  const state = new DashboardState({ stateDir });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/status") {
        const [live, control, events, git] = await Promise.all([
          state.readLive(),
          state.readControl(),
          state.readEvents(40),
          gitSnapshot(workspace),
        ]);
        const snapshot = live ?? {
            task: null,
            stage: "waiting",
            clineStatus: "idle",
            qaStatus: "waiting",
            attempt: 0,
            maxAttempts: 0,
            latestQa: "",
            manualReview: false,
          };
        const elapsedMs = snapshot.cline?.startedAt
          ? (snapshot.clineStatus === "running"
            ? Math.max(0, Date.now() - new Date(snapshot.cline.startedAt).getTime())
            : snapshot.cline.durationMs)
          : null;
        let elevate = { available: false, reason: "Manual review evidence is unavailable", fingerprint: null };
        try {
          const elevateCase = await loadElevateCase(stateDir);
          elevate = { ...elevateAvailability({ live: snapshot, fingerprint: elevateCase.fingerprint }), fingerprint: elevateCase.fingerprint };
        } catch {}
        let resolver={available:false,reason:'No complete blocked case'};
        if(snapshot.stage==='BLOCKED')try{resolver=resolverAvailability({live:snapshot,input:await loadResolverCase(stateDir)});}catch{}
        const implementationProgress=await readImplementationProgress(workspace,snapshot.task);
        return sendJson(response, 200, {
          ...snapshot,
          cline: { startedAt: null, finishedAt: null, durationMs: null, pid: null, ...(snapshot.cline ?? {}), elapsedMs },
          control,
          primaryStatus: primaryStatus(live, control),
          changedFilesCount: git.changedFiles.length,
          changedFiles: git.changedFiles,
          currentSha: git.currentSha,
          events,
          resolverAvailable:resolver.available&&!snapshot.resolverRequested,
          resolverUnavailableReason:resolver.reason,
          implementationProgress,
          elevateAvailable: elevate.available,
          elevateUnavailableReason: elevate.reason,
          elevateFingerprint: elevate.fingerprint,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/logs") {
        return sendJson(response, 200, await state.readEvents(200));
      }
      if (request.method === "POST" && url.pathname === "/api/activity/clear") {
        await state.clearActivityHistory();
        return sendJson(response, 200, { cleared: true });
      }
      if (request.method === "POST" && url.pathname === "/api/control") {
        const body = await readBody(request);
        const control = await state.setControl(body.action);
        await onControl(body.action, control);
        return sendJson(response, 200, control);
      }
      if (request.method === "GET" && (await serveAsset(response, url.pathname))) return;
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  diagnostic("DASHBOARD_SERVER_ALIVE", { host: "127.0.0.1", port: address.port });
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
