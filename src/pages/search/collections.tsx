import { Stack, Text, Box, Center, Loader, Title, ThemeIcon } from '@mantine/core';
import { useInfiniteHits, useInstantSearch } from 'react-instantsearch';

import {
  ChipRefinementList,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { useInView } from 'react-intersection-observer';
import { useEffect, useMemo } from 'react';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { applyUserPreferencesCollections } from '~/components/Search/search.utils';
import { COLLECTIONS_SEARCH_INDEX } from '~/server/common/constants';
import { CollectionsSearchIndexSortBy } from '~/components/Search/parsers/collection.parser';
import { CollectionCard } from '~/components/Cards/CollectionCard';
import { CollectionSearchIndexRecord } from '~/server/search-index/collections.search-index';

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
      <SearchableMultiSelectRefinementList
        title="Users"
        attribute="user.username"
        sortBy={['count:desc']}
        searchable={true}
      />
    </>
  );
};

export function CollectionHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHits<CollectionSearchIndexRecord>();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();
  const { classes, cx } = useSearchLayoutStyles();
  const currentUser = useCurrentUser();
  const {
    users: hiddenUsers,
    images: hiddenImages,
    tags: hiddenTags,
    isLoading: loadingPreferences,
  } = useHiddenPreferencesContext();

  const collections = useMemo(() => {
    return applyUserPreferencesCollections<CollectionSearchIndexRecord>({
      items: hits,
      hiddenUsers,
      hiddenImages,
      hiddenTags,
      currentUserId: currentUser?.id,
    });
  }, [hits, hiddenUsers, hiddenImages, hiddenTags, currentUser]);

  const hiddenItems = hits.length - collections.length;

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && status === 'idle' && !isLastPage) {
      showMore?.();
    }
  }, [status, inView, showMore, isLastPage]);

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
            {hiddenItems > 0 && (
              <Text color="dimmed">
                {hiddenItems} collections have been hidden due to your settings.
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
      {hiddenItems > 0 && (
        <Text color="dimmed">{hiddenItems} collections have been hidden due to your settings.</Text>
      )}
      <Box
        className={cx(classes.grid)}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(350px, 1fr))`,
        }}
      >
        {collections.map((hit) => {
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
                items: [],
                _count: {
                  items: hit.metrics?.itemCount ?? 0,
                  contributors: hit.metrics?.followerCount ?? 0,
                },
              }}
            />
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

CollectionSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout indexName={COLLECTIONS_SEARCH_INDEX}>{page}</SearchLayout>;
};
