import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OLLAMA_SETTINGS, RUN_SETTINGS, RUN_SETTING_KINDS, cleanRunSettings } from "@shared/cli-settings";
import { configFile, configFilePath } from "../src/main/lib/cli-config-files";
import { isLocalUrl, parseServerConfig } from "../src/main/lib/ollama-settings";
// @ts-expect-error The engine is plain JavaScript without type declarations.
import { RUN_SETTING_RULES, claudeRunArgs, claudeRunEnv, cleanRunSettings as engineClean, clineRunOptions, codexRunArgs, openCodeRunOptions, setCliRunSettings } from "../engine/src/cli-run-settings.mjs";

describe("per-run CLI settings", () => {
  it("keep only listed, valid settings: nothing that loosens the sandbox, approvals or permissions gets through", () => {
    expect(cleanRunSettings("codex", { model_verbosity: "low", project_doc_max_bytes: 4096, sandbox_mode: "danger-full-access", approval_policy: "never", tool_output_token_limit: 5 })).toEqual({ model_verbosity: "low", project_doc_max_bytes: 4096 });
    expect(cleanRunSettings("claude", { fallbackModel: "sonnet", MAX_THINKING_TOKENS: 8000, permissionMode: "bypassPermissions", DISABLE_TELEMETRY: true, fallbackModel2: "x" })).toEqual({ fallbackModel: "sonnet", MAX_THINKING_TOKENS: 8000, DISABLE_TELEMETRY: true });
    expect(cleanRunSettings("claude", { fallbackModel: "sonnet --dangerously-skip-permissions" })).toEqual({});
    expect(cleanRunSettings("codex", null)).toEqual({});
  });

  it("are the same list in the app and the engine, which checks them again", () => {
    expect(Object.keys(RUN_SETTING_RULES).sort()).toEqual([...RUN_SETTING_KINDS].sort());
    for (const kind of RUN_SETTING_KINDS) {
      expect(RUN_SETTINGS[kind].map((d) => d.key).sort()).toEqual(Object.keys(RUN_SETTING_RULES[kind]).sort());
      for (const d of RUN_SETTINGS[kind].filter((x) => x.type === "number")) expect([RUN_SETTING_RULES[kind][d.key].min, RUN_SETTING_RULES[kind][d.key].max]).toEqual([d.min, d.max]);
      for (const d of RUN_SETTINGS[kind].filter((x) => x.type === "choice")) expect(RUN_SETTING_RULES[kind][d.key].choices).toEqual(d.choices);
    }
    expect(engineClean("codex", { model_reasoning_summary: "concise", "sandbox_workspace_write.network_access": true })).toEqual({ model_reasoning_summary: "concise" });
  });

  it("become Codex -c options, a Claude Code flag and Claude Code environment variables", () => {
    expect(codexRunArgs({ model_verbosity: "low", project_doc_max_bytes: 4096 })).toEqual(["-c", 'model_verbosity="low"', "-c", "project_doc_max_bytes=4096"]);
    expect(claudeRunArgs({ settings: { fallbackModel: "sonnet" }, model: "opus" })).toEqual(["--fallback-model", "sonnet"]);
    expect(claudeRunArgs({ settings: { fallbackModel: "sonnet" }, model: "sonnet" })).toEqual([]);
    expect(claudeRunEnv({ fallbackModel: "sonnet", MAX_THINKING_TOKENS: 8000, DISABLE_TELEMETRY: true })).toEqual({ MAX_THINKING_TOKENS: "8000", DISABLE_TELEMETRY: "1" });
    expect(() => setCliRunSettings("{nope")).toThrow(/must be JSON/);
    expect(setCliRunSettings(JSON.stringify({ codex: { model_verbosity: "high", approval_policy: "never" } }))).toEqual({ codex: { model_verbosity: "high" }, claude: {}, cline: {}, opencode: {} });
    expect(codexRunArgs()).toEqual(["-c", 'model_verbosity="high"']);
    setCliRunSettings(undefined);
    expect(codexRunArgs()).toEqual([]);
  });

  it("Cline and OpenCode: their run options, or Agent Dock's defaults when nothing is set", () => {
    expect(cleanRunSettings("cline", { retries: 3, compaction: "basic", yolo: true, autoApprove: true })).toEqual({ retries: 3, compaction: "basic" });
    expect(cleanRunSettings("opencode", { steps: 80, variant: "high", permission: "allow", steps2: 1 })).toEqual({ steps: 80, variant: "high" });
    expect(cleanRunSettings("opencode", { steps: 4, variant: "high --auto" })).toEqual({});
    expect(clineRunOptions({})).toEqual({ retries: 6, compaction: "agentic" });
    expect(clineRunOptions({ retries: 2, compaction: "off" })).toEqual({ retries: 2, compaction: "off" });
    expect(openCodeRunOptions({})).toEqual({ steps: null, variant: null });
    expect(openCodeRunOptions({ steps: 80, variant: "max" })).toEqual({ steps: 80, variant: "max" });
    setCliRunSettings(JSON.stringify({ cline: { retries: 9 }, opencode: { variant: "low", steps: 1 } }));
    expect([clineRunOptions(), openCodeRunOptions()]).toEqual([{ retries: 9, compaction: "agentic" }, { steps: null, variant: "low" }]);
    setCliRunSettings(undefined);
  });

});

