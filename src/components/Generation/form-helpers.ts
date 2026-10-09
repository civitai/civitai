/**
 * Resource shaping and the last-used/prefetch version lookups for the generation form.
 */

import type { ResourceData } from '~/shared/generation/values';
import {
  allEcosystemDefaultVersionIds,
  ecosystemByKey,
  getEcosystemGroup,
} from '~/shared/constants/basemodel.constants';
import { isRawAirResource } from '~/shared/utils/air';
import type { GenerationResource } from '~/shared/types/generation.types';

const STORAGE_KEY = 'generation-graph';
/**
 * Returns all model version IDs to prefetch for the compatibility modal:
 * ecosystem defaults + last-used checkpoints for every ecosystem in localStorage.
 *
 * Both GenerationTabs (prefetch) and the modal use this function so their
 * query keys always match, guaranteeing an instant cache hit when the modal opens.
 */
export function getAllEcosystemVersionIdsForPrefetch(): number[] {
  const ids = new Set(allEcosystemDefaultVersionIds);
  for (const [key] of ecosystemByKey) {
    const lastUsedId = getLastUsedCheckpointIdForEcosystem(key);
    if (lastUsedId) ids.add(lastUsedId);
  }
  return [...ids];
}

/**
 * Returns the last-used model version ID for a given ecosystem key.
 * Reads from the ecosystem-scoped localStorage entry written by the storage adapter.
 * Returns undefined if no previous selection exists.
 */
export function getLastUsedCheckpointIdForEcosystem(ecosystemKey: string): number | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  const eco = ecosystemByKey.get(ecosystemKey);
  if (!eco) return undefined;

  const group = getEcosystemGroup(eco.id);
  const scopeKey = group ? group.id : eco.key;

  try {
    const stored = localStorage.getItem(`${STORAGE_KEY}.ecosystem.${scopeKey}`);
    if (!stored) return undefined;
    const values = JSON.parse(stored) as Record<string, unknown>;
    const modelId = (values?.model as { id?: unknown } | undefined)?.id;
    return typeof modelId === 'number' ? modelId : undefined;
  } catch {
    return undefined;
  }
}

/** Convert GenerationResource to ResourceData (matching `shared/generation/values`).
 * Resources arriving from the cross-domain handoff or storage may be partially
 * hydrated — `trainedWords` and `model.type` can be missing — so guard both. */
export function toResourceData(r: GenerationResource): ResourceData {
  if (r.epochDetails) return r; // Shouldn't need to get fresh data for resources with epochDetails since they have all necessary info for compatibility checks (type, baseModel, epochNumber) and aren't selectable in the UI
  if (isRawAirResource(r)) return r; // Raw-AIR resources are self-contained (no ModelVersion row) — pass through whole so air/workflowId survive to submission
  return {
    id: r.id,
    baseModel: r.baseModel,
    model: { type: r.model?.type as ResourceData['model']['type'] },
    strength: r.strength,
    trainedWords: r.trainedWords && r.trainedWords.length > 0 ? r.trainedWords : undefined,
  };
}
