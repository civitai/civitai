import {
  Stack,
  Text,
  createStyles,
  Box,
  Center,
  Loader,
  Title,
  ThemeIcon,
  Anchor,
} from '@mantine/core';
import { InstantSearch, useInfiniteHits, useInstantSearch } from 'react-instantsearch';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';

import { env } from '~/env/client.mjs';
import { SortBy } from '~/components/Search/CustomSearchComponents';
import { routing } from '~/components/Search/useSearchState';
import { useInView } from 'react-intersection-observer';
import { useEffect } from 'react';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { ModelCard } from '~/components/Cards/ModelCard';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import Link from 'next/link';
import { SearchLayout } from '~/components/Search/SearchLayout';
import { ModelsHitList } from '~/pages/search/models';
import ImageSearch from '~/pages/search/images';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

export default function UserSearch() {
  return (
    <InstantSearch searchClient={searchClient} indexName="users" routing={routing}>
      <SearchLayout.Root>
        <SearchLayout.Filters>
          <RenderFilters />
        </SearchLayout.Filters>
        <SearchLayout.Content>
          <SearchHeader />
          <UserHitList />
        </SearchLayout.Content>
      </SearchLayout.Root>
    </InstantSearch>
  );
}

const RenderFilters = () => {
  return (
    <>
      <SortBy
        title="Sort users by"
        items={[
          { label: 'Highest Rated', value: 'users:stats.ratingAllTime:desc' },
          { label: 'Most Followed', value: 'users:stats.followerCount:desc' },
          { label: 'Most Uploads', value: 'users:stats.uploadCountAllTime:desc' },
          { label: 'Newest', value: 'users:createdAt:desc' },
        ]}
      />
    </>
  );
};

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, minmax(350px, 1fr))`,
    columnGap: theme.spacing.md,
    gridTemplateRows: `auto 1fr`,
    overflow: 'hidden',
    marginTop: -theme.spacing.md,

    '& > *': {
      marginTop: theme.spacing.md,
    },
  },
}));

export function UserHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHits<UserSearchIndexRecord>();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();
  const { classes } = useStyles();

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
              No users found
            </Title>
            <Text align="center">
              We have a bunch of users, but it looks like we couldn&rsquo;t find any matching your
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
          return <CreatorCard key={hit.id} user={hit} displayFollowUser={false} />;
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

UserSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout>{page}</SearchLayout>;
};
