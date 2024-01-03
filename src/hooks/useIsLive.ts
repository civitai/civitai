import { trpc } from '~/utils/trpc';

const REFETCH_INTERVAL = 1000 * 60 * 5;
export function useIsLive() {
  const { data: isLive, isLoading } = trpc.system.getLiveNow.useQuery(undefined, {
    refetchInterval: REFETCH_INTERVAL,
    refetchOnWindowFocus: true,
    staleTime: REFETCH_INTERVAL,
    trpc: { context: { skipBatch: true } },
  });

  return !isLoading && isLive;
}
