import { trpc } from '~/utils/trpc';

/**
 * Hook to fetch and track queue status for comics generation.
 * Returns the same queue status info that the main generator uses.
 */
export function useComicsQueueStatus() {
  const { data, isLoading, error, refetch } = trpc.comics.getQueueStatus.useQuery(undefined, {
    // Poll every 5 seconds when window is focused
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    // Cache for 3 seconds to prevent excessive calls
    staleTime: 3000,
  });

  return {
    /** Number of queue slots currently in use */
    used: data?.used ?? 0,
    /** Total queue slots for this user tier */
    limit: data?.limit ?? 4,
    /** Number of available slots (limit - used) */
    available: data?.available ?? 0,
    /** Whether the user can generate (has slots and generation is available) */
    canGenerate: data?.canGenerate ?? false,
    /** Whether the query is loading */
    isLoading,
    /** Error if any */
    error,
    /** Refetch the queue status manually */
    refetch,
  };
}
