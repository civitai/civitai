import { MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { z } from 'zod';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { PostSort } from '~/server/common/enums';
import { GetPostsByCategoryInput, PostsQueryInput } from '~/server/schema/post.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { numericString, numericStringArray } from '~/utils/zod-helpers';

export const usePostFilters = () => {
  const storeFilters = useFiltersContext((state) => state.posts);
  return removeEmpty(storeFilters);
};

const postQueryParamSchema = z
  .object({
    tags: numericStringArray(),
    modelId: numericString(),
    modelVersionId: numericString(),
    username: z.string().transform(postgresSlugify),
    view: z.enum(['categories', 'feed']),
    period: z.nativeEnum(MetricTimeframe),
    sort: z.nativeEnum(PostSort),
    collectionId: numericString(),
  })
  .partial();
type PostQueryParams = z.output<typeof postQueryParamSchema>;
export const usePostQueryParams = () => {
  const { query, pathname, replace } = useRouter();

  return useMemo(() => {
    const result = postQueryParamSchema.safeParse(query);
    const data: PostQueryParams = result.success ? result.data : { view: 'categories' };

    return {
      ...data,
      set: (filters: Partial<PostQueryParams>) => {
        replace({ pathname, query: { ...query, ...filters } }, undefined, { shallow: true });
      },
    };
  }, [query, pathname, replace]);
};

export const useQueryPosts = (
  filters?: Partial<PostsQueryInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.post.getInfinite.useInfiniteQuery(
    { ...filters, browsingMode },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );

  const posts = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return { data, posts, ...rest };
};

export const useQueryPostCategories = (
  filters?: Partial<GetPostsByCategoryInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.post.getPostsByCategory.useInfiniteQuery(
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
