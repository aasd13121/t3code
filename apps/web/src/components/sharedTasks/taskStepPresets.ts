import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { m } from "../../i18n/messages";

/** A model reference inside a preset step: provider instance plus one of its models. */
export const TaskStepPresetModel = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
  label: Schema.optional(Schema.String),
});
export type TaskStepPresetModel = typeof TaskStepPresetModel.Type;

export const TaskStepPresetStep = Schema.Struct({
  title: Schema.String,
  model: Schema.optional(TaskStepPresetModel),
});
export type TaskStepPresetStep = typeof TaskStepPresetStep.Type;

export const TaskStepPreset = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  steps: Schema.Array(TaskStepPresetStep).check(Schema.isMaxLength(100)),
});
export type TaskStepPreset = typeof TaskStepPreset.Type;

const StoredPresets = Schema.Array(TaskStepPreset).check(Schema.isMaxLength(50));

/** Ships with the board; cannot be deleted from the picker. */
const DEFAULT_STEP_PRESET: TaskStepPreset = {
  id: "default-phases",
  name: m(msg("Plan / Execute / Review / Test")),
  steps: [
    { title: m(msg("Plan")) },
    { title: m(msg("Execute")) },
    { title: m(msg("Review")) },
    { title: m(msg("Test")) },
  ],
};

const STORAGE_KEY = "t3code:task-step-presets:v1";

export function useTaskStepPresets() {
  const [saved, setSaved] = useLocalStorage(STORAGE_KEY, [] as TaskStepPreset[], StoredPresets);
  return {
    presets: [DEFAULT_STEP_PRESET, ...saved],
    savedCount: saved.length,
    save: (preset: TaskStepPreset) =>
      setSaved((current) => [...current.filter((entry) => entry.id !== preset.id), preset]),
    remove: (id: string) => setSaved((current) => current.filter((entry) => entry.id !== id)),
  };
}

/** Suggested step titles for inputs: the built-in phases plus every preset's titles. */
export function stepTitleSuggestions(presets: ReadonlyArray<TaskStepPreset>): string[] {
  return collectTitles(presets);
}

function collectTitles(presets: ReadonlyArray<TaskStepPreset>): string[] {
  return [...new Set(presets.flatMap((preset) => preset.steps.map((step) => step.title)))].slice(
    0,
    50,
  );
}

/** Encodes a preset model as a single select value; "none" means no model. */
export function presetModelValue(model: { instanceId: string; model: string } | undefined): string {
  return model ? JSON.stringify([model.instanceId, model.model]) : "none";
}

export function parsePresetModelValue(
  value: string,
): { instanceId: string; model: string } | undefined {
  if (!value || value === "none") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { instanceId: parsed[0], model: parsed[1] };
    }
  } catch {
    // Fall through: an unreadable value simply means no model.
  }
  return undefined;
}
