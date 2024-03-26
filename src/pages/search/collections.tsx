import { Stack, Text, Box, Center, Loader, Title, ThemeIcon } from '@mantine/core';
import { useInstantSearch } from 'react-instantsearch';

import {
  BrowsingLevelFilter,
  ChipRefinementList,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { COLLECTIONS_SEARCH_INDEX } from '~/server/common/constants';
import { CollectionsSearchIndexSortBy } from '~/components/Search/parsers/collection.parser';
import { CollectionCard } from '~/components/Cards/CollectionCard';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';

export default function CollectionSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Filters>
        <RenderFilters />
      </SearchLayout.Filters>
      <SearchLayout.Content>
        <SearchHeader />
        <CollectionHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

const RenderFilters = () => {
  return (
    <>
      <BrowsingLevelFilter attributeName="nsfwLevel" />
      <SortBy
        title="Sort collections by"
        items={[
          { label: 'Relevancy', value: CollectionsSearchIndexSortBy[0] as string },
          { label: 'Most Followed', value: CollectionsSearchIndexSortBy[1] as string },
          { label: 'Item Count', value: CollectionsSearchIndexSortBy[2] as string },
          { label: 'Newest', value: CollectionsSearchIndexSortBy[3] as string },
        ]}
      />
      <ChipRefinementList title="Filter by type" attribute="type" sortBy={['name']} />
      <SearchableMultiSelectRefinementList title="Users" attribute="user.username" searchable />
    </>
  );
};

export function CollectionHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHitsTransformed<'collections'>();
  const { status } = useInstantSearch();
  const { classes, cx } = useSearchLayoutStyles();

  const { loadingPreferences, items, hiddenCount } = useApplyHiddenPreferences({
    type: 'collections',
    data: hits,
  });

  if (loadingPreferences) {
    return (
      <Box>
        <Center mt="md">
          <Loader />
        </Center>
      </Box>
    );
  }

  if (hits.length === 0) {
    const NotFound = (
      <Box>
        <Center>
          <Stack spacing="md" align="center" maw={800}>
            {hiddenCount > 0 && (
              <Text color="dimmed">
                {hiddenCount} collections have been hidden due to your settings.
              </Text>
            )}
            <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} inline>
              No collections found
            </Title>
            <Text align="center">
              We have a bunch of collections, but it looks like we couldn&rsquo;t find any matching
              your query.
            </Text>
          </Stack>
        </Center>
      </Box>
    );

    const loading = status === 'loading' || status === 'stalled';

    if (loading) {
      return (
        <Box>
          <Center mt="md">
            <Loader />
          </Center>
        </Box>
      );
    }

    return (
      <Box>
        <Center mt="md">
          {/* Just enough time to avoid blank random page */}
          <TimeoutLoader renderTimeout={() => <>{NotFound}</>} delay={150} />
        </Center>
      </Box>
    );
  }

  return (
    <Stack>
      {hiddenCount > 0 && (
        <Text color="dimmed">{hiddenCount} collections have been hidden due to your settings.</Text>
      )}
      <Box
        className={cx(classes.grid)}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(320px, 1fr))`,
        }}
      >
        {items.map((hit) => {
          return (
            <CollectionCard
              key={hit.id}
              sx={{}}
              data={{
                ...hit,
                // Reset values not relevant
                // Image is filled via images
                images: hit.images.slice(0, 4),
                srcs: hit.srcs.slice(0, 4),
                _count: {
                  items: hit.metrics?.itemCount ?? 0,
                  contributors: hit.metrics?.followerCount ?? 0,
                },
              }}
            />
          );
        })}
      </Box>
      {/* <MasonryGrid data={items} render={ArticleCard} itemId={(x) => x.id} empty={<NoContent />} /> */}
      {hits.length > 0 && !isLastPage && (
        <InViewLoader
          loadFn={showMore}
          loadCondition={status === 'idle'}
          style={{ gridColumn: '1/-1' }}
        >
          <Center p="xl" sx={{ height: 36 }} mt="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Stack>
  );
}

CollectionSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout indexName={COLLECTIONS_SEARCH_INDEX}>{page}</SearchLayout>;
};
