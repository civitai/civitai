import { Center, Container, Loader, Stack, createStyles } from '@mantine/core';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { useEffect } from 'react';
import { InstantSearch, useInfiniteHits, useInstantSearch } from 'react-instantsearch';
import { useInView } from 'react-intersection-observer';
import { ImageCard } from '~/components/Cards/ImageCard';
import {
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { routing } from '~/components/Search/useSearchState';
import { env } from '~/env/client.mjs';
import { ImageSearchIndexRecord } from '~/server/search-index/images.search-index';
import { SearchHeader } from '~/components/Search/SearchHeader';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

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

  filtersWrapper: {
    height: 'calc(100vh - 2 * var(--mantine-header-height,50px))',
    position: 'fixed',
    left: 0,
    top: 'var(--mantine-header-height,50px)',
    width: '377px',
    overflowY: 'auto',
    padding: theme.spacing.md,
  },
}));

export default function Images() {
  const { classes } = useStyles();

  return (
    <InstantSearch searchClient={searchClient} indexName="images" routing={routing}>
      <Container p={0} fluid>
        <Stack className={classes.filtersWrapper}>
          <RenderFilters />
        </Stack>
        <Stack pl={377} w="100%">
          <SearchHeader />
          <ImagesHitList />
        </Stack>
      </Container>
    </InstantSearch>
  );
}

function RenderFilters() {
  return (
    <>
      <SortBy
        title="Sort images by"
        items={[
          { label: 'Most Reactions', value: 'images:rank.reactionCountAllTimeRank:asc' },
          { label: 'Most Discussed', value: 'images:rank.commentCountAllTimeRank:asc' },
          { label: 'Newest', value: 'images:createdAt:desc' },
        ]}
      />
      <SearchableMultiSelectRefinementList
        title="Tags"
        attribute="tags.name"
        // TODO.Search: Meiliserach & facet searching is not supported when used with sort by as Angolia provides it.  https://github.com/meilisearch/meilisearch-js-plugins/issues/1222
        // If that ever gets fixed, just make sortable true + limit 20 or something
        limit={9999}
        searchable={false}
      />
    </>
  );
}

function ImagesHitList() {
  const { classes } = useStyles();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();

  const { hits, showMore, isLastPage } = useInfiniteHits<ImageSearchIndexRecord>();

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && status === 'idle' && !isLastPage) {
      showMore();
    }
  }, [status, inView, showMore, isLastPage]);

  return (
    <Stack>
      <div className={classes.grid}>
        {hits.map((hit) => (
          <ImageCard key={hit.id} data={hit} />
        ))}
      </div>
      {hits.length > 0 && (
        <Center ref={ref} sx={{ height: 36 }} mt="md">
          {!isLastPage && status === 'idle' && <Loader />}
        </Center>
      )}
    </Stack>
  );
}
