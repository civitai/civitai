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
import { useEffect } from 'react';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ArticleSearchIndexRecord } from '~/server/search-index/articles.search-index';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import Link from 'next/link';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { ModelsHitList } from '~/pages/search/models';
import ImageSearch from '~/pages/search/images';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

export default function ArticlesSearch() {
  return (
    <InstantSearch searchClient={searchClient} indexName="articles" routing={routing}>
      <SearchLayout.Root>
        <SearchLayout.Filters>
          <RenderFilters />
        </SearchLayout.Filters>
        <SearchLayout.Content>
          <SearchHeader />
          <ArticlesHitList />
        </SearchLayout.Content>
      </SearchLayout.Root>
    </InstantSearch>
  );
}

const RenderFilters = () => {
  return (
    <>
      <SortBy
        title="Sort articles by"
        items={[
          { label: 'Most Bookmarked', value: 'articles:stats.favoriteCount:desc' },
          { label: 'Most Viewed', value: 'articles:stats.viewCount:desc' },
          { label: 'Most Discussed', value: 'articles:stats.commentCount:desc' },
          { label: 'Newest', value: 'articles:createdAt:desc' },
        ]}
      />
      <SearchableMultiSelectRefinementList
        title="Tags"
        attribute="tags.name"
        // TODO.Search: Meiliserach & facet searching is not supported when used with sort by as Angolia provides it.  https://github.com/meilisearch/meilisearch-js-plugins/issues/1222
        // If that ever gets fixed, just make sortable true + limit 20 or something
        limit={9999}
        searchable={false}
        operator="and"
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
            <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
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

  return (
    <Stack>
      <Box className={classes.grid}>
        {hits.map((hit) => {
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
  return <SearchLayout>{page}</SearchLayout>;
};
