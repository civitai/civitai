import { MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { useDeferredValue, useMemo } from 'react';
import { z } from 'zod';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { ModelSort } from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import { GetAllModelsInput, GetModelsByCategoryInput } from '~/server/schema/model.schema';
import { usernameSchema } from '~/server/schema/user.schema';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { constants } from '~/server/common/constants';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isDefined } from '~/utils/type-guards';

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
    view: z.enum(['categories', 'feed']),
    section: z.enum(['published', 'draft']),
    collectionId: z.coerce.number(),
    excludedTagIds: z.array(z.coerce.number()),
    excludedImageTagIds: z.array(z.coerce.number()),
    baseModels: z.preprocess(
      (val) => (Array.isArray(val) ? val : [val]),
      z.array(z.enum(constants.baseModels))
    ),
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

export type UseQueryModelReturn = ReturnType<typeof useQueryModels>['models'];
export const useQueryModels = (
  filters?: Partial<Omit<GetAllModelsInput, 'page'>>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const queryUtils = trpc.useContext();
  const { data, ...rest } = trpc.model.getAll.useInfiniteQuery(filters, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
    trpc: { context: { skipBatch: true } },
    keepPreviousData: true,
    onError: (error) => {
      filters ??= {}; // Just to prevent ts error
      queryUtils.model.getAll.setInfiniteData(filters, (oldData) => oldData ?? data);
      showErrorNotification({
        title: 'Failed to fetch data',
        error: new Error(`Something went wrong: ${error.message}`),
      });
    },
    ...options,
  });

  const currentUser = useCurrentUser();
  const {
    models: hiddenModels,
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
  } = useHiddenPreferencesContext();
  const models = useMemo(() => {
    const arr = data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [];
    console.time('filter');
    const filtered = arr
      .filter((x) => {
        if (x.user.id === currentUser?.id) return true;
        if (hiddenUsers.get(x.user.id)) return false;
        if (hiddenModels.get(x.id)) return false;
        for (const tag of x.tags) if (hiddenTags.get(tag)) return false;
        return true;
      })
      .map(({ images, ...x }) => {
        const filteredImages = images?.filter((i) => {
          if (hiddenImages.get(i.id)) return false;
          for (const tag of i.tags ?? []) {
            if (hiddenTags.get(tag)) return false;
          }
          return true;
        });
        if (!filteredImages?.length) return null;

        return {
          ...x,
          image: filteredImages[0],
        };
      })
      .filter(isDefined);
    console.timeEnd('filter');

    return filtered;
  }, [data, hiddenModels, hiddenImages, hiddenTags, hiddenUsers, currentUser]);

  return { data, models, ...rest };
};

export const useQueryModelCategories = (
  filters?: Partial<GetModelsByCategoryInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.model.getByCategory.useInfiniteQuery(
    { ...filters, browsingMode },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      trpc: { context: { skipBatch: true } },
      keepPreviousData: true,
      ...options,
    }
  );

  const categories = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return { data, categories, ...rest };
};
