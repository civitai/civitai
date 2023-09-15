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
import { BOUNTIES_SEARCH_INDEX } from '~/server/common/constants';
import { BountiesSearchIndexSortBy } from '~/components/Search/parsers/bounties.parser';
import { BountySearchIndexRecord } from '~/server/search-index/bounties.search-index';
import { BountyCard } from '~/components/Cards/BountyCard';
import { applyUserPreferencesBounties } from '~/components/Search/search.utils';

export default function BountySearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Filters>
        <RenderFilters />
      </SearchLayout.Filters>
      <SearchLayout.Content>
        <SearchHeader />
        <BountyHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

const RenderFilters = () => {
  return (
    <>
      <SortBy
        title="Sort bounties by"
        items={[
          { label: 'Relevancy', value: BountiesSearchIndexSortBy[0] as string },
          { label: 'Most Buzz', value: BountiesSearchIndexSortBy[1] as string },
          { label: 'Entry Count', value: BountiesSearchIndexSortBy[2] as string },
          { label: 'Favorite', value: BountiesSearchIndexSortBy[3] as string },
          { label: 'Newest', value: BountiesSearchIndexSortBy[4] as string },
        ]}
      />
      <ChipRefinementList title="Filter by type" attribute="type" sortBy={['name']} />
      <ChipRefinementList
        title="Filter by Base Model"
        attribute="details.baseModel"
        sortBy={['name']}
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
        sortBy={['count:desc']}
        searchable={true}
      />
    </>
  );
};

export function BountyHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHits<BountySearchIndexRecord>();
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

  const bounties = useMemo(() => {
    if (loadingPreferences) {
      return [];
    }

    return applyUserPreferencesBounties<BountySearchIndexRecord>({
      items: hits,
      hiddenUsers,
      hiddenImages,
      hiddenTags,
      currentUserId: currentUser?.id,
    });
  }, [hits, hiddenUsers, hiddenImages, hiddenTags, currentUser]);

  const hiddenItems = hits.length - bounties.length;

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
                {hiddenItems} bounties have been hidden due to your settings.
              </Text>
            )}
            <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} inline>
              No bounties found
            </Title>
            <Text align="center">
              We have a bunch of bounties, but it looks like we couldn&rsquo;t find any matching
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
        <Text color="dimmed">{hiddenItems} bounties have been hidden due to your settings.</Text>
      )}
      <Box
        className={cx(classes.grid)}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(350px, 1fr))`,
        }}
      >
        {bounties.map((hit) => {
          return <BountyCard key={hit.id} data={hit} />;
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

BountySearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout indexName={BOUNTIES_SEARCH_INDEX}>{page}</SearchLayout>;
};
