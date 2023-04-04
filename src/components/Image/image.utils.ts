import { MetricTimeframe } from '@prisma/client';
import { useMemo } from 'react';
import { z } from 'zod';
import { useImageFilters } from '~/providers/FiltersProvider';
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

export const useQueryImages = (
  filters?: Partial<GetInfiniteImagesInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters = filters ?? {};
  const globalFilters = useImageFilters();
  if (!!filters.modelId) filters.modelVersionId = undefined;

  const combined = removeEmpty({ ...globalFilters, ...filters });

  const { data, ...rest } = trpc.image.getInfinite.useInfiniteQuery(combined, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
    trpc: { context: { skipBatch: true } },
    ...options,
  });

  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return { data, images, ...rest };
};
