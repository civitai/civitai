import { Stack, Text, Box, Center, Loader, Title, ThemeIcon, Card, Group } from '@mantine/core';
import { useInstantSearch } from 'react-instantsearch';

import { SortBy } from '~/components/Search/CustomSearchComponents';
import { SearchHeader } from '~/components/Search/SearchHeader';
import type { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { SearchLayout } from '~/components/Search/SearchLayout';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { formatDate } from '~/utils/date-helpers';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { USERS_SEARCH_INDEX } from '~/server/common/constants';
import { UsersSearchIndexSortBy } from '~/components/Search/parsers/user.parser';
import { UserStatBadges } from '~/components/UserStatBadges/UserStatBadges';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import classes from '~/components/Search/SearchLayout.module.scss';

export default function UserSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Content>
        <SearchHeader />
        <UserHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

const RenderFilters = () => {
  return (
    <>
      <SortBy
        title="Sort users by"
        items={[
          { label: 'Relevancy', value: UsersSearchIndexSortBy[0] as string },
          { label: 'Most Followed', value: UsersSearchIndexSortBy[1] as string },
          { label: 'Highest Rated', value: UsersSearchIndexSortBy[2] as string },
          { label: 'Most Uploads', value: UsersSearchIndexSortBy[3] as string },
          { label: 'Newest', value: UsersSearchIndexSortBy[4] as string },
        ]}
      />
    </>
  );
};

export function UserHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHitsTransformed<'users'>();
  const { status } = useInstantSearch();

  const { loadingPreferences, items, hiddenCount } = useApplyHiddenPreferences({
    type: 'users',
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
          <Stack gap="md" align="center" maw={800}>
            {hiddenCount > 0 && (
              <Text c="dimmed">{hiddenCount} users have been hidden due to your settings.</Text>
            )}
            <ThemeIcon size={128} radius={100} className="opacity-50">
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} lh={1}>
              No users found
            </Title>
            <Text align="center">
              We have a bunch of users, but it looks like we couldn&rsquo;t find any matching your
              query.
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
        <Text c="dimmed">{hiddenCount} users have been hidden due to your settings.</Text>
      )}
      <div
        className={classes.grid}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(350px, 1fr))`,
        }}
      >
        {items.map((hit) => (
          <UserCard key={hit.id} data={hit} />
        ))}
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

export function UserCard({ data }: { data: UserSearchIndexRecord }) {
  if (!data) return null;

  const { metrics } = data;

  return (
    <Link legacyBehavior href={`/user/${data.username}`} passHref>
      <Card component="a" p="xs" withBorder>
        <Stack gap="xs">
          <Group justify="space-between" gap={8}>
            <UserAvatar
              size="sm"
              user={data}
              subText={`Joined ${formatDate(data.createdAt)}`}
              withUsername
            />
            <FollowUserButton userId={data.id} size="compact-sm" />
          </Group>
          <Group gap={8}>
            {data.rank && <RankBadge size="md" rank={data.rank} />}
            <UserStatBadges
              uploads={metrics?.uploadCount ?? 0}
              followers={metrics?.followerCount ?? 0}
              favorites={metrics?.thumbsUpCount ?? 0}
              downloads={metrics?.downloadCount ?? 0}
            />
          </Group>
        </Stack>
      </Card>
    </Link>
  );
}

UserSearch.getLayout = function getLayout(page: React.ReactNode) {
  return (
    <SearchLayout
      indexName={USERS_SEARCH_INDEX}
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
