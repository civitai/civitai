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
import { useScrollToTopOnChange } from '~/hooks/useScrollToTopOnChange';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryGridVirtual } from '~/components/MasonryColumns/MasonryGridVirtual';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import type { GetInfiniteArticlesSchema } from '~/server/schema/article.schema';
import { removeEmpty } from '~/utils/object-helpers';

export function ArticlesInfinite(props: Props) {
  // Only the articles page, with articleFeedSearch and a query, pays for the query checks.
  return props.searchText ? <SearchableArticlesFeed {...props} /> : <ArticlesFeed {...props} />;
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
  // A ?query= can arrive by link or redirect, past the search bar's own checks.
  const { refusal, profanityMatches } = useSearchRefusal(props.searchText, 'articles_semantic');
  const search = useSemanticArticleFeed(filters, refusal ? undefined : props.searchText);
  useScrollToTopOnChange(search.searchKey);
  if (refusal) return <SearchRefusalNotice refusal={refusal} profanityMatches={profanityMatches} />;
  return <ArticlesFeed {...props} search={search} />;
}

function ArticlesFeed({
  showEof = false,
  showEmptyCta,
  search,
  ...props
}: Props & { search?: ReturnType<typeof useSemanticArticleFeed> }) {
  const filters = useInfiniteArticleFilters(props);
  // A search that fails falls back to the feed's title match with a banner, never an empty page.
  const searchFailed = !!search?.isError;
  const searching = !!search && !searchFailed;
  const feed = useQueryArticles(
    // The feed's own query is a title match, used only as the fallback.
    { ...filters, query: search ? props.searchText : undefined },
    { keepPreviousData: true, enabled: !searching }
  );
  const { articles, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    search && searching ? search : feed;

  return (
    <>
      {search && props.searchText && (
        <FeedSearchSummary
          noun="Articles"
          query={props.searchText}
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
  /** The articles page's `?query=`, with articleFeedSearch: answered by the semantic search. */
  searchText?: string;
};
