import assert from "node:assert/strict";
import test from "node:test";

import { codexOutputSchema, parseCodexResult } from "../src/codex-worker.mjs";

function assertStrictObjects(schema, location = "root") {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object") {
    const propertyKeys = Object.keys(schema.properties ?? {}).sort();
    assert.deepEqual([...(schema.required ?? [])].sort(), propertyKeys, `${location} must require every property`);
    assert.equal(schema.additionalProperties, false, `${location} must reject additional properties`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) assertStrictObjects(child, `${location}.${key}`);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties") continue;
    if (Array.isArray(value)) value.forEach((child, index) => assertStrictObjects(child, `${location}.${key}[${index}]`));
    else if (value && typeof value === "object") assertStrictObjects(value, `${location}.${key}`);
  }
}

const result = (overrides = {}) => ({
  status: "manual-review",
  task: null,
  output: "Needs review",
  correction: "",
  commit: "",
  manualReviewCause: null,
  ...overrides,
});

test("generated Codex/Elevate schema is strict-valid recursively", () => {
  assertStrictObjects(codexOutputSchema);
  assert.deepEqual(new Set(codexOutputSchema.required), new Set(Object.keys(codexOutputSchema.properties)));
});

test("manualReviewCause is required and nullable", () => {
  assert.ok(codexOutputSchema.required.includes("manualReviewCause"));
  assert.deepEqual(codexOutputSchema.properties.manualReviewCause.type, ["string", "null"]);
  assert.equal(parseCodexResult(JSON.stringify(result())).manualReviewCause, null);
});

test("Elevate Revised Correction parses correctly", () => {
  const parsed = parseCodexResult(JSON.stringify(result({ status: "fail", output: "Use revised lifecycle evidence", correction: "Instrument the owned child" })));
  assert.equal(parsed.status, "fail");
  assert.match(parsed.correction, /owned child/);
});

test("Elevate Re-QA Recommended parses correctly", () => {
  const parsed = parseCodexResult(JSON.stringify(result({ status: "pass", output: "Independent QA should run" })));
  assert.equal(parsed.status, "pass");
});

test("Elevate Manual Review parses correctly", () => {
  const parsed = parseCodexResult(JSON.stringify(result({ manualReviewCause: "sol-manual-review" })));
  assert.equal(parsed.status, "manual-review");
  assert.equal(parsed.manualReviewCause, "sol-manual-review");
});

test("Elevate Insufficient Evidence parses correctly", () => {
  const parsed = parseCodexResult(JSON.stringify(result({ output: "Insufficient evidence to recommend a safe correction", manualReviewCause: "sol-manual-review" })));
  assert.match(parsed.output, /Insufficient evidence/);
});

test("malformed structured responses fail safely", () => {
  const { manualReviewCause: _missing, ...missing } = result();
  assert.throws(() => parseCodexResult(JSON.stringify(missing)), /manualReviewCause/);
  assert.throws(() => parseCodexResult(JSON.stringify({ ...result(), unexpected: true })), /unexpected/);
  assert.throws(() => parseCodexResult(JSON.stringify(result({ status: "invented" }))), /status/);
  assert.throws(() => parseCodexResult("not json"), /JSON|Unexpected token/i);
});
