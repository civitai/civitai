import { MetricTimeframe } from '@prisma/client';
import { useMemo } from 'react';
import { z } from 'zod';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { PostSort } from '~/server/common/enums';
import { PostsQueryInput } from '~/server/schema/post.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { numericString, numericStringArray } from '~/utils/zod-helpers';

export const usePostQueryParams = () => useZodRouteParams(postQueryParamSchema);

export const usePostFilters = () => {
  const storeFilters = useFiltersContext((state) => state.posts);
  const { query } = usePostQueryParams();
  const browsingLevel = useBrowsingLevelDebounced();
  return removeEmpty({ browsingLevel, ...storeFilters, ...query });
};

const postQueryParamSchema = z
  .object({
    tags: numericStringArray(),
    modelId: numericString(),
    modelVersionId: numericString(),
    username: z.string().transform(postgresSlugify).nullish(),
    view: z.enum(['categories', 'feed']),
    period: z.nativeEnum(MetricTimeframe),
    sort: z.nativeEnum(PostSort),
    collectionId: numericString(),
    section: z.enum(['published', 'draft']),
    followed: z.coerce.boolean(),
  })
  .partial();

export const useQueryPosts = (
  filters?: Partial<PostsQueryInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, ...rest } = trpc.post.getInfinite.useInfiniteQuery(
    { ...filters, include: ['cosmetics'], browsingLevel },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items: posts, loadingPreferences } = useApplyHiddenPreferences({
    type: 'posts',
    data: flatData,
    isRefetching: rest.isRefetching,
  });
  return { data, posts, isLoading: isLoading || loadingPreferences, ...rest };
};
