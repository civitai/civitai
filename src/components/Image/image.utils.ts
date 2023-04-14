import { MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { z } from 'zod';
import { useFiltersContext, FilterKeys } from '~/providers/FiltersProvider';
import { ImageSort } from '~/server/common/enums';
import { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { numericString, numericStringArray } from '~/utils/zod-helpers';

const zodNumberArrayOptional = numericStringArray().optional();
const zodNumberOptional = numericString().optional();

export const imagesQueryParamSchema = z.object({
  modelId: zodNumberOptional,
  modelVersionId: zodNumberOptional,
  postId: zodNumberOptional,
  username: z.string().optional(),
  prioritizedUserIds: zodNumberArrayOptional,
  limit: zodNumberOptional,
  period: z.nativeEnum(MetricTimeframe).optional(),
  sort: z.nativeEnum(ImageSort).optional(),
  tags: zodNumberArrayOptional,
});

export const parseImagesQuery = (params: unknown) => {
  const result = imagesQueryParamSchema.safeParse(params);
  return result.success ? result.data : {};
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
