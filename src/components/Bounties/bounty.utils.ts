import { useMemo } from 'react';
import { GetInfiniteBountySchema } from '~/server/schema/bounty.schema';
import { trpc } from '~/utils/trpc';

export const useQueryBounties = (
  filters: Partial<GetInfiniteBountySchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data, ...rest } = trpc.bounty.getInfinite.useInfiniteQuery(filters, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...options,
  });

  const bounties = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  return { data, bounties, ...rest };
};
