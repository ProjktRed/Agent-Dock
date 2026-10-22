import "./startup-env.mjs";
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
import { setCliRunSettings } from "./cli-run-settings.mjs";
import { verifyReview, runNodeLoop } from "./node-loop.mjs";
import { installTopLevelDiagnostics } from "./diagnostics.mjs";
import { useTuning } from "./engine-tuning.mjs";
import { createImplementationWorker, createRoles, gitStartupError } from "./engine-setup.mjs";
import {configureProtection} from './guard/protected-paths.mjs';
import { writeEnginePid } from "./engine-pid.mjs";

installTopLevelDiagnostics();
const exec = promisify(execFile);
const options = parseLoopOptions(process.argv.slice(2));
setCliRunSettings(options["cli-settings"]);
const workspace = path.resolve(options.workspace);
const stateDir = path.resolve(options["state-dir"] ?? ".state");
configureProtection({workspace,stateDir,paths:options['protected-paths']});
writeEnginePid(stateDir);
const state = new DashboardState({ stateDir });
let launchReady = false;

try {
  useTuning(options.tuning);
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
  const gitCommonOutput = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: workspace, windowsHide: true }).catch(gitStartupError);
  const gitCommonDir = path.resolve(workspace, gitCommonOutput.stdout.trim());
  const outside = path.relative(workspace, gitCommonDir).split(path.sep)[0] === "..";
  const additionalWritableDirs = outside ? [gitCommonDir] : [];
  const codex = mixed || Object.keys(options.roleBackups).length
    ? await buildMixedOrchestrator({ options, clis, stateDir, workspace, additionalWritableDirs, onEvent: event => state.record(event) })
    : useClaude
    ? new ClaudeWorker({ stateDir, workspace, claudeCommand: options["claude-command"] ?? "claude", additionalWritableDirs })
    : new CodexWorker({ stateDir, workspace, launcher, windowsSandbox: options["codex-windows-sandbox"], additionalWritableDirs });
  const implementation = await createImplementationWorker(options, { stateDir, workspace, state, lazy: true });
  const { roles, runRole } = await createRoles(options, { stateDir, workspace });
  launchReady = true;
  const worker = implementation.worker;
  const result = await runManualElevate({
    workspace,stateDir,codex,worker,objective:options.objective,roles,runRole,
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
