import { showErrorNotification } from '~/utils/notifications';
import { dealQueryError } from '~/components/CreatorShop/Services/deals/deal-ui';
import { trpc } from '~/utils/trpc';
import type { RouterOutput } from '~/types/router';

export type ServiceDealView = RouterOutput['creatorServiceDeal']['get'];
export type ServiceDealSummary = RouterOutput['creatorServiceDeal']['listMine']['items'][number];

type TrpcishError = { message: string; data?: { code?: string } | null };

export const isConflict = (error: unknown) =>
  (error as TrpcishError | null)?.data?.code === 'CONFLICT';

/**
 * The app default is `staleTime: Infinity` with no refetch on focus, so a deal page or list that
 * was already cached kept its old data until a hard reload. The other party changes a deal
 * (delivers a round, sends a request) without this client's mutations ever running, so these
 * queries refetch on every open and on tab refocus.
 */
export const DEAL_FRESHNESS = {
  staleTime: 0,
  refetchOnMount: 'always',
  refetchOnWindowFocus: true,
} as const;

export function useServiceDeal(id: number) {
  const { data, isLoading, error, refetch } = trpc.creatorServiceDeal.get.useQuery(
    { id },
    { enabled: id > 0, retry: false, ...DEAL_FRESHNESS }
  );
  return {
    deal: data,
    isLoading,
    error: dealQueryError(error),
    refetch,
  };
}

export function useMyServiceDeals({
  role,
  status,
  enabled,
}: {
  role: 'buyer' | 'seller';
  status?: 'open' | 'closed';
  enabled: boolean;
}) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.creatorServiceDeal.listMine.useInfiniteQuery(
      { role, status, limit: 20 },
      { enabled, getNextPageParam: (last) => last.nextCursor, ...DEAL_FRESHNESS }
    );
  return {
    deals: data?.pages.flatMap((page) => page.items) ?? [],
    hiddenOffDomain: data?.pages[0]?.hiddenOffDomain ?? 0,
    isLoading,
    fetchNextPage,
    hasNextPage: !!hasNextPage,
    isFetchingNextPage,
  };
}

/**
 * Every deal mutation refetches the deal on success. A CONFLICT means the deal moved on under the
 * viewer (the other party acted, or a job ran), or an accept found the final files still being
 * checked: refetch, and pass on the server's reason.
 */
export function useServiceDealMutations(dealId: number) {
  const utils = trpc.useUtils();
  const refresh = async () => {
    await Promise.all([
      utils.creatorServiceDeal.get.invalidate({ id: dealId }),
      utils.creatorServiceDeal.listMine.invalidate(),
      // Accepting unlocks the final files, and a cancellation can hide them.
      utils.creatorServiceDealFile.list.invalidate({ dealId }),
    ]);
  };
  const onError = async (error: TrpcishError) => {
    if (isConflict(error)) {
      await refresh();
      showErrorNotification({
        title: 'Not updated',
        error: {
          message:
            error.message || 'It was updated while you were looking at it. Check the latest state.',
        },
      });
      return;
    }
    showErrorNotification({ title: 'Could not update the deal', error });
  };
  const options = { onSuccess: refresh, onError };

  return {
    accept: trpc.creatorServiceDeal.accept.useMutation(options),
    decline: trpc.creatorServiceDeal.decline.useMutation(options),
    withdraw: trpc.creatorServiceDeal.withdraw.useMutation(options),
    cancelLate: trpc.creatorServiceDeal.cancelLate.useMutation(options),
    requestCancellation: trpc.creatorServiceDeal.requestCancellation.useMutation(options),
    respondCancellation: trpc.creatorServiceDeal.respondCancellation.useMutation(options),
    acceptDelivery: trpc.creatorServiceDeal.acceptDelivery.useMutation(options),
    requestRevision: trpc.creatorServiceDeal.requestRevision.useMutation(options),
    openDispute: trpc.creatorServiceDeal.openDispute.useMutation(options),
  };
}
