import {
  Container,
  Title,
  Text,
  Group,
  Stack,
  Box,
  Accordion,
  Chip,
  Loader,
  Center,
  MultiSelect,
  Select,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import {
  InstantSearch,
  useRefinementList,
  RefinementListProps,
  useInfiniteHits,
  useInstantSearch,
  SortByProps,
  useSortBy,
} from 'react-instantsearch-hooks-web';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';

import { env } from '~/env/client.mjs';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ModelGetAll } from '~/types/router';
import { useInView } from 'react-intersection-observer';
import { useDebouncedValue } from '@mantine/hooks';
import {
  ChipRefinementList,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { ModelsHitList } from '~/components/Search/ModelsHitList';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

export default function Search() {
  return (
    <InstantSearch
      searchClient={searchClient}
      // Sets default sorting:
      indexName="models:metrics.weightedRating:desc"
      routing={true}
    >
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
          <SortBy
            title="Sort models by"
            items={[
              { label: 'Highest Rated', value: 'models:metrics.weightedRating:desc' },
              { label: 'Most downloaded', value: 'models:metrics.downloadCount:desc' },
              { label: 'Most Liked', value: 'models:metrics.favoriteCount:desc' },
              { label: 'Most discussed', value: 'models:metrics.commentCount:desc' },
              { label: 'Newest', value: 'models:createdAt:desc' },
            ]}
          />
          <ChipRefinementList
            title="Filter by Base Model"
            attribute="modelVersion.baseModel"
            sortBy={['name']}
          />
          <ChipRefinementList title="Filter by Model Type" attribute="type" sortBy={['name']} />
          <ChipRefinementList
            title="Filter by Checkpoint Type"
            sortBy={['name']}
            attribute="checkpointType"
          />
          <SearchableMultiSelectRefinementList title="Tags" attribute="tags" limit={10} />
        </Stack>

        <Stack pl={377} w="100%">
          <Title>Models Search experience</Title>
          <ModelsHitList />
        </Stack>
      </Container>
    </InstantSearch>
  );
}