describe("CLI config files", () => {
  it("live where the CLIs read them", () => {
    expect(configFilePath("codex", {}, "/home/u")).toBe(path.join("/home/u", ".codex", "config.toml"));
    expect(configFilePath("codex", { CODEX_HOME: "/x" }, "/home/u")).toBe(path.join("/x", "config.toml"));
    expect(configFilePath("claude", { CLAUDE_CONFIG_DIR: "/c" }, "/home/u")).toBe(path.join("/c", "settings.json"));
  });

  it("are shown, never written: Agent Dock only says where they are", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
    try {
      expect(configFile("claude", path.join(dir, "sub", "settings.json"))).toMatchObject({ exists: false, folderExists: false });
      const file = path.join(dir, "settings.json");
      expect(configFile("claude", file)).toMatchObject({ kind: "claude", path: file, exists: false, folderExists: true });
      await writeFile(file, "{}");
      expect(configFile("claude", file).exists).toBe(true);
      expect(await readdir(dir)).toEqual(["settings.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Ollama server settings", () => {
  it("are shown, never written, and leave OLLAMA_HOST to the connection's address", async () => {
    expect(OLLAMA_SETTINGS.some((s) => s.key === "OLLAMA_HOST")).toBe(false);
    const source = await readFile(path.join(__dirname, "..", "src", "main", "lib", "ollama-settings.ts"), "utf8");
    expect(source).not.toMatch(/SetEnvironmentVariable|setx/i);
  });

  it("read what the running Ollama uses from its server.log", () => {
    const log = [
      'time=2026-10-21T18:00:00.000-06:00 level=INFO source=routes.go:1951 msg="server config" env="map[OLLAMA_NUM_PARALLEL:1]"',
      'time=2026-10-21T18:38:15.544-06:00 level=INFO source=routes.go:1951 msg="server config" env="map[CUDA_VISIBLE_DEVICES: OLLAMA_CONTEXT_LENGTH:98304 OLLAMA_FLASH_ATTENTION:true OLLAMA_KEEP_ALIVE:30m0s OLLAMA_KV_CACHE_TYPE:q8_0 OLLAMA_MAX_LOADED_MODELS:1 OLLAMA_MODELS:E:\\\\Ollama Models OLLAMA_NOHISTORY:false OLLAMA_NUM_PARALLEL:2 OLLAMA_ORIGINS:[http://localhost https://localhost] ROCR_VISIBLE_DEVICES:]"',
      "time=2026-10-21T18:38:16.000-06:00 level=INFO msg=Listening",
    ].join("\n");
    expect(parseServerConfig(log)).toEqual({
      at: "2026-10-21T18:38:15.544-06:00",
      values: { OLLAMA_NUM_PARALLEL: "2", OLLAMA_CONTEXT_LENGTH: "98304", OLLAMA_KV_CACHE_TYPE: "q8_0", OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KEEP_ALIVE: "30m0s", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_MODELS: "E:\\Ollama Models" },
    });
    expect(parseServerConfig("no config here")).toBeNull();
    expect([isLocalUrl("http://127.0.0.1:11434"), isLocalUrl("http://localhost/"), isLocalUrl("http://10.0.0.5:11434"), isLocalUrl("http://127.0.0.1.evil.com")]).toEqual([true, true, false, false]);
  });
});
