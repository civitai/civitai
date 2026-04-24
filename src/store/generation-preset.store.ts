/**
 * Generation Preset Store
 *
 * Session-only state for the currently-loaded generation preset. Holds the
 * preset id + the snapshot of values that were applied so dirty detection
 * can diff the live graph state against it.
 */

import { isEqual } from 'lodash-es';
import { create } from 'zustand';

/**
 * Keys that are never stored in a preset.
 *
 * Kept in sync with the server-side PRESET_EXCLUDED_KEYS in
 * `src/server/schema/generation-preset.schema.ts`. Changes to either must
 * update the other — a value excluded on save must not mark the preset dirty.
 */
export const PRESET_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  'images',
  'video',
  'priority',
  'outputFormat',
  'quantity',
  'output',
  'input',
]);

export type PresetValues = Record<string, unknown>;

export function filterPresetValues(
  snapshot: Record<string, unknown>,
  isComputed?: (key: string) => boolean
): PresetValues {
  const out: PresetValues = {};
  for (const key of Object.keys(snapshot)) {
    if (PRESET_EXCLUDED_KEYS.has(key)) continue;
    if (isComputed?.(key)) continue;
    out[key] = snapshot[key];
  }
  return out;
}

type ActivePreset = { id: number; name: string; userId: number; values: PresetValues };

/**
 * Bridge that exposes graph state from inside `GenerationFormProvider` to
 * consumers that live outside the DataGraphProvider (e.g. the preset button
 * in the generation tabs header). Populated by a hook inside the form.
 */
type GraphBridge = {
  ecosystem: string | null;
  getFilteredSnapshot: (() => PresetValues) | null;
};

type State = {
  activePresetId: number | null;
  activePresetName: string | null;
  activePresetUserId: number | null;
  activePresetValues: PresetValues | null;
  bridge: GraphBridge;
  loadPreset: (preset: ActivePreset) => void;
  closePreset: () => void;
  /** Update the baseline values (e.g. after save). Clears dirty as a side effect. */
  markClean: (values: PresetValues, nextName?: string) => void;
  setBridge: (bridge: Partial<GraphBridge>) => void;
  clearBridge: () => void;
};

const EMPTY_BRIDGE: GraphBridge = { ecosystem: null, getFilteredSnapshot: null };

export const useGenerationPresetStore = create<State>((set) => ({
  activePresetId: null,
  activePresetName: null,
  activePresetUserId: null,
  activePresetValues: null,
  bridge: EMPTY_BRIDGE,
  loadPreset: (preset) =>
    set({
      activePresetId: preset.id,
      activePresetName: preset.name,
      activePresetUserId: preset.userId,
      activePresetValues: preset.values,
    }),
  closePreset: () =>
    set({
      activePresetId: null,
      activePresetName: null,
      activePresetUserId: null,
      activePresetValues: null,
    }),
  markClean: (values, nextName) =>
    set((state) => ({
      activePresetValues: values,
      activePresetName: nextName ?? state.activePresetName,
    })),
  setBridge: (bridge) =>
    set((state) => ({ bridge: { ...state.bridge, ...bridge } })),
  clearBridge: () => set({ bridge: EMPTY_BRIDGE }),
}));

/**
 * True when any key that exists in `baseline` differs from the value in
 * `current`. Keys that are only in `current` (not in the preset) are ignored —
 * the graph may have additional default-valued nodes the preset never captured,
 * and those shouldn't count as modifications.
 */
export function isPresetDirty(
  baseline: PresetValues | null,
  current: Record<string, unknown>,
  isComputed?: (key: string) => boolean
): boolean {
  if (!baseline) return false;
  for (const key of Object.keys(baseline)) {
    if (PRESET_EXCLUDED_KEYS.has(key)) continue;
    if (isComputed?.(key)) continue;
    if (!isEqual(current[key], baseline[key])) return true;
  }
  return false;
}
