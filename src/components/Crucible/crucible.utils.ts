import { useMemo } from 'react';
import * as z from 'zod';
import type { GetCruciblesInfiniteSchema } from '~/server/schema/crucible.schema';
import { trpc } from '~/utils/trpc';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { commaDelimitedEnumArray } from '~/utils/zod-helpers';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { CrucibleSort } from '~/server/common/enums';
import { CRUCIBLE_CONTENT_TYPES } from '~/shared/constants/crucible.constants';

const crucibleQueryParamsSchema = z.object({
  status: commaDelimitedEnumArray(Object.values(CrucibleStatus)).optional(),
  contentType: z.enum(CRUCIBLE_CONTENT_TYPES).optional(),
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
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, ...rest } = trpc.crucible.getInfinite.useInfiniteQuery(
    { ...filters, browsingLevel },
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
