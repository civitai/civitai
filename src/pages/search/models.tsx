import { Stack, Box, Center, Loader, Title, Text, ThemeIcon } from '@mantine/core';
import { InstantSearch, useInfiniteHits, useInstantSearch } from 'react-instantsearch';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';

import { env } from '~/env/client.mjs';
import {
  ChipRefinementList,
  ClearRefinements,
  SearchableFilterList,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { routing } from '~/components/Search/useSearchState';
import { useInView } from 'react-intersection-observer';
import { useEffect } from 'react';
import { ModelCard } from '~/components/Cards/ModelCard';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { IconCloudOff } from '@tabler/icons-react';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { useRouter } from 'next/router';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

export default function ModelsSearch() {
  const router = useRouter();

  return (
    <SearchLayout.Root>
      <SearchLayout.Filters>
        <RenderFilters />
      </SearchLayout.Filters>
      <SearchLayout.Content>
        <SearchHeader />
        <ModelsHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

const RenderFilters = () => {
  return (
    <>
      <SortBy
        title="Sort models by"
        items={[
          { label: 'Highest Rated', value: 'models:metrics.weightedRating:desc' },
          { label: 'Most Downloaded', value: 'models:metrics.downloadCount:desc' },
          { label: 'Most Liked', value: 'models:metrics.favoriteCount:desc' },
          { label: 'Most Discussed', value: 'models:metrics.commentCount:desc' },
          { label: 'Newest', value: 'models:createdAt:desc' },
        ]}
      />
      <ChipRefinementList
        title="Filter by Base Model"
        attribute="version.baseModel"
        sortBy={['name']}
      />
      <ChipRefinementList title="Filter by Model Type" attribute="type" sortBy={['name']} />
      <ChipRefinementList
        title="Filter by Checkpoint Type"
        sortBy={['name']}
        attribute="checkpointType"
      />
      <SearchableMultiSelectRefinementList
        title="Tags"
        attribute="tags.name"
        // TODO.Search: Meiliserach & facet searching is not supported when used with sort by as Angolia provides it.  https://github.com/meilisearch/meilisearch-js-plugins/issues/1222
        // If that ever gets fixed, just make sortable true + limit 20 or something
        // limit={9999}
        searchable={false}
        operator="and"
      />
      {/*<SearchableFilterList*/}
      {/*  title="Exclude Tags"*/}
      {/*  attribute="tags.name"*/}
      {/*  // TODO.Search: Meiliserach & facet searching is not supported when used with sort by as Angolia provides it.  https://github.com/meilisearch/meilisearch-js-plugins/issues/1222*/}
      {/*  // If that ever gets fixed, just make sortable true + limit 20 or something*/}
      {/*  limit={9999}*/}
      {/*  searchable={false}*/}
      {/*  dividerOperator={'AND'}*/}
      {/*  comparisonOperator={'!='}*/}
      {/*/>*/}
      <ClearRefinements />
    </>
  );
};

export function ModelsHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHits<ModelSearchIndexRecord>();
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
              No models found
            </Title>
            <Text align="center">
              We have a bunch of models, but it looks like we couldn&rsquo;t find any matching your
              query.
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
          const images = hit.images ?? [];

          const model = {
            ...hit,
            image: images[0],
          };

          return <ModelCard key={hit.id} data={model} />;
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

ModelsSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout indexName="models">{page}</SearchLayout>;
};
