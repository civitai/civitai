import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { z } from 'zod';
import { useImageFilters } from '~/providers/FiltersProvider';
import { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';

type Props = {
  postId?: number;
  modelId?: number;
  modelVersionId?: number;
  username?: string;
  prioritizedUserIds?: number[];
} & Record<string, unknown>;

export const imagesQueryParamSchema = z.object({
  modelId: z.number().optional(),
  modelVersionId: z.number().optional(),
  postId: z.number().optional(),
  username: z.string().optional(),
  prioritizedUserIds: z.preprocess((val) => {
    if (!val) return val;
    if (Array.isArray(val)) return val;
    else return [val];
  }, z.array(z.number()).optional()),
  limit: z.number().optional(),
});

export const parseImagesQueryParams = (
  params: Record<string, unknown>
): z.infer<typeof imagesQueryParamSchema> => {
  return imagesQueryParamSchema.parse(QS.parse(QS.stringify(params)));
};

export const useQueryImages = (
  overrides?: Partial<GetInfiniteImagesInput>,
  options?: { keepPreviousData?: boolean }
) => {
  const router = useRouter();
  const globalFilters = useImageFilters();
  const parsedParams = parseImagesQueryParams(router.query);
  const combined = { ...parsedParams, ...overrides };
  if (!!combined.modelId) combined.modelVersionId = undefined;

  const filters = removeEmpty({ ...globalFilters, ...combined });

  const { data, ...rest } = trpc.image.getInfinite.useInfiniteQuery(filters, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
    trpc: { context: { skipBatch: true } },
    ...options,
  });

  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return { data, images, ...rest };
};
