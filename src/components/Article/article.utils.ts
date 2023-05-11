import { MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { z } from 'zod';

import { useFiltersContext } from '~/providers/FiltersProvider';
import { ArticleSort } from '~/server/common/enums';
import {
  GetArticlesByCategorySchema,
  GetInfiniteArticlesSchema,
} from '~/server/schema/article.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { numericStringArray } from '~/utils/zod-helpers';

export const useArticleFilters = () => {
  const storeFilters = useFiltersContext((state) => state.articles);
  return removeEmpty(storeFilters);
};

const articleQueryParamSchema = z
  .object({
    tags: numericStringArray(),
    view: z.enum(['categories', 'feed']),
    period: z.nativeEnum(MetricTimeframe),
    sort: z.nativeEnum(ArticleSort),
    section: z.enum(['published', 'draft']),
  })
  .partial();
export type ArticleQueryParams = z.output<typeof articleQueryParamSchema>;
export const useArticleQueryParams = () => {
  const { query, pathname, replace } = useRouter();

  return useMemo(() => {
    const result = articleQueryParamSchema.safeParse(query);
    const data: ArticleQueryParams = result.success ? result.data : { view: 'categories' };

    return {
      ...data,
      set: (filters: Partial<ArticleQueryParams>) => {
        replace({ pathname, query: { ...query, ...filters } }, undefined, { shallow: true });
      },
    };
  }, [query, pathname, replace]);
};

export const useQueryArticles = (
  filters?: Partial<GetInfiniteArticlesSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.article.getInfinite.useInfiniteQuery(
    { ...filters, browsingMode },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );

  const articles = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return { data, articles, ...rest };
};

export const useQueryArticleCategories = (
  filters?: Partial<GetArticlesByCategorySchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.article.getByCategory.useInfiniteQuery(
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
