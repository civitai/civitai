import { Stack, Box, Center, Loader, Title, Text, ThemeIcon } from '@mantine/core';
import { useInfiniteHits, useInstantSearch } from 'react-instantsearch';

import {
  ChipRefinementList,
  ClearRefinements,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { useInView } from 'react-intersection-observer';
import { useEffect, useMemo } from 'react';
import { ModelCard } from '~/components/Cards/ModelCard';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { IconCloudOff } from '@tabler/icons-react';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import trieMemoize from 'trie-memoize';
import OneKeyMap from '@essentials/one-key-map';
import { applyUserPreferencesModels } from '~/components/Search/search.utils';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { ModelSearchIndexSortBy } from '~/components/Search/parsers/model.parser';
import { useRouter } from 'next/router';

export default function ModelsSearch() {
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
          { label: 'Relevancy', value: ModelSearchIndexSortBy[0] as string },
          { label: 'Highest Rated', value: ModelSearchIndexSortBy[1] as string },
          { label: 'Most Downloaded', value: ModelSearchIndexSortBy[2] as string },
          { label: 'Most Liked', value: ModelSearchIndexSortBy[3] as string },
          { label: 'Most Discussed', value: ModelSearchIndexSortBy[4] as string },
          { label: 'Newest', value: ModelSearchIndexSortBy[5] as string },
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

export function ModelsHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHits<ModelSearchIndexRecord>();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();
  const { classes } = useSearchLayoutStyles();
  const currentUser = useCurrentUser();
  const router = useRouter();
  const modelId = router.query.model ? Number(router.query.model) : undefined;

  const {
    models: hiddenModels,
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: loadingPreferences,
  } = useHiddenPreferencesContext();

  const models = useMemo(() => {
    return applyUserPreferencesModels<ModelSearchIndexRecord>({
      items: hits,
      hiddenModels,
      hiddenImages,
      hiddenTags,
      hiddenUsers,
      currentUserId: currentUser?.id,
    });
  }, [hits, hiddenModels, hiddenImages, hiddenTags, hiddenUsers, currentUser]);

  const hiddenItems = hits.length - models.length;

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && status === 'idle' && !isLastPage) {
      showMore?.();
    }
  }, [status, inView, showMore, isLastPage]);

  useEffect(() => {
    if (!modelId) {
      return;
    }

    if (modelId && !hits.find((item) => item.id === modelId) && status === 'idle') {
      // Forcefully loads more until the item is found
      showMore?.();
    }
  }, [modelId, status, showMore, isLastPage, hits]);

  if (hits.length === 0) {
    const NotFound = (
      <Box>
        <Center>
          <Stack spacing="md" align="center" maw={800}>
            {hiddenItems > 0 && (
              <Text color="dimmed">
                {hiddenItems} models have been hidden due to your settings.
              </Text>
            )}
            <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} inline>
              No models found
            </Title>
            <Text align="center">
              We have a bunch of models, but it looks like we couldn&rsquo;t find any matching your
              query.
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
        <Text color="dimmed">{hiddenItems} models have been hidden due to your settings.</Text>
      )}
      <Box className={classes.grid}>
        {models.map((model, index) => {
          return (
            <div key={index} id={model.id.toString()}>
              {createRenderElement(ModelCard, index, model)}
            </div>
          );
        })}
      </Box>
      {hits.length > 0 && (
        <Center ref={ref} sx={{ height: 36 }} mt="md">
          {!isLastPage && <Loader />}
        </Center>
      )}
    </Stack>
  );
}

ModelsSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout indexName={MODELS_SEARCH_INDEX}>{page}</SearchLayout>;
};

const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap],
  (RenderComponent, index, model) => <RenderComponent index={index} data={model} />
);
