import { ImageIngestionStatus, MediaType, MetricTimeframe, ReviewReactions } from '@prisma/client';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { FilterKeys, useFiltersContext } from '~/providers/FiltersProvider';
import { ImageSort } from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import { GetImagesByCategoryInput, GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { booleanString, numericString, numericStringArray } from '~/utils/zod-helpers';
import { isEqual } from 'lodash-es';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';

export const imagesQueryParamSchema = z
  .object({
    modelId: numericString(),
    modelVersionId: numericString(),
    postId: numericString(),
    collectionId: numericString(),
    username: z.coerce.string().transform(postgresSlugify),
    prioritizedUserIds: numericStringArray(),
    limit: numericString(),
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
    withMeta: booleanString(),
    section: z.enum(['images', 'reactions', 'draft']),
    hidden: z.coerce.boolean(),
    followed: z.coerce.boolean(),
  })
  .partial();

export const useImageQueryParams = () => useZodRouteParams(imagesQueryParamSchema);

export const useImageFilters = (type: FilterKeys<'images' | 'modelImages' | 'videos'>) => {
  const storeFilters = useFiltersContext((state) => state[type]);
  const { query } = useImageQueryParams(); // router params are the overrides
  return removeEmpty({ ...storeFilters, ...query });
};

export const useDumbImageFilters = (defaultFilters?: Partial<GetInfiniteImagesInput>) => {
  const [filters, setFilters] = useState<Partial<GetInfiniteImagesInput>>(defaultFilters ?? {});
  const filtersUpdated = !isEqual(filters, defaultFilters);

  return {
    filters,
    setFilters,
    filtersUpdated,
  };
};

export const useQueryImages = (
  filters?: Partial<GetInfiniteImagesInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  // const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.image.getInfinite.useInfiniteQuery(
    { ...filters },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );

  const currentUser = useCurrentUser();
  const {
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: loadingHidden,
  } = useHiddenPreferencesContext();

  const images = useMemo(() => {
    // TODO - fetch user reactions for images separately
    if (loadingHidden) return [];
    const arr = data?.pages.flatMap((x) => x.items) ?? [];
    const filtered = arr.filter((x) => {
      if (x.user.id === currentUser?.id) return true;
      if (x.ingestion !== ImageIngestionStatus.Scanned) return false;
      if (hiddenImages.get(x.id) && !filters?.hidden) return false;
      if (hiddenUsers.get(x.user.id)) return false;
      for (const tag of x.tagIds ?? []) if (hiddenTags.get(tag)) return false;
      return true;
    });
    return filtered;
  }, [data, currentUser, hiddenImages, hiddenTags, hiddenUsers, loadingHidden]);

  return { data, images, ...rest };
};

export const useQueryImageCategories = (
  filters?: Partial<GetImagesByCategoryInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  // const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.image.getImagesByCategory.useInfiniteQuery(
    { ...filters },
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
