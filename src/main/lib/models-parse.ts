import type { CliModel, ProviderModels } from "@shared/types";

/** Codex app-server `model/list` result (fields Agent Dock reads). */
export interface CodexModelListResult {
  data: {
    id: string;
    model?: string;
    displayName?: string;
    description?: string;
    hidden?: boolean;
    supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
    defaultReasoningEffort?: string | null;
    serviceTiers?: { id: string; name?: string; description?: string }[];
    additionalSpeedTiers?: string[];
    isDefault?: boolean;
  }[];
  nextCursor?: string | null;
}

/** Claude Code `initialize` control response `models` entry. */
export interface ClaudeModelEntry {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
}

export function parseCodexModels(result: CodexModelListResult): ProviderModels {
  const models: CliModel[] = (result.data ?? [])
    .filter((m) => !m.hidden)
    .map((m) => {
      const fastTier = m.serviceTiers?.find((t) => t.id === "priority");
      return {
        id: m.model ?? m.id,
        displayName: m.displayName ?? m.id,
        description: m.description ?? "",
        resolved: null,
        efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
        defaultEffort: m.defaultReasoningEffort ?? null,
        fast: Boolean(fastTier),
        fastDescription: fastTier?.description ?? null,
        isDefault: Boolean(m.isDefault),
      };
    });
  return { provider: "codex", ok: true, fetchedAt: new Date().toISOString(), source: "Codex app-server · model/list", models, fastBlockedReason: null, error: null };
}

/** Claude's own explanations for fast_mode_disabled_reason codes. */
const CLAUDE_FAST_REASONS: Record<string, string> = {
  extra_usage_disabled: "Needs extra usage enabled on your Claude account",
  free: "Not included in the free plan",
  preference: "Turned off by your organization",
  not_first_party: "Only available with Anthropic's own API",
  disabled_by_env: "Turned off by an environment variable",
  model_not_allowed: "Not allowed for this model by your organization",
  network_error: "Could not check availability (network error)",
  pending: "Claude Code was still checking availability; refresh to check again",
};

/** Claude answers `pending` while its account check is still running: ask again before trusting the result. */
export const claudeFastPending = (response: { fast_mode_disabled_reason?: string | null }) => response.fast_mode_disabled_reason === "pending";

export function parseClaudeModels(response: { models?: ClaudeModelEntry[]; fast_mode_disabled_reason?: string | null }): ProviderModels {
  const all = response.models ?? [];
  // "default" is an alias for the account default; mark the first concrete entry that resolves to it instead.
  const defaultModel = all.find((m) => m.value === "default")?.resolvedModel;
  const defaultId = all.find((m) => m.value !== "default" && m.resolvedModel === defaultModel)?.value;
  const models: CliModel[] = all
    .filter((m) => m.value !== "default")
    .map((m) => ({
      id: m.value,
      displayName: m.displayName ?? m.value,
      description: m.description ?? "",
      resolved: m.resolvedModel && m.resolvedModel !== m.value ? m.resolvedModel : null,
      efforts: m.supportsEffort ? m.supportedEffortLevels ?? [] : [],
      defaultEffort: null,
      fast: Boolean(m.supportsFastMode),
      fastDescription: m.supportsFastMode ? "Faster output, billed as extra usage" : null,
      isDefault: m.value === defaultId,
    }));
  const reason = response.fast_mode_disabled_reason ?? null;
  return {
    provider: "claude",
    ok: true,
    fetchedAt: new Date().toISOString(),
    source: "Claude Code · initialize (models)",
    models,
    fastBlockedReason: reason ? CLAUDE_FAST_REASONS[reason] ?? reason : null,
    error: null,
  };
}
