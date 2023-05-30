import { isDefined } from '~/utils/type-guards';
import { MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode, ModelSort } from '~/server/common/enums';
import { GetAllInput } from '~/server/edge-services/model/schemas';
import { periodModeSchema } from '~/server/schema/base.schema';
import { GetAllModelsInput, GetModelsByCategoryInput } from '~/server/schema/model.schema';
import { usernameSchema } from '~/server/schema/user.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { ModelsInfinite } from '~/server/edge-services/model/getInfinite';
import { useHiddenPreferences } from '~/hooks/user-preferences/useHiddenPreferences';

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
    section: z.enum(['published', 'draft']),
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

export const useQueryInfiniteModels = (
  filters: Omit<GetAllInput, 'browsingMode'>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { imageIds, userIds, modelIds, tagIds } = useHiddenPreferences({
    users: true,
    tags: true,
    models: true,
    images: true,
  });

  const { data, ...rest } = trpc.model.getInfinite.useInfiniteQuery(
    {
      ...filters,
    },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );
  const models = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [], [data]);

  // get user preferences here
  const preferredModels = useModelsWithPreferences(models, { tagIds, imageIds, userIds, modelIds });

  return { data, models: preferredModels, ...rest };
};

export type ModelsInfiniteDetail = ReturnType<typeof useModelsWithPreferences>[number];
const useModelsWithPreferences = (
  models: ModelsInfinite,
  {
    userIds,
    imageIds,
    modelIds,
    tagIds,
  }: { userIds: number[]; imageIds: number[]; modelIds: number[]; tagIds: number[] }
) => {
  // get user preferences here
  const preferredModels = useMemo(
    () =>
      models
        .map(({ images, ...model }) => {
          const [image] = images.filter(
            (image) => !imageIds.includes(image.id) && !tagIds.some((x) => image.tags.includes(x))
          );
          if (!image) return null;
          return { ...model, image };
        })
        .filter(
          (model) =>
            !!model &&
            !modelIds.includes(model.id) &&
            !userIds.includes(model.user.id) &&
            !tagIds.some((x) => model.tags.includes(x))
        )
        .filter(isDefined),
    [imageIds, modelIds, models, tagIds, userIds]
  );

  return preferredModels;
};
