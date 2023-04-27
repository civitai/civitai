import { MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { z } from 'zod';
import { useFiltersContext, FilterKeys } from '~/providers/FiltersProvider';
import { ImageSort } from '~/server/common/enums';
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
    username: z.string().transform(postgresSlugify),
    prioritizedUserIds: numericStringArray(),
    limit: numericString(),
    period: z.nativeEnum(MetricTimeframe),
    sort: z.nativeEnum(ImageSort),
    tags: numericStringArray(),
    view: z.enum(['categories', 'feed']),
    excludeCrossPosts: z.boolean(),
  })
  .partial();

type ImageQueryParams = z.output<typeof imagesQueryParamSchema>;
export const parseImagesQuery = (params: unknown) => {
  const result = imagesQueryParamSchema.safeParse(params);
  return result.success ? result.data : {};
};

export const useImageQueryParams = () => {
  const { query, pathname, replace } = useRouter();

  return useMemo(() => {
    const result = imagesQueryParamSchema.safeParse(query);
    const data: ImageQueryParams = result.success ? result.data : { view: 'categories' };

    return {
      ...data,
      set: (filters: Partial<ImageQueryParams>) => {
        replace({ pathname, query: { ...query, ...filters } }, undefined, { shallow: true });
      },
    };
  }, [query, pathname, replace]);
};

export const useImageFilters = (type: FilterKeys<'images' | 'modelImages'>) => {
  const router = useRouter();
  const storeFilters = useFiltersContext((state) => state[type]);
  const parsedParams = parseImagesQuery(router.query); // router params are the overrides
  return removeEmpty({ ...storeFilters, ...parsedParams });
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
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
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
