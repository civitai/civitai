import { MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { z } from 'zod';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { ModelSort } from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import { GetAllModelsInput } from '~/server/schema/model.schema';
import { usernameSchema } from '~/server/schema/user.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export const useModelFilters = () => {
  const storeFilters = useFiltersContext((state) => state.models);
  return removeEmpty(storeFilters);
};

const modelQueryParamSchema = z
  .object({
    period: z.nativeEnum(MetricTimeframe),
    periodMode: periodModeSchema,
    sort: z.nativeEnum(ModelSort),
    query: z.string(),
    user: z.string(),
    username: usernameSchema.transform(postgresSlugify),
    tagname: z.string(),
    tag: z.string(),
    favorites: z.preprocess((val) => val === true || val === 'true', z.boolean()),
    hidden: z.preprocess((val) => val === true || val === 'true', z.boolean()),
    view: z.enum(['categories', 'feed']),
  })
  .partial();
export type ModelQueryParams = z.output<typeof modelQueryParamSchema>;
export const useModelQueryParams = () => {
  const { query, pathname, replace } = useRouter();

  return useMemo(() => {
    const result = modelQueryParamSchema.safeParse(query);
    const data: ModelQueryParams = result.success ? result.data : { view: 'categories' };

    return {
      ...data,
      set: (filters: Partial<ModelQueryParams>) => {
        replace({ pathname, query: { ...query, ...filters } }, undefined, { shallow: true });
      },
    };
  }, [query, pathname, replace]);
};

export const useQueryModels = (
  filters?: Partial<Omit<GetAllModelsInput, 'page'>>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const { data, ...rest } = trpc.model.getAll.useInfiniteQuery(filters, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
    trpc: { context: { skipBatch: true } },
    ...options,
  });

  const models = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [], [data]);

  return { data, models, ...rest };
};
