import { useEffect, useState } from "react";
import type { Agent, CliModel, ModelCatalog, ProviderModels } from "@shared/types";

export function useModelCatalog() {
  const [state, setState] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    void window.api.models().then(setState);
    return window.api.onModels(setState);
  }, []);
  return state;
}

export const EFFORT_LABEL: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export const effortLabel = (effort: string | undefined) => (effort ? EFFORT_LABEL[effort] ?? effort : "—");

/** Effort to keep when the model changes: the current one if supported, else the model default, else medium. */
export function effortFor(model: CliModel | undefined, current: string | undefined): string | undefined {
  if (!model || model.efforts.length === 0) return current;
  if (current && model.efforts.includes(current)) return current;
  if (model.defaultEffort && model.efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return model.efforts.includes("medium") ? "medium" : model.efforts[0];
}

/** Model, effort and speed for an orchestrator agent switched to another CLI (or model). */
export function withModel(agent: Agent, list: ProviderModels | null | undefined, modelId: string): Agent {
  const model = list?.models.find((m) => m.id === modelId);
  return { ...agent, model: modelId, reasoning: effortFor(model, agent.reasoning), fast: Boolean(agent.fast && model?.fast) };
}

/** The CLI's default model for a role when an agent moves to that CLI. */
export function defaultModelId(list: ProviderModels | null | undefined, engineDefault: string | undefined): string {
  if (engineDefault && (!list?.ok || list.models.some((m) => m.id === engineDefault))) return engineDefault;
  return list?.models.find((m) => m.isDefault)?.id ?? list?.models[0]?.id ?? engineDefault ?? "";
}
