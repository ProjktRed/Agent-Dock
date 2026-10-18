import path from "node:path";

/**
 * The terminal stop-all launcher the app keeps in its config folder (a protected path, so workers
 * cannot change it). It runs engine/src/stop-all.mjs on the app's own Node runtime.
 */
export function stopLauncher(input: { platform: NodeJS.Platform; execPath: string; script: string; configDir: string }): { file: string; content: string } {
  if (input.platform === "win32") {
    return {
      file: path.join(input.configDir, "stop-all.cmd"),
      content: [
        "@echo off",
        "rem Agent Dock: stop every project's engine at its next safe point.",
        "rem   --now             stop at once (kills the engine and its workers)",
        "rem   --project \"Name\"  only that project",
        "set ELECTRON_RUN_AS_NODE=1",
        `"${input.execPath}" "${input.script}" --config "${input.configDir}" %*`,
        "",
      ].join("\r\n"),
    };
  }
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return {
    file: path.join(input.configDir, "stop-all.sh"),
    content: [
      "#!/bin/sh",
      "# Agent Dock: stop every project's engine at its next safe point.",
      "#   --now             stop at once (kills the engine and its workers)",
      "#   --project 'Name'  only that project",
      `ELECTRON_RUN_AS_NODE=1 exec ${q(input.execPath)} ${q(input.script)} --config ${q(input.configDir)} "$@"`,
      "",
    ].join("\n"),
  };
}
