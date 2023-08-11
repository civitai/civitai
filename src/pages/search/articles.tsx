import { Container, Stack, Text, createStyles } from '@mantine/core';
import {
  InstantSearch,
  SearchBox,
  useInfiniteHits,
  useInstantSearch,
} from 'react-instantsearch-hooks-web';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';

import { env } from '~/env/client.mjs';
import {
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { routing } from '~/components/Search/useSearchState';
import { useInView } from 'react-intersection-observer';
import { useEffect } from 'react';
import { SearchHeader } from '~/components/Search/SearchHeader';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

export default function Search() {
  return (
    <InstantSearch searchClient={searchClient} indexName="articles" routing={routing}>
      <Container fluid>
        <Stack
          sx={(theme) => ({
            height: 'calc(100vh - 2 * var(--mantine-header-height,50px))',
            position: 'fixed',
            left: 0,
            top: 'var(--mantine-header-height,50px)',
            width: '377px',
            overflowY: 'auto',
            padding: theme.spacing.md,
          })}
        >
          <RenderFilters />
        </Stack>

        <Stack pl={377} w="100%">
          <SearchHeader />
          <ArticlesHitList />
        </Stack>
      </Container>
    </InstantSearch>
  );
}

const RenderFilters = () => {
  return (
    <>
      <SortBy
        title="Sort models by"
        items={[
          { label: 'Most Bookmarked', value: 'articles:metrics.favoriteCount:desc' },
          { label: 'Most Viewed', value: 'articles:metrics.viewCount:desc' },
          { label: 'Most Discussed', value: 'articles:metrics.commentCount:desc' },
          { label: 'Newest', value: 'articles:createdAt:desc' },
        ]}
      />
      <SearchableMultiSelectRefinementList
        title="Tags"
        attribute="tags"
        // TODO.Search: Meiliserach & facet searching is not supported when used with sort by as Angolia provides it.  https://github.com/meilisearch/meilisearch-js-plugins/issues/1222
        // If that ever gets fixed, just make sortable true + limit 20 or something
        limit={9999}
        searchable={false}
      />
    </>
  );
};

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, minmax(250px, 1fr))`,
    columnGap: theme.spacing.md,
    gridTemplateRows: `auto 1fr`,
    overflow: 'hidden',
    marginTop: -theme.spacing.md,

    '& > *': {
      marginTop: theme.spacing.md,
    },
  },
}));

export function ArticlesHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHits();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();
  const { classes } = useStyles();

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && status === 'idle' && !isLastPage) {
      showMore?.();
    }
  }, [status, inView, showMore, isLastPage]);

  return (
    <Stack>
      <Text>So we got: {hits.length}</Text>
    </Stack>
  );
}
