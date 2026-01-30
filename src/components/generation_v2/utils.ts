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
    filtered.resources = (filtered.resources as GenerationResource[]).filter(
      (resource) => !shouldFilterResource(resource)
    );
  }

  // Clear VAE if it's disabled
  if (filtered.vae && shouldFilterResource(filtered.vae as GenerationResource)) {
    filtered.vae = undefined;
  }

  return filtered as T;
}
