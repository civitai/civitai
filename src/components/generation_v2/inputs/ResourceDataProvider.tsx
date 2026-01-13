/**
 * ResourceDataProvider
 *
 * Context provider for batch-fetching resource data by IDs.
 * Components can register resource IDs they need, and the provider
 * batches them into a single tRPC query.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import { trpc } from '~/utils/trpc';

// =============================================================================
// Types
// =============================================================================

export interface ResourceDataContextValue {
  /** Register a resource ID to be fetched */
  registerResourceId: (id: number) => void;
  /** Unregister a resource ID */
  unregisterResourceId: (id: number) => void;
  /** Get resource data by ID (returns undefined if not loaded) */
  getResourceData: (id: number) => (GenerationResource & { air: string }) | undefined;
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
}

export function ResourceDataProvider({ children }: ResourceDataProviderProps) {
  // Track which IDs are registered (using a Map for reference counting)
  const [registeredIds, setRegisteredIds] = useState<Map<number, number>>(new Map());

  // Get unique IDs to fetch
  const idsToFetch = useMemo(() => Array.from(registeredIds.keys()), [registeredIds]);

  // Batch fetch resources
  const { data, isLoading, fetchStatus } = trpc.generation.getResourceDataByIds.useQuery(
    { ids: idsToFetch },
    {
      enabled: idsToFetch.length > 0,
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false,
    }
  );

  // Create a map for quick lookup
  const resourceMap = useMemo(() => {
    const map = new Map<number, GenerationResource & { air: string }>();
    if (data) {
      for (const resource of data) {
        map.set(resource.id, resource);
      }
    }
    return map;
  }, [data]);

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

  // Check if a specific resource is loading
  const isResourceLoading = useCallback(
    (id: number) => {
      if (!registeredIds.has(id)) return false;
      return isLoading || fetchStatus === 'fetching';
    },
    [registeredIds, isLoading, fetchStatus]
  );

  const value = useMemo(
    () => ({
      registerResourceId,
      unregisterResourceId,
      getResourceData,
      isLoading,
      isResourceLoading,
    }),
    [registerResourceId, unregisterResourceId, getResourceData, isLoading, isResourceLoading]
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

  // Register/unregister via effect
  // Using simple pattern that works correctly with StrictMode's double-invoke
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
