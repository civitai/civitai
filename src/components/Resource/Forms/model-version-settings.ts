import type { ModelVersionUpsertInput } from '~/server/schema/model-version.schema';

type Settings = ModelVersionUpsertInput['settings'];

/**
 * Each recommended-settings block belongs to one model type and one opted-in ecosystem, and the
 * editor renders only the blocks that apply. A value left in the form from a template, a stale
 * draft or a base-model change is a leftover, not a choice: sent as-is, the server refuses the
 * whole save, so the blocks the editor did not render are dropped here.
 */
export function scopeRecommendedSettings(
  settings: Settings,
  rendered: { turboSection: boolean; turboLoraPicker: boolean }
): Settings {
  if (!settings) return settings;
  return {
    ...settings,
    generation: rendered.turboLoraPicker
      ? { turboLora: settings.generation?.turboLora }
      : undefined,
    turbo: rendered.turboSection ? settings.turbo : undefined,
  };
}
