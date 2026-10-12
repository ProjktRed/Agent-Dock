import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { CodexWorker, useOrchestratorModels, useRoleOverrides } from "./codex-worker.mjs";
import { CLAUDE_MODELS, ClaudeWorker, preflightClaude } from "./claude-worker.mjs";
import { buildMixedOrchestrator, isMixed, roleClis, useMixedDefaults } from "./mixed-orchestrator.mjs";
import { resolveCodexCommand, preflightCodex } from "./codex-command.mjs";
import { DashboardState, atomicWriteJson } from "./dashboard-state.mjs";
import { runManualElevate } from "./manual-elevate.mjs";
import { parseLoopOptions } from "./loop-options.mjs";
import { verifyReview, runNodeLoop } from "./node-loop.mjs";
import { ClineCliWorker } from "./cline-cli-worker.mjs";
import { prepareClineRuntime } from "./cline-runtime-config.mjs";
import { installTopLevelDiagnostics } from "./diagnostics.mjs";

installTopLevelDiagnostics();
const exec = promisify(execFile);
const options = parseLoopOptions(process.argv.slice(2));
const workspace = path.resolve(options.workspace);
const stateDir = path.resolve(options["state-dir"] ?? ".state");
const state = new DashboardState({ stateDir });
let launchReady = false;

try {
  const useClaude = options.orchestrator === "claude";
  let launcher = null;
  if (useClaude) {
    useOrchestratorModels(CLAUDE_MODELS);
    await preflightClaude(options["claude-command"] ?? "claude");
  } else {
    launcher = await resolveCodexCommand({ explicitCommand: options["codex-command"] ?? options["codex-exe"] });
    await preflightCodex(launcher);
  }
  const clis = roleClis(options);
  const mixed = isMixed(clis);
  if (mixed) useMixedDefaults(clis);
  useRoleOverrides(options.roleOverrides);
  const gitCommonOutput = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: workspace, windowsHide: true });
  const gitCommonDir = path.resolve(workspace, gitCommonOutput.stdout.trim());
  const outside = path.relative(workspace, gitCommonDir).split(path.sep)[0] === "..";
  const additionalWritableDirs = outside ? [gitCommonDir] : [];
  const codex = mixed
    ? await buildMixedOrchestrator({ options, clis, stateDir, workspace, additionalWritableDirs })
    : useClaude
    ? new ClaudeWorker({ stateDir, workspace, claudeCommand: options["claude-command"] ?? "claude", additionalWritableDirs })
    : new CodexWorker({ stateDir, workspace, launcher, windowsSandbox: options["codex-windows-sandbox"], additionalWritableDirs });
  launchReady = true;
  let cline;
  const worker = {
    withExclusive: async fn => {
      if (!cline) {
        const runtime = await prepareClineRuntime({stateDir,provider:options.provider,model:options.model,contextTokens:options.clineContextTokens,maxOutputTokens:options.clineMaxOutputTokens,timeoutSeconds:options.timeoutSeconds,llamaCppModelsDir:options.llamacppModelsDir,thinking:options.clineThinking});
        cline = new ClineCliWorker({toolGuard:options.toolGuard,thinking:options.clineThinking,stateDir,workspace,clineJs:options["cline-js"],provider:runtime.provider,model:runtime.model,timeoutSeconds:options.timeoutSeconds,contextTokens:options.clineContextTokens,dataDir:runtime.dataDir,requestedProvider:runtime.requestedProvider,baseUrl:runtime.baseUrl,beforeRun:runtime.ensureReady,readMetrics:runtime.readMetrics});
        await state.configureRuntime({contextTokens:options.clineContextTokens,timeoutSeconds:options.timeoutSeconds,model:runtime.model,provider:runtime.provider});
      }
      return cline.withExclusive(fn);
    },
    run: (...args) => cline.run(...args),
  };
  const result = await runManualElevate({
    workspace,stateDir,codex,worker,objective:options.objective,
    solReassessmentEnabled:options.solReassessment,
    readControl:()=>state.readControl(),onEvent:event=>state.record(event),
    pollMs:Number(options["poll-seconds"]??2)*1000,
  });
  if (result.status) await atomicWriteJson(path.join(stateDir, "loop-result.json"), result);
  console.log(JSON.stringify(result));
} catch (error) {
  await state.record({
    type: launchReady ? "blocked" : "elevate-launch-failed",
    ...(launchReady
      ? { qa: error.message }
      : { qa: error.message }),
  });
  console.error(error.message);
  process.exitCode = 1;
}
