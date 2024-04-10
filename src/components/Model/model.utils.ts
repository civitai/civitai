import { MetricTimeframe, ModelStatus } from '@prisma/client';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { ModelSort } from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import { GetAllModelsInput, ToggleCheckpointCoverageInput } from '~/server/schema/model.schema';
import { usernameSchema } from '~/server/schema/user.schema';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { constants } from '~/server/common/constants';
import { isEqual } from 'lodash-es';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';

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
    favorites: z.coerce.boolean(),
    hidden: z.coerce.boolean(),
    archived: z.coerce.boolean(),
    followed: z.coerce.boolean(),
    view: z.enum(['categories', 'feed']),
    section: z.enum(['published', 'draft', 'training']),
    collectionId: z.coerce.number(),
    excludedTagIds: z.array(z.coerce.number()),
    excludedImageTagIds: z.array(z.coerce.number()),
    baseModels: z.preprocess(
      (val) => (Array.isArray(val) ? val : [val]),
      z.array(z.enum(constants.baseModels))
    ),
    clubId: z.coerce.number().optional(),
  })
  .partial();
export type ModelQueryParams = z.output<typeof modelQueryParamSchema>;
export const useModelQueryParams = () => {
  const { query, pathname, replace } = useRouter();

  return useMemo(() => {
    const result = modelQueryParamSchema.safeParse(query);
    const data: ModelQueryParams = result.success ? result.data : {};

    return {
      ...data,
      set: (filters: Partial<ModelQueryParams>, pathnameOverride?: string) => {
        replace(
          {
            pathname: pathnameOverride ?? pathname,
            query: removeEmpty({ ...query, ...filters }),
          },
          undefined,
          {
            shallow: !pathnameOverride || pathname === pathnameOverride,
          }
        );
      },
    };
  }, [query, pathname, replace]);
};

export const useModelQueryParams2 = () => useZodRouteParams(modelQueryParamSchema);

export const useModelFilters = () => {
  const storeFilters = useFiltersContext((state) => state.models);
  return removeEmpty(storeFilters);
};

export const useDumbModelFilters = (defaultFilters?: Partial<Omit<GetAllModelsInput, 'page'>>) => {
  const [filters, setFilters] = useState<Partial<Omit<GetAllModelsInput, 'page'>>>(
    defaultFilters ?? {}
  );
  const filtersUpdated = !isEqual(filters, defaultFilters);

  return {
    filters,
    setFilters,
    filtersUpdated,
  };
};

export type UseQueryModelReturn = ReturnType<typeof useQueryModels>['models'];
export const useQueryModels = (
  filters?: Partial<Omit<GetAllModelsInput, 'page'>>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const _filters = filters ?? {};
  const queryUtils = trpc.useUtils();
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, ...rest } = trpc.model.getAll.useInfiniteQuery(
    { ..._filters, browsingLevel },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      keepPreviousData: true,
      onError: (error) => {
        queryUtils.model.getAll.setInfiniteData(
          { ..._filters, browsingLevel },
          (oldData) => oldData ?? data
        );
        showErrorNotification({
          title: 'Failed to fetch data',
          error: new Error(`Something went wrong: ${error.message}`),
        });
      },
      ...options,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items, loadingPreferences } = useApplyHiddenPreferences({
    type: 'models',
    data: flatData,
    showHidden: !!_filters.hidden,
    showImageless: (_filters.status ?? []).includes(ModelStatus.Draft),
    isRefetching: rest.isRefetching,
    hiddenTags: _filters.excludedTagIds,
  });

  return { data, models: items, isLoading: isLoading || loadingPreferences, ...rest };
};

export const useToggleCheckpointCoverageMutation = () => {
  const queryUtils = trpc.useUtils();

  const toggleMutation = trpc.model.toggleCheckpointCoverage.useMutation({
    onSuccess: (_, { id, versionId }) => {
      queryUtils.model.getById.setData({ id }, (old) => {
        if (!old) return old;

        return {
          ...old,
          modelVersions: old.modelVersions.map((v) =>
            v.id === versionId ? { ...v, canGenerate: !v.canGenerate } : v
          ),
        };
      });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to toggle checkpoint coverage',
        error: new Error(error.message),
      });
    },
  });

  const handleToggle = (data: ToggleCheckpointCoverageInput) => {
    return toggleMutation.mutateAsync(data);
  };

  return { ...toggleMutation, toggle: handleToggle };
};
