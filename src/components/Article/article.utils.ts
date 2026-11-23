import { withPlaceholderData } from '~/hooks/trpcHelpers';
import { useMemo } from 'react';
import * as z from 'zod';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { ArticleSort } from '~/server/common/enums';
import type { GetInfiniteArticlesSchema } from '~/server/schema/article.schema';
import type { SemanticArticleSearchInput } from '~/server/schema/semantic-article-search.schema';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { booleanString, numericString, numericStringArray } from '~/utils/zod-helpers';

export const useArticleFilters = () => {
  const storeFilters = useFiltersContext((state) => state.articles);
  return removeEmpty(storeFilters);
};

export const articleQueryParamSchema = z
  .object({
    tags: numericStringArray(),
    view: z.enum(['categories', 'feed']),
    period: z.enum(MetricTimeframe),
    sort: z.enum(ArticleSort),
    section: z.enum(['published', 'draft']),
    favorites: booleanString(),
    hidden: booleanString(),
    username: z.string(),
    collectionId: numericString(),
    followed: z.coerce.boolean(),
  })
  .partial();
export const useArticleQueryParams = () => useZodRouteParams(articleQueryParamSchema);
export type ArticleQueryParams = z.output<typeof articleQueryParamSchema>;
// export const useArticleQueryParams = () => {
//   const { query, pathname, replace } = useRouter();

//   return useMemo(() => {
//     const result = articleQueryParamSchema.safeParse(query);
//     const data: ArticleQueryParams = result.success ? result.data : { view: 'categories' };

//     return {
//       ...data,
//       replace: (filters: Partial<ArticleQueryParams>) => {
//         replace({ pathname, query: { ...query, ...filters } }, undefined, { shallow: true });
//       },
//     };
//   }, [query, pathname, replace]);
// };

export const useQueryArticles = (
  filters?: Partial<GetInfiniteArticlesSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean; applyHiddenPreferences?: boolean }
) => {
  filters ??= {};
  const { applyHiddenPreferences = true, ...queryOptions } = options ?? {};
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const excludedTagIds = [
    ...(filters.excludedTagIds ?? []),
    ...(browsingSettingsAddons.settings.excludedTagIds ?? []),
  ].filter(isDefined);
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, ...rest } = trpc.article.getInfinite.useInfiniteQuery(
    { ...filters, browsingLevel, excludedTagIds },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      trpc: { context: { skipBatch: true } },
      ...withPlaceholderData(queryOptions),
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);
  const { items, loadingPreferences, hiddenCount } = useApplyHiddenPreferences({
    type: 'articles',
    data: flatData,
    showHidden: !!filters.hidden,
    disabled: !applyHiddenPreferences,
    isRefetching: rest.isRefetching,
  });

  return {
    data,
    articles: items,
    removedArticles: hiddenCount,
    fetchedArticles: flatData?.length,
    isLoading: isLoading || loadingPreferences,
    ...rest,
  };
};

/** The articles feed's filters that the semantic search takes, with the query. */
export function toSemanticArticleSearchInput(
  filters: Partial<GetInfiniteArticlesSchema>,
  query: string,
  browsingLevel: number
): Omit<SemanticArticleSearchInput, 'limit'> {
  return {
    query,
    browsingLevel,
    tagIds: filters.tags,
    usernames: filters.username ? [filters.username] : undefined,
    period: filters.period,
    followed: filters.followed,
    favorites: filters.favorites,
    hidden: filters.hidden,
    collectionId: filters.collectionId,
  };
}

/**
 * The articles feed answered by the semantic search: the feed's filters that the search takes, with
 * the query. Idle without a query.
 */
export const useSemanticArticleFeed = (
  filters: Partial<GetInfiniteArticlesSchema>,
  query: string | undefined
) => {
  const browsingLevel = useBrowsingLevelDebounced();
  const input = toSemanticArticleSearchInput(filters, query ?? '', browsingLevel);
  const { data, ...rest } = trpc.semanticArticleSearch.search.useInfiniteQuery(input, {
    enabled: !!query,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...withPlaceholderData({ keepPreviousData: true }),
    // The feed's retry banner drives every attempt; a failure never falls back to the keyword feed.
    retry: 0,
    trpc: { context: { skipBatch: true }, abortOnUnmount: true },
  });
  const flatData = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);
  const { items, loadingPreferences } = useApplyHiddenPreferences({
    type: 'articles',
    data: flatData,
    showHidden: !!filters.hidden,
    isRefetching: rest.isRefetching,
  });
  return {
    ...rest,
    articles: items,
    isLoading: rest.isLoading || loadingPreferences,
    correctedQuery: data?.pages[0]?.correctedQuery,
    // Identifies the search, so the feed can scroll to the top when it changes.
    searchKey: query ? JSON.stringify(input) : undefined,
  };
};
