import { Center, Loader, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import type { RefinementListProps } from 'react-instantsearch';
import { useInstantSearch } from 'react-instantsearch';
import {
  BrowsingLevelFilter,
  ChipRefinementList,
  DateRangeRefinement,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { SearchLayout } from '~/components/Search/SearchLayout';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { ImagesSearchIndexSortBy } from '~/components/Search/parsers/image.parser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ImagesCardMemoized } from '~/components/Image/Infinite/ImagesCard';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { MediaType } from '~/shared/utils/prisma/enums';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { isDefined } from '~/utils/type-guards';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { nsfwRestrictedBaseModels } from '~/server/common/constants';
import { nsfwBrowsingLevelsArray } from '~/shared/constants/browsingLevel.constants';

import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
export default function ImageSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Content>
        <SearchHeader />
        <ImagesHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

const filterMediaTypesOptions: RefinementListProps['transformItems'] = (items) => {
  return items.filter((item) => item.value !== MediaType.audio);
};

function RenderFilters() {
  const { canViewNsfw } = useFeatureFlags();
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const currentUser = useCurrentUser();

  const items = [
    { label: 'Relevancy', value: ImagesSearchIndexSortBy[0] as string },
    { label: 'Most Reactions', value: ImagesSearchIndexSortBy[1] as string },
    { label: 'Most Discussed', value: ImagesSearchIndexSortBy[2] as string },
    { label: 'Most Collected', value: ImagesSearchIndexSortBy[3] as string },
    { label: 'Most Buzz', value: ImagesSearchIndexSortBy[4] as string },
    { label: 'Newest', value: ImagesSearchIndexSortBy[5] as string },
  ];

  const filters = [
    browsingSettingsAddons.settings.disablePoi
      ? `poi != true${currentUser?.username ? ` OR user.username = ${currentUser.username}` : ''}`
      : null,
    browsingSettingsAddons.settings.disableMinor ? 'minor != true' : null,
    // Filter out images from NSFW models with restricted base models
    `NOT (nsfwLevel IN [${nsfwBrowsingLevelsArray.join(
      ', '
    )}] AND baseModel IN [${nsfwRestrictedBaseModels.map((model) => `'${model}'`).join(', ')}])`,
  ].filter(isDefined);

  return (
    <>
      <BrowsingLevelFilter
        filters={filters}
        attributeName={!canViewNsfw ? 'combinedNsfwLevel' : 'nsfwLevel'}
      />
      <SortBy
        title="Sort images by"
        items={!canViewNsfw ? items.filter((x) => x.label !== 'Newest') : items}
      />
      <DateRangeRefinement title="Filter by Creation Date" attribute="createdAtUnix" />
      <ChipRefinementList
        title="Filter by Media Type"
        sortBy={['name']}
        operator="or"
        attribute="type"
        transformItems={filterMediaTypesOptions}
      />
      <ChipRefinementList
        title="Filter by Aspect Ratio"
        sortBy={['name']}
        attribute="aspectRatio"
      />
      <SearchableMultiSelectRefinementList title="Users" attribute="user.username" searchable />
      <SearchableMultiSelectRefinementList
        title="Tags"
        attribute="tagNames"
        operator="and"
        searchable
      />
      <SearchableMultiSelectRefinementList
        title="Tools"
        attribute="toolNames"
        operator="and"
        searchable
      />
      <SearchableMultiSelectRefinementList
        title="Techniques"
        attribute="techniqueNames"
        operator="and"
        searchable
      />
      <ChipRefinementList
        title="Filter by Base Model"
        sortBy={['name']}
        attribute="baseModel"
        limit={100}
      />
    </>
  );
}

function ImagesHitList() {
  const { status } = useInstantSearch();

  const { hits, showMore, isLastPage } = useInfiniteHitsTransformed<'images'>();

  const { loadingPreferences, items, hiddenCount } = useApplyHiddenPreferences({
    type: 'images',
    data: hits,
  });

  if (hits.length === 0) {
    const NotFound = (
      <div>
        <Center>
          <Stack gap="md" align="center" maw={800}>
            {hiddenCount > 0 && (
              <Text c="dimmed">{hiddenCount} images have been hidden due to your settings</Text>
            )}
            <ThemeIcon size={128} radius={100} className="opacity-50">
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} lh={1}>
              No images found
            </Title>
            <Text align="center">
              We have a bunch of images, but it looks like we couldn&rsquo;t find any images with
              prompt or tags matching your query.
            </Text>
          </Stack>
        </Center>
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
        <Text c="dimmed">{hiddenCount} images have been hidden due to your settings.</Text>
      )}
      {/* <div
        className={classes.grid}
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(290px, 1fr))`,
        }}
      >

        <ImagesProvider images={images as any}>
          {images.map((hit) => (
            <ImageCard key={hit.id} data={hit} />
          ))}
        </ImagesProvider>
      </div> */}
      <div>
        <ImagesProvider images={items as any} hideReactions>
          <MasonryColumnsVirtual
            data={items as any}
            imageDimensions={(data) => {
              const width = data?.width ?? 450;
              const height = data?.height ?? 450;
              return { width, height };
            }}
            adjustHeight={({ height }) => {
              const imageHeight = Math.max(Math.min(height, 600), 150);
              return imageHeight;
            }}
            maxItemHeight={600}
            render={ImagesCardMemoized}
            itemId={(data) => data.id}
            withAds
          />
        </ImagesProvider>
      </div>
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

ImageSearch.getLayout = function getLayout(page: React.ReactNode) {
  return (
    <SearchLayout
      indexName={IMAGES_SEARCH_INDEX}
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

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.imageSearch) return { notFound: true };
  },
});
