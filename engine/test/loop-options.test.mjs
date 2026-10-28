import assert from "node:assert/strict";
import test from "node:test";

test("loop defaults select llama.cpp with its measured context and output budget, and no model", async () => {
  const { parseLoopOptions } = await import("../src/loop-options.mjs");
  const options = parseLoopOptions(["--workspace", "repo", "--objective", "bounded"]);

  assert.equal(options.provider, "llamacpp");
  assert.equal(options.model, null);
  assert.equal(options.clineContextTokens, 98_304);
  assert.equal(options.clineMaxOutputTokens, 8_192);
  assert.equal(options.timeoutSeconds, 1_800);
  assert.equal(options.solReassessment, true);
});

test("explicit Ollama selection keeps the 98K context default and assumes no model", async () => {
  const { parseLoopOptions } = await import("../src/loop-options.mjs");
  const options = parseLoopOptions(["--provider", "ollama"]);

  assert.equal(options.provider, "ollama");
  assert.equal(options.model, null);
  assert.equal(options.clineContextTokens, 98_304);
});

test("OpenCode Console defaults to the free DeepSeek model without requiring a base URL", async () => {
  const { parseLoopOptions, PROVIDERS } = await import("../src/loop-options.mjs");
  const options = parseLoopOptions(["--provider", "opencode"]);

  assert.ok(PROVIDERS.includes("opencode"));
  assert.equal(options.providerBaseUrl, null);
  assert.equal(options.model, "deepseek-v4.1-flash-free");
});

test("loop options allow context, timeout, and Sol opt-out overrides", async () => {
  const { parseLoopOptions } = await import("../src/loop-options.mjs");
  const options = parseLoopOptions([
    "--workspace", "repo", "--objective", "bounded",
    "--cline-context-tokens", "65536", "--timeout-seconds", "900",
    "--cline-max-output-tokens", "2048",
    "--sol-reassessment", "false",
  ]);

  assert.equal(options.clineContextTokens, 65_536);
  assert.equal(options.timeoutSeconds, 900);
  assert.equal(options.clineMaxOutputTokens, 2_048);
  assert.equal(options.solReassessment, false);
});

test("loop options reject invalid context and timeout instead of silently changing them", async () => {
  const { parseLoopOptions } = await import("../src/loop-options.mjs");

  assert.throws(() => parseLoopOptions(["--cline-context-tokens", "0"]), /cline-context-tokens/);
  assert.throws(() => parseLoopOptions(["--timeout-seconds", "1.5"]), /timeout-seconds/);
});

test("a custom provider key variable is hidden in logs even when its name does not look like a key", async (t) => {
  const { parseLoopOptions } = await import("../src/loop-options.mjs");
  const { redactText, secretValuesFromEnv, useSecretValues } = await import("../src/redact.mjs");
  t.after(() => { delete process.env.MY_CRED; useSecretValues(secretValuesFromEnv()); });
  process.env.MY_CRED = "q7Rk2custom";
  assert.equal(redactText("value q7Rk2custom", { patterns: false }), "value q7Rk2custom");
  parseLoopOptions(["--provider", "openai", "--provider-base-url", "http://127.0.0.1:1/v1", "--provider-api-key-env", "MY_CRED"]);
  assert.equal(redactText("value q7Rk2custom", { patterns: false }), "value [redacted:secret]");
});
