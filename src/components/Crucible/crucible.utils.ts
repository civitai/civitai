import { useMemo } from 'react';
import * as z from 'zod';
import type { GetCruciblesInfiniteSchema } from '~/server/schema/crucible.schema';
import { trpc } from '~/utils/trpc';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { CrucibleSort } from '~/server/common/enums';

const crucibleQueryParamsSchema = z.object({
  status: z.nativeEnum(CrucibleStatus).optional(),
  sort: z.nativeEnum(CrucibleSort).optional(),
});

export const useCrucibleFilters = () => {
  const storeFilters = useFiltersContext((state) => state.crucibles);
  const { query } = useCrucibleQueryParams();

  return removeEmpty({ ...storeFilters, ...query });
};

export const useCrucibleQueryParams = () => useZodRouteParams(crucibleQueryParamsSchema);

export const useQueryCrucibles = (
  filters: Partial<GetCruciblesInfiniteSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data, isLoading, ...rest } = trpc.crucible.getInfinite.useInfiniteQuery(
    { ...filters },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      ...options,
      trpc: { context: { skipBatch: true } },
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items: crucibles, loadingPreferences } = useApplyHiddenPreferences({
    type: 'crucibles',
    data: flatData,
    isRefetching: rest.isRefetching,
  });

  return { data, crucibles, isLoading: isLoading || loadingPreferences, ...rest };
};
