import { Stack, Text, Box, Center, Loader, Title, ThemeIcon, Anchor } from '@mantine/core';
import { useInstantSearch } from 'react-instantsearch';

import {
  BrowsingLevelFilter,
  ClearRefinements,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import Link from 'next/link';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { ARTICLES_SEARCH_INDEX } from '~/server/common/constants';
import { ArticlesSearchIndexSortBy } from '~/components/Search/parsers/article.parser';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';

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
      <BrowsingLevelFilter attributeName="nsfwLevel" />
      <SortBy
        title="Sort articles by"
        items={[
          { label: 'Relevancy', value: ArticlesSearchIndexSortBy[0] as string },
          { label: 'Most Bookmarked', value: ArticlesSearchIndexSortBy[1] as string },
          { label: 'Most Viewed', value: ArticlesSearchIndexSortBy[2] as string },
          { label: 'Most Discussed', value: ArticlesSearchIndexSortBy[3] as string },
          { label: 'Most Buzz', value: ArticlesSearchIndexSortBy[4] as string },
          { label: 'Newest', value: ArticlesSearchIndexSortBy[5] as string },
        ]}
      />{' '}
      <SearchableMultiSelectRefinementList title="Users" attribute="user.username" searchable />
      <SearchableMultiSelectRefinementList
        title="Tags"
        attribute="tags.name"
        operator="and"
        searchable
      />
      <ClearRefinements />
    </>
  );
};

export function ArticlesHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHitsTransformed<'articles'>();
  const { status } = useInstantSearch();
  const { classes } = useSearchLayoutStyles();

  const { loadingPreferences, items, hiddenCount } = useApplyHiddenPreferences({
    type: 'articles',
    data: hits,
  });

  if (hits.length === 0) {
    const NotFound = (
      <Box>
        <Center>
          <Stack spacing="md" align="center" maw={800}>
            {hiddenCount > 0 && (
              <Text color="dimmed">
                {hiddenCount} articles have been hidden due to your settings.
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

    const loading = status === 'loading' || status === 'stalled';

    if (loading) {
      return (
        <Box>
          <Center mt="md">
            <Loader />
          </Center>
        </Box>
      );
    }

    return (
      <Box>
        <Center mt="md">
          {/* Just enough time to avoid blank random page */}
          <TimeoutLoader renderTimeout={() => <>{NotFound}</>} delay={150} />
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
      {hiddenCount > 0 && (
        <Text color="dimmed">{hiddenCount} articles have been hidden due to your settings.</Text>
      )}{' '}
      <MasonryGrid data={items} render={ArticleCard} itemId={(x) => x.id} empty={<NoContent />} />
      {hits.length > 0 && !isLastPage && (
        <InViewLoader
          loadFn={showMore}
          loadCondition={status === 'idle'}
          style={{ gridColumn: '1/-1' }}
        >
          <Center p="xl" sx={{ height: 36 }} mt="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Stack>
  );
}

ArticlesSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout indexName={ARTICLES_SEARCH_INDEX}>{page}</SearchLayout>;
};
