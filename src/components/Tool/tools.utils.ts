import { useMemo } from 'react';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { GetAllToolsSchema } from '~/server/schema/tool.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

export const useToolFilters = () => {
  const storeFilters = useFiltersContext((state) => state.tools);
  return removeEmpty(storeFilters);
};

export function useQueryTools(opts?: {
  filters?: GetAllToolsSchema;
  options?: { enabled?: boolean };
}) {
  const { filters, options } = opts || {};
  const { data, isLoading, isRefetching, fetchNextPage, hasNextPage } =
    trpc.tool.getAll.useInfiniteQuery(
      { ...filters },
      {
        ...options,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? null,
        keepPreviousData: true,
      }
    );

  const tools = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  return { tools, loading: isLoading, refetching: isRefetching, fetchNextPage, hasNextPage };
}
