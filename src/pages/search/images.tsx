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
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

export default function ImageSearch() {
  return (
    <InstantSearch searchClient={searchClient} indexName="images" routing={routing}>
      <SearchLayout.Root>
        <SearchLayout.Filters>
          <RenderFilters />
        </SearchLayout.Filters>
        <SearchLayout.Content>
          <SearchHeader />
          <ImagesHitList />
        </SearchLayout.Content>
      </SearchLayout.Root>
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
        operator="and"
      />
    </>
  );
}

function ImagesHitList() {
  const { classes } = useSearchLayoutStyles();
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

ImageSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout>{page}</SearchLayout>;
};
