/**
 * Generation V2 Utilities
 *
 * Shared utility functions for the generation form.
 */

import type { GenerationResource } from '~/shared/types/generation.types';

// =============================================================================
// Snapshot Filtering
// =============================================================================

export interface FilterSnapshotOptions {
  /** Keys of computed nodes to filter out (derived values, not input) */
  computedKeys?: string[];
}

/**
 * Check if a single resource should be filtered out from submission.
 * Uses server-computed canGenerate flag which is the definitive "can use" check.
 */
export function shouldFilterResource(resource: GenerationResource | undefined): boolean {
  if (!resource) return true;
  return resource.canGenerate === false;
}

/**
 * `trainedWords` is a LoRA's trigger-word list. It's the only per-resource field
 * that grows unboundedly with resource count, and the request doesn't need it:
 * client-side trigger injection already ran (the `triggerWords` computed node), and
 * the server re-enriches trained words via `getResourceData`. Carrying it inflates the
 * whatIf GET's encoded URL and can trip the batch link's `maxURLLength` cap once several
 * resources are added — so strip it from every resource before whatIf/submit.
 */
function stripResourceRequestBloat<T>(resource: T): T {
  if (!resource || typeof resource !== 'object') return resource;
  if (!('trainedWords' in (resource as Record<string, unknown>))) return resource;
  const { trainedWords, ...rest } = resource as Record<string, unknown>;
  return rest as T;
}

/**
 * Filter a graph snapshot before submission or whatIf query.
 * - Removes computed nodes (derived values)
 * - Removes resources where canGenerate is false (user can't use them)
 *
 * @param snapshot - The graph snapshot data
 * @param options - Filter options
 * @returns A new snapshot with computed nodes and unusable resources filtered out
 */
export function filterSnapshotForSubmit<T extends Record<string, unknown>>(
  snapshot: T,
  options: FilterSnapshotOptions = {}
): T {
  const { computedKeys = [] } = options;

  // Filter out computed nodes
  const filtered = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !computedKeys.includes(key))
  ) as Record<string, unknown>;

  // Filter out disabled resources from the resources array
  if (filtered.resources && Array.isArray(filtered.resources)) {
    filtered.resources = (filtered.resources as GenerationResource[])
      .filter((resource) => !shouldFilterResource(resource))
      .map(stripResourceRequestBloat);
  }

  // Clear VAE if it's disabled
  if (filtered.vae && shouldFilterResource(filtered.vae as GenerationResource)) {
    filtered.vae = undefined;
  } else if (filtered.vae) {
    filtered.vae = stripResourceRequestBloat(filtered.vae as GenerationResource);
  }

  return filtered as T;
}
