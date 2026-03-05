/**
 * Resource Data Store
 *
 * Global per-ID cache for generation resource data.
 * Resources are fetched once and kept in the cache for the lifetime of the app.
 *
 * Fetching uses the same promise-cache pattern as fetchGenerationData:
 * - Per-ID in-flight tracking prevents duplicate parallel requests
 * - IDs already in the store are never re-fetched
 * - Multiple concurrent requestResourceIds calls with overlapping IDs share
 *   the same in-flight promise (no duplicate HTTP requests)
 *
 * The ResourceDataProvider uses this store and calls requestResourceIds
 * directly — no React Query overhead. The CompatibilityConfirmModal reads
 * from the store directly since it renders outside the provider tree.
 */

import { create } from 'zustand';
import type { GenerationResource } from '~/shared/types/generation.types';
import { trpcVanilla } from '~/utils/trpc';

// =============================================================================
// Types
// =============================================================================

/** Resource data with AIR identifier — matches the /api/generation/resources response */
export type ResourceData = GenerationResource & { air: string };

interface ResourceDataStoreState {
  /** Per-ID resource cache (never evicted) */
  resources: Map<number, ResourceData>;
  /** Store fetched resources into the cache */
  _setFetched: (resources: ResourceData[]) => void;
}

// =============================================================================
// Store
// =============================================================================

export const useResourceDataStore = create<ResourceDataStoreState>()((set) => ({
  resources: new Map(),

  _setFetched: (newResources) => {
    if (!newResources.length) return;
    set((state) => {
      const resources = new Map(state.resources);
      for (const r of newResources) {
        resources.set(r.id, r);
      }
      return { resources };
    });
  },
}));

// =============================================================================
// Fetch
// =============================================================================

/**
 * Per-ID in-flight promise cache.
 * When a batch request is in-flight for IDs [1, 2, 3], all three map to the
 * same promise. A subsequent requestResourceIds([2, 4]) call will skip ID 2
 * (already in-flight) and only fetch ID 4.
 */
const resourceFetchByIds = new Map<number, Promise<void>>();

/**
 * IDs that were requested but returned no result from the API.
 * These are skipped in future requestResourceIds calls to avoid infinite retries.
 */
const resourceNotFoundIds = new Set<number>();

/**
 * Request resource data for the given IDs.
 * IDs already in the store, currently being fetched, or previously not found are skipped.
 * The remaining uncached IDs are batched into a single fetch and results
 * are stored in the global resource-data store on completion.
 */
export function requestResourceIds(ids: number[]): void {
  const { resources } = useResourceDataStore.getState();
  const uncached = ids.filter(
    (id) => !resources.has(id) && !resourceFetchByIds.has(id) && !resourceNotFoundIds.has(id)
  );
  if (!uncached.length) return;

  const promise = trpcVanilla.generation.getResourceDataByIds
    .query({ ids: uncached })
    .then((data) => {
      useResourceDataStore.getState()._setFetched(data as ResourceData[]);

      const returnedIds = new Set(data.map((r) => r.id));
      for (const id of uncached) {
        resourceFetchByIds.delete(id);
        if (!returnedIds.has(id)) {
          resourceNotFoundIds.add(id);
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[ResourceData] version ID ${id} not found — skipping future fetches`);
          }
        }
      }
    })
    .catch(() => {
      for (const id of uncached) resourceFetchByIds.delete(id); // allow retry on error
    });

  for (const id of uncached) resourceFetchByIds.set(id, promise);
}
