import { useMemo } from 'react';
import type { GetPlayersInfiniteSchema } from '~/server/schema/games/new-order.schema';
import { trpc } from '~/utils/trpc';

export const useQueryPlayersInfinite = (
  filters?: Partial<GetPlayersInfiniteSchema>,
  opts?: { enabled?: boolean }
) => {
  const { data, ...rest } = trpc.games.newOrder.getPlayers.useInfiniteQuery(
    { ...filters },
    {
      ...opts,
      enabled: opts?.enabled !== false,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );
  const flatData = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  return { players: flatData, ...rest };
};
