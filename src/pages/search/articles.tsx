import {
  Stack,
  Text,
  createStyles,
  Box,
  Center,
  Loader,
  Title,
  ThemeIcon,
  Anchor,
} from '@mantine/core';
import { InstantSearch, useInfiniteHits, useInstantSearch } from 'react-instantsearch';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';

import { env } from '~/env/client.mjs';
import {
  ClearRefinements,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { routing } from '~/components/Search/useSearchState';
import { useInView } from 'react-intersection-observer';
import { useEffect, useMemo } from 'react';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ArticleSearchIndexRecord } from '~/server/search-index/articles.search-index';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import Link from 'next/link';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { applyUserPreferencesArticles } from '~/components/Search/search.utils';
import { ARTICLES_SEARCH_INDEX } from '~/server/common/constants';
import { ArticlesSearchIndexSortBy } from '~/components/Search/parsers/article.parser';

export default function ArticlesSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Filters>
        <RenderFilters />
      </SearchLayout.Filters>
      <SearchLayout.Content>
        <SearchHeader />
        <ArticlesHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

const RenderFilters = () => {
  return (
    <>
      <SortBy
        title="Sort articles by"
        items={[
          { label: 'Most Bookmarked', value: ArticlesSearchIndexSortBy[0] as string },
          { label: 'Most Viewed', value: ArticlesSearchIndexSortBy[1] as string },
          { label: 'Most Discussed', value: ArticlesSearchIndexSortBy[2] as string },
          { label: 'Newest', value: ArticlesSearchIndexSortBy[3] as string },
        ]}
      />{' '}
      <SearchableMultiSelectRefinementList
        title="Users"
        attribute="user.username"
        sortBy={['count:desc']}
        searchable={true}
      />
      <SearchableMultiSelectRefinementList
        title="Tags"
        attribute="tags.name"
        operator="and"
        sortBy={['count:desc']}
        searchable={true}
      />
      <ClearRefinements />
    </>
  );
};

export function ArticlesHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHits<ArticleSearchIndexRecord>();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();
  const { classes } = useSearchLayoutStyles();
  const currentUser = useCurrentUser();
  const {
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: loadingPreferences,
  } = useHiddenPreferencesContext();

  const articles = useMemo(() => {
    return applyUserPreferencesArticles<ArticleSearchIndexRecord>({
      items: hits,
      hiddenTags,
      hiddenUsers,
      currentUserId: currentUser?.id,
    });
  }, [hits, hiddenTags, hiddenUsers, currentUser]);

  const hiddenItems = hits.length - articles.length;

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && status === 'idle' && !isLastPage) {
      showMore?.();
    }
  }, [status, inView, showMore, isLastPage]);

  if (hits.length === 0) {
    const NotFound = (
      <Box>
        <Center>
          <Stack spacing="md" align="center" maw={800}>
            {hiddenItems > 0 && (
              <Text color="dimmed">
                {hiddenItems} articles have been hidden due to your settings.
              </Text>
            )}
            <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} inline>
              No articles found
            </Title>
            <Text align="center">
              We have a bunch of articles, but it looks like we couldn&rsquo;t find any matching
              your query.
            </Text>
            <Text>
              Why not{' '}
              <Link href="/articles/create" passHref>
                <Anchor target="_blank">write your own!</Anchor>
              </Link>
            </Text>
          </Stack>
        </Center>
      </Box>
    );

    return (
      <Box>
        <Center mt="md">
          <TimeoutLoader renderTimeout={() => <>{NotFound}</>} />
        </Center>
      </Box>
    );
  }

  if (loadingPreferences) {
    return (
      <Box>
        <Center mt="md">
          <Loader />
        </Center>
      </Box>
    );
  }

  return (
    <Stack>
      {hiddenItems > 0 && (
        <Text color="dimmed">{hiddenItems} articles have been hidden due to your settings.</Text>
      )}{' '}
      <Box
        className={classes.grid}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(300px, 1fr))`,
        }}
      >
        {articles.map((hit) => {
          return <ArticleCard key={hit.id} data={hit} />;
        })}
      </Box>
      {hits.length > 0 && (
        <Center ref={ref} sx={{ height: 36 }} mt="md">
          {!isLastPage && status === 'idle' && <Loader />}
        </Center>
      )}
    </Stack>
  );
}

ArticlesSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout indexName={ARTICLES_SEARCH_INDEX}>{page}</SearchLayout>;
};
