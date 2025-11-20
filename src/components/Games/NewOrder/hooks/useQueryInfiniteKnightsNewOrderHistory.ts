import { useMemo } from 'react';
import type { GetHistoryInput } from '~/server/schema/games/new-order.schema';
import { trpc } from '~/utils/trpc';
import { useJoinKnightsNewOrder } from '../hooks/useJoinKnightsNewOrder';

export const useQueryInfiniteKnightsNewOrderHistory = (
  filter?: Partial<GetHistoryInput>,
  opts?: { enabled?: boolean }
) => {
  const { playerData } = useJoinKnightsNewOrder();
  const { data, ...rest } = trpc.games.newOrder.getHistory.useInfiniteQuery(
    { limit: 10, ...filter },
    {
      ...opts,
      enabled: !!playerData && opts?.enabled !== false,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  return { images: flatData, ...rest };
};
