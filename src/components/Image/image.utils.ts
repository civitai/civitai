import { MediaType, MetricTimeframe, ReviewReactions } from '@prisma/client';
import { useMemo } from 'react';
import { z } from 'zod';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useFiltersContext, FilterKeys } from '~/providers/FiltersProvider';
import { ImageSort } from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import { GetImagesByCategoryInput, GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { numericString, numericStringArray } from '~/utils/zod-helpers';

export const imagesQueryParamSchema = z
  .object({
    modelId: numericString(),
    modelVersionId: numericString(),
    postId: numericString(),
    collectionId: numericString(),
    username: z.coerce.string().transform(postgresSlugify),
    prioritizedUserIds: numericStringArray(),
    period: z.nativeEnum(MetricTimeframe),
    periodMode: periodModeSchema,
    sort: z.nativeEnum(ImageSort),
    tags: numericStringArray(),
    view: z.enum(['categories', 'feed']),
    excludeCrossPosts: z.boolean(),
    reactions: z.preprocess(
      (val) => (Array.isArray(val) ? val : [val]),
      z.array(z.nativeEnum(ReviewReactions))
    ),
    types: z.preprocess(
      (val) => (Array.isArray(val) ? val : [val]),
      z.array(z.nativeEnum(MediaType))
    ),
    withMeta: z.coerce.boolean(),
    section: z.enum(['images', 'reactions']),
  })
  .partial();

export const useImageQueryParams = () => useZodRouteParams(imagesQueryParamSchema);

export const useImageFilters = (type: FilterKeys<'images' | 'modelImages'>) => {
  const storeFilters = useFiltersContext((state) => state[type]);
  const { query } = useImageQueryParams(); // router params are the overrides
  return removeEmpty({ ...storeFilters, ...query });
};

export const useQueryImages = (
  filters?: Partial<GetInfiniteImagesInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.image.getInfinite.useInfiniteQuery(
    { ...filters, browsingMode },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );

  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return { data, images, ...rest };
};

export const useQueryImageCategories = (
  filters?: Partial<GetImagesByCategoryInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.image.getImagesByCategory.useInfiniteQuery(
    { ...filters, browsingMode },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      keepPreviousData: true,
      ...options,
    }
  );

  const categories = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return { data, categories, ...rest };
};
