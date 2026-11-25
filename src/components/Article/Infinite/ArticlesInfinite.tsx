import { Button, Center, Loader, LoadingOverlay } from '@mantine/core';
import { isEqual } from 'lodash-es';
import { useRef } from 'react';
import {
  useArticleFilters,
  useQueryArticles,
  useSemanticArticleFeed,
} from '~/components/Article/article.utils';
import { FeedSearchSummary } from '~/components/Search/FeedSearchSummary';
import { SearchRefusalNotice } from '~/components/Search/SearchRefusalNotice';
import { useSearchRefusal } from '~/components/Search/useSearchRefusal';
import { isSearchRefusedError } from '~/components/Search/search-refusal';
import { useScrollToTopOnChange } from '~/hooks/useScrollToTopOnChange';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryGridVirtual } from '~/components/MasonryColumns/MasonryGridVirtual';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import type { GetInfiniteArticlesSchema } from '~/server/schema/article.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { useFeedSearchQuery } from '~/components/Filters/FeedSearchInput';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function ArticlesInfinite({ searchable, ...props }: Props) {
  const features = useFeatureFlags();
  // Only a searchable feed with the flag reads the page's `?query=` and pays for the query checks.
  return searchable && features.articleFeedSearch ? (
    <SearchableArticlesFeed {...props} />
  ) : (
    <ArticlesFeed {...props} />
  );
}

/** The feed's filters: the saved ones under the caller's, stable while their content is. */
function useInfiniteArticleFilters({ filters: filterOverrides = {}, disableStoreFilters }: Props) {
  const articlesFilters = useArticleFilters();
  const computedFilters = disableStoreFilters
    ? filterOverrides
    : removeEmpty({ ...articlesFilters, ...filterOverrides });
  // Stabilize identity so query keys only update on real content change.
  const filtersRef = useRef(computedFilters);
  if (!isEqual(filtersRef.current, computedFilters)) filtersRef.current = computedFilters;
  return filtersRef.current;
}

function SearchableArticlesFeed(props: Props) {
  const filters = useInfiniteArticleFilters(props);
  const searchText = useFeedSearchQuery();
  // A ?query= can arrive by link or redirect, past the search bar's own checks.
  const { refusal } = useSearchRefusal(searchText, 'articles_semantic', 'semantic');
  const search = useSemanticArticleFeed(filters, refusal ? undefined : searchText);
  useScrollToTopOnChange(search.searchKey);
  const shownRefusal =
    refusal ??
    (isSearchRefusedError(search.error)
      ? 'profanity'
      : search.serverRefusal
      ? 'policy'
      : undefined);
  if (shownRefusal)
    return (
      <SearchRefusalNotice refusal={shownRefusal} refusedBy={search.serverRefusal?.refusedBy} />
    );
  return searchText ? (
    <ArticlesFeed {...props} search={{ text: searchText, ...search }} />
  ) : (
    <ArticlesFeed {...props} />
  );
}

type FeedSearch = ReturnType<typeof useSemanticArticleFeed> & { text: string };

function ArticlesFeed({
  showEof = false,
  showEmptyCta,
  search,
  ...props
}: Props & { search?: FeedSearch }) {
  const filters = useInfiniteArticleFilters(props);
  // A failed search must not show or page the keyword feed (no server profanity check): its
  // fetchNextPage runs even while the query is disabled.
  const searchFailed = !!search?.isError;
  const searching = !!search && !searchFailed;
  const feed = useQueryArticles(
    { ...filters, query: search?.text },
    { keepPreviousData: true, enabled: !search }
  );
  const shown = search && searching ? search : feed;
  const { fetchNextPage, isRefetching, isFetching } = shown;
  const articles = searchFailed ? [] : shown.articles;
  const hasNextPage = !searchFailed && shown.hasNextPage;

  return (
    <>
      {search && (
        <FeedSearchSummary
          noun="Articles"
          query={search.text}
          correctedQuery={searching ? search.correctedQuery : undefined}
          failed={searchFailed}
          onRetry={() => search.refetch()}
        />
      )}
      {!articles.length && isFetching ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!articles.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGridVirtual
            data={articles}
            render={ArticleCard}
            itemId={(x) => x.id}
            empty={<NoContent />}
          />
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isFetching}
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" style={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
          {!hasNextPage && showEof && <EndOfFeed />}
        </div>
      ) : (
        <NoContent py="lg">
          {showEmptyCta && (
            <Link href="/articles/create">
              <Button radius="xl">Write an Article</Button>
            </Link>
          )}
        </NoContent>
      )}
    </>
  );
}

type Props = {
  filters?: Partial<GetInfiniteArticlesSchema>;
  showEof?: boolean;
  showEmptyCta?: boolean;
  disableStoreFilters?: boolean;
  /** The feed answers the page's `?query=` with the semantic search, under articleFeedSearch. */
  searchable?: boolean;
};
