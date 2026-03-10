/**
 * ResourceDataProvider
 *
 * Context provider that coordinates resource data fetching for generation form
 * components. Components register the IDs they need; the provider batches them
 * and fetches only IDs not already in the global resource-data store.
 *
 * Fetching is done via requestResourceIds (direct fetch, same pattern as
 * fetchGenerationData) rather than a tRPC useQuery hook. This avoids React
 * Query cache-key churn: adding one ID no longer refetches all others.
 *
 * The CompatibilityConfirmModal reads from useResourceDataStore directly
 * since it renders outside this provider tree.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  useResourceDataStore,
  requestResourceIds,
  type ResourceData,
} from '~/store/resource-data.store';

// Re-export so existing consumers don't need to change their import paths.
export type { ResourceData };

// =============================================================================
// Types
// =============================================================================

export interface ResourceDataContextValue {
  /** Register a resource ID to be fetched */
  registerResourceId: (id: number) => void;
  /** Unregister a resource ID */
  unregisterResourceId: (id: number) => void;
  /** Get resource data by ID (returns undefined if not loaded) */
  getResourceData: (id: number) => ResourceData | undefined;
  /** All fetched resources for the IDs registered in this provider */
  resources: ResourceData[];
  /** Check if resources are currently loading */
  isLoading: boolean;
  /** Check if a specific resource is loading */
  isResourceLoading: (id: number) => boolean;
}

// =============================================================================
// Context
// =============================================================================

const ResourceDataContext = createContext<ResourceDataContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

interface ResourceDataProviderProps {
  children: React.ReactNode;
  /**
   * IDs to always include in the fetch, independent of component registrations.
   * Useful for pre-seeding the cache (e.g. ecosystem defaults at panel mount).
   * These are never removed, even when unregisterResourceId is called for them.
   */
  initialIds?: number[];
}

export function ResourceDataProvider({ children, initialIds }: ResourceDataProviderProps) {
  // Track which IDs are registered (using a Map for reference counting)
  const [registeredIds, setRegisteredIds] = useState<Map<number, number>>(new Map());

  // Combine initialIds (permanent) with component-registered IDs
  const idsToFetch = useMemo(
    () => [...new Set([...(initialIds ?? []), ...registeredIds.keys()])],
    [initialIds, registeredIds]
  );

  // Read from the global store
  const storeResources = useResourceDataStore((state) => state.resources);

  // IDs not yet in the store
  const uncachedIds = useMemo(
    () => idsToFetch.filter((id) => !storeResources.has(id)),
    [idsToFetch, storeResources]
  );

  // Fire a batched fetch for uncached IDs whenever the set changes.
  // requestResourceIds skips IDs already in-flight, so this is safe to call
  // on every uncachedIds change without risk of duplicate requests.
  useEffect(() => {
    if (uncachedIds.length > 0) requestResourceIds(uncachedIds);
  }, [uncachedIds]);

  // All fetched resources for the IDs this provider cares about (from store)
  const resources = useMemo(
    () => idsToFetch.map((id) => storeResources.get(id)).filter(Boolean) as ResourceData[],
    [idsToFetch, storeResources]
  );

  // Create a map for quick lookup
  const resourceMap = useMemo(() => {
    const map = new Map<number, ResourceData>();
    for (const resource of resources) {
      map.set(resource.id, resource);
    }
    return map;
  }, [resources]);

  // Register a resource ID with reference counting
  const registerResourceId = useCallback((id: number) => {
    setRegisteredIds((prev) => {
      const count = prev.get(id) ?? 0;
      const next = new Map(prev);
      next.set(id, count + 1);
      return next;
    });
  }, []);

  // Unregister a resource ID
  const unregisterResourceId = useCallback((id: number) => {
    setRegisteredIds((prev) => {
      const count = prev.get(id) ?? 0;
      if (count <= 1) {
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      const next = new Map(prev);
      next.set(id, count - 1);
      return next;
    });
  }, []);

  // Get resource data by ID
  const getResourceData = useCallback((id: number) => resourceMap.get(id), [resourceMap]);

  // A resource is loading if it's registered but not yet in the store
  const isResourceLoading = useCallback(
    (id: number) => registeredIds.has(id) && !storeResources.has(id),
    [registeredIds, storeResources]
  );

  // Overall loading: any of our registered IDs not yet in the store
  const effectiveIsLoading = uncachedIds.some((id) => registeredIds.has(id));

  const value = useMemo(
    () => ({
      registerResourceId,
      unregisterResourceId,
      getResourceData,
      resources,
      isLoading: effectiveIsLoading,
      isResourceLoading,
    }),
    [
      registerResourceId,
      unregisterResourceId,
      getResourceData,
      resources,
      effectiveIsLoading,
      isResourceLoading,
    ]
  );

  return <ResourceDataContext.Provider value={value}>{children}</ResourceDataContext.Provider>;
}

// =============================================================================
// Hooks
// =============================================================================

export function useResourceDataContext(): ResourceDataContextValue {
  const context = useContext(ResourceDataContext);
  if (!context) {
    throw new Error('useResourceDataContext must be used within a ResourceDataProvider');
  }
  return context;
}

/**
 * Hook to get resource data by ID.
 * Automatically registers/unregisters the ID with the provider.
 */
export function useResourceData(id: number | undefined) {
  const { registerResourceId, unregisterResourceId, getResourceData, isResourceLoading } =
    useResourceDataContext();

  useEffect(() => {
    if (id == null) return;
    registerResourceId(id);
    return () => {
      unregisterResourceId(id);
    };
  }, [id, registerResourceId, unregisterResourceId]);

  return {
    data: id != null ? getResourceData(id) : undefined,
    isLoading: id != null ? isResourceLoading(id) : false,
  };
}
