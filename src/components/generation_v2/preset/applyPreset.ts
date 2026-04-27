import { fetchGenerationData, generationGraphStore } from '~/store/generation-graph.store';
import type { PresetValues } from '~/store/generation-preset.store';
import { useGenerationPresetStore } from '~/store/generation-preset.store';
import { RESOURCE_NODE_KEYS } from '~/shared/utils/resource.utils';

type ResourceRef = { id: number; strength?: number };

/**
 * Flatten every resource slot (model/upscaler/resources/vae/…future) into a
 * list of ids. Iterates `RESOURCE_NODE_KEYS` so new slots added to the shared
 * constant in `resource.utils.ts` automatically flow through here.
 */
function extractResourceIds(values: PresetValues): number[] {
  const ids = new Set<number>();
  for (const key of RESOURCE_NODE_KEYS) {
    const val = values[key];
    if (Array.isArray(val)) {
      for (const r of val as Array<{ id?: number }>) if (r?.id) ids.add(r.id);
    } else if (val && typeof (val as { id?: unknown }).id === 'number') {
      ids.add((val as { id: number }).id);
    }
  }
  return Array.from(ids);
}

/**
 * Hydrate a preset's resource refs and push the values into the generation form
 * via `generationGraphStore.setData`. `GenerationFormProvider` picks this up and
 * applies it to the graph as a `replay` run, reusing the same reset + set flow
 * that remix uses.
 *
 * Unavailable resources surface the standard unavailable-resource warning
 * because the fetch goes through the same `getGenerationData` pipeline.
 */
export async function applyPreset(preset: {
  id: number;
  name: string;
  userId: number;
  values: PresetValues;
}) {
  const ids = extractResourceIds(preset.values);
  const resources = ids.length
    ? (await fetchGenerationData({ type: 'modelVersions', ids })).resources
    : [];

  // Merge any strength overrides stored on the preset back onto the hydrated resources.
  const strengthById = new Map<number, number>();
  const rawResources = preset.values.resources as ResourceRef[] | undefined;
  if (Array.isArray(rawResources)) {
    for (const r of rawResources)
      if (r?.id && typeof r.strength === 'number') strengthById.set(r.id, r.strength);
  }
  const resourcesWithStrength = resources.map((r) => {
    const strength = strengthById.get(r.id);
    return strength !== undefined ? { ...r, strength } : r;
  });

  // Exclude every resource slot from params — GenerationFormProvider will
  // rebuild them from the hydrated resources array.
  const paramsWithoutResources: Record<string, unknown> = { ...preset.values };
  for (const key of RESOURCE_NODE_KEYS) delete paramsWithoutResources[key];

  generationGraphStore.setData({
    params: paramsWithoutResources,
    resources: resourcesWithStrength,
    runType: 'replay',
  });

  // `GenerationFormProvider` subscribes to the graph store and applies the
  // reset + set synchronously from the subscribe callback, so by the time
  // `setData` returns the graph reflects the applied preset. Read the live
  // snapshot and use that as the baseline — the graph normalizes some values
  // on set (e.g. resource metadata shape), and comparing against the raw
  // stored values would trigger a false-positive dirty state.
  const getFilteredSnapshot = useGenerationPresetStore.getState().bridge.getFilteredSnapshot;
  const live = getFilteredSnapshot?.();

  useGenerationPresetStore.getState().loadPreset({
    id: preset.id,
    name: preset.name,
    userId: preset.userId,
    values: live ?? preset.values,
  });
}
