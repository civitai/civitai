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
import { isDefined } from '~/utils/type-guards';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import trieMemoize from 'trie-memoize';
import OneKeyMap from '@essentials/one-key-map';

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
  const {
    models: hiddenModels,
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
  } = useHiddenPreferencesContext();

  const models = useMemo(() => {
    const filtered = hits
      .filter((x) => {
        if (x.user.id === currentUser?.id) return true;
        if (hiddenUsers.get(x.user.id)) return false;
        if (hiddenModels.get(x.id)) return false;
        for (const tag of x.tags) if (hiddenTags.get(tag.id)) return false;
        return true;
      })
      .map(({ images, ...x }) => {
        const filteredImages = images?.filter((i) => {
          if (hiddenImages.get(i.id)) return false;

          for (const tag of i.tags ?? []) {
            if (hiddenTags.get(tag.id)) return false;
          }
          return true;
        });

        if (!filteredImages?.length) return null;

        return {
          ...x,
          // Search index stores tag name for searching purposes. We need to convert it back to id
          tags: x.tags.map((t) => t.id),
          image: {
            ...filteredImages[0],
            // Search index stores tag name for searching purposes. We need to convert it back to id
            tags: filteredImages[0].tags?.map((t) => t.id),
          },
        };
      })
      .filter(isDefined);

    return filtered;
  }, [hits, hiddenModels, hiddenImages, hiddenTags, hiddenUsers, currentUser]);

  const hiddenItems = hits.length - models.length;

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

  return (
    <Stack>
      {hiddenItems > 0 && (
        <Text color="dimmed">{hiddenItems} models have been hidden due to your settings.</Text>
      )}
      <Box className={classes.grid}>
        {models.map((model, index) => {
          return <div key={index}>{createRenderElement(ModelCard, index, model)}</div>;
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

const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap],
  (RenderComponent, index, model) => <RenderComponent index={index} data={model} />
);
