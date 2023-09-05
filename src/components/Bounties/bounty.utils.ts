import { useMemo } from 'react';
import { GetInfiniteBountySchema } from '~/server/schema/bounty.schema';
import { trpc } from '~/utils/trpc';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';

export const useBountyFilters = () => {
  const storeFilters = useFiltersContext((state) => state.bounties);
  return removeEmpty(storeFilters);
};

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
