import { Stack, Center, Loader, Title, Text, ThemeIcon } from '@mantine/core';
import { useInstantSearch } from 'react-instantsearch';

import {
  BrowsingLevelFilter,
  ChipRefinementList,
  ClearRefinements,
  DateRangeRefinement,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { useEffect } from 'react';
import { ModelCard } from '~/components/Cards/ModelCard';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { IconCloudOff } from '@tabler/icons-react';
import { SearchLayout } from '~/components/Search/SearchLayout';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { ModelSearchIndexSortBy } from '~/components/Search/parsers/model.parser';
import { useRouter } from 'next/router';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Availability } from '~/shared/utils/prisma/enums';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { isDefined } from '~/utils/type-guards';
import { nsfwRestrictedBaseModels } from '~/server/common/constants';
import { nsfwBrowsingLevelsArray } from '~/shared/constants/browsingLevel.constants';

export default function ModelsSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Content>
        <SearchHeader />
        <ModelsHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

const RenderFilters = () => {
  const currentUser = useCurrentUser();
  const browsingSettingsAddons = useBrowsingSettingsAddons();

  const filters = [
    browsingSettingsAddons.settings.disablePoi
      ? `poi != true${currentUser?.id ? ` OR user.id = ${currentUser.id}` : ''}`
      : null,
    browsingSettingsAddons.settings.disableMinor
      ? `minor != true${currentUser?.id ? ` OR user.id = ${currentUser.id}` : ''}`
      : null,
    `availability != ${Availability.Private}${
      currentUser?.id ? ` OR user.id = ${currentUser.id}` : ''
    }`,
    `NOT (nsfwLevel IN [${nsfwBrowsingLevelsArray.join(
      ', '
    )}] AND version.baseModel IN [${nsfwRestrictedBaseModels
      .map((model) => `'${model}'`)
      .join(', ')}])`,
  ].filter(isDefined);

  return (
    <>
      <BrowsingLevelFilter filters={filters} attributeName="nsfwLevel" />
      <SortBy
        title="Sort models by"
        items={[
          { label: 'Relevancy', value: ModelSearchIndexSortBy[0] as string },
          { label: 'Highest Rated', value: ModelSearchIndexSortBy[1] as string },
          { label: 'Most Downloaded', value: ModelSearchIndexSortBy[2] as string },
          { label: 'Most Liked', value: ModelSearchIndexSortBy[3] as string },
          { label: 'Most Discussed', value: ModelSearchIndexSortBy[4] as string },
          { label: 'Most Collected', value: ModelSearchIndexSortBy[5] as string },
          { label: 'Most Buzz', value: ModelSearchIndexSortBy[6] as string },
          { label: 'Newest', value: ModelSearchIndexSortBy[7] as string },
        ]}
      />
      <ChipRefinementList
        title="Filter by Base Model"
        attribute="version.baseModel"
        sortBy={['name']}
        limit={100}
      />
      <ChipRefinementList
        title="Filter by Model Type"
        attribute="type"
        sortBy={['name']}
        limit={100}
      />
      <ChipRefinementList
        title="Filter by Checkpoint Type"
        sortBy={['name']}
        attribute="checkpointType"
      />
      <DateRangeRefinement title="Filter by Last Updated At" attribute="lastVersionAtUnix" />
      <ChipRefinementList title="Filter by File Format" sortBy={['name']} attribute="fileFormats" />
      <ChipRefinementList
        title="Filter by Category"
        sortBy={['name']}
        attribute="category.name"
        limit={100}
      />
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

export function ModelsHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHitsTransformed<'models'>();
  const { status } = useInstantSearch();
  const router = useRouter();
  const modelId = router.query.model ? Number(router.query.model) : undefined;

  const { loadingPreferences, items, hiddenCount } = useApplyHiddenPreferences({
    type: 'models',
    data: hits,
  });

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
      <div className="flex items-center justify-center">
        <Stack gap="md" align="center" maw={800}>
          {hiddenCount > 0 && (
            <Text c="dimmed">{hiddenCount} models have been hidden due to your settings.</Text>
          )}
          <ThemeIcon size={128} radius={100} className="opacity-50">
            <IconCloudOff size={80} />
          </ThemeIcon>
          <Title order={1} lh={1}>
            No models found
          </Title>
          <Text align="center">
            We have a bunch of models, but it looks like we couldn&rsquo;t find any matching your
            query.
          </Text>
        </Stack>
      </div>
    );

    const loading = status === 'loading' || status === 'stalled';

    if (loading) {
      return (
        <div>
          <Center mt="md">
            <Loader />
          </Center>
        </div>
      );
    }

    return (
      <div>
        <Center mt="md">
          {/* Just enough time to avoid blank random page */}
          <TimeoutLoader renderTimeout={() => <>{NotFound}</>} delay={150} />
        </Center>
      </div>
    );
  }

  if (loadingPreferences) {
    return (
      <div>
        <Center mt="md">
          <Loader />
        </Center>
      </div>
    );
  }

  return (
    <Stack>
      {hiddenCount > 0 && (
        <Text c="dimmed">{hiddenCount} models have been hidden due to your settings.</Text>
      )}
      <MasonryGrid
        data={items as any}
        render={ModelCard}
        itemId={(x) => x.id}
        empty={<NoContent />}
        withAds
      />
      {hits.length > 0 && !isLastPage && (
        <InViewLoader
          loadFn={showMore}
          loadCondition={status === 'idle'}
          style={{ gridColumn: '1/-1' }}
        >
          <Center p="xl" style={{ height: 36 }} mt="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Stack>
  );
}

ModelsSearch.getLayout = function getLayout(page: React.ReactNode) {
  return (
    <SearchLayout
      indexName={MODELS_SEARCH_INDEX}
      leftSidebar={
        <SearchLayout.Filters>
          <RenderFilters />
        </SearchLayout.Filters>
      }
    >
      {page}
    </SearchLayout>
  );
};

// const createRenderElement = trieMemoize(
//   [OneKeyMap, {}, WeakMap],
//   (RenderComponent, index, model) => <RenderComponent index={index} data={model} />
// );
