import {
  Stack,
  Text,
  Box,
  Center,
  Loader,
  Title,
  ThemeIcon,
  Card,
  Group,
  ActionIcon,
} from '@mantine/core';
import { useInfiniteHits, useInstantSearch } from 'react-instantsearch';

import { SortBy } from '~/components/Search/CustomSearchComponents';
import { useInView } from 'react-intersection-observer';
import { useEffect, useMemo } from 'react';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { formatDate } from '~/utils/date-helpers';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { sortDomainLinks } from '~/utils/domain-link';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { applyUserPreferencesUsers } from '~/components/Search/search.utils';
import { USERS_SEARCH_INDEX } from '~/server/common/constants';
import { UsersSearchIndexSortBy } from '~/components/Search/parsers/user.parser';
import { UserStatBadges } from '~/components/UserStatBadges/UserStatBadges';

export default function UserSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Filters>
        <RenderFilters />
      </SearchLayout.Filters>
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
  const { hits, showMore, isLastPage } = useInfiniteHits<UserSearchIndexRecord>();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();
  const { classes, cx } = useSearchLayoutStyles();
  const currentUser = useCurrentUser();
  const { users: hiddenUsers, isLoading: loadingPreferences } = useHiddenPreferencesContext();

  const users = useMemo(() => {
    return applyUserPreferencesUsers<UserSearchIndexRecord>({
      items: hits,
      hiddenUsers,
      currentUserId: currentUser?.id,
    });
  }, [hits, hiddenUsers, currentUser]);

  const hiddenItems = hits.length - users.length;

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
              <Text color="dimmed">{hiddenItems} users have been hidden due to your settings.</Text>
            )}
            <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} inline>
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
      {hiddenItems > 0 && (
        <Text color="dimmed">{hiddenItems} users have been hidden due to your settings.</Text>
      )}
      <Box
        className={cx(classes.grid)}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(350px, 1fr))`,
        }}
      >
        {users.map((hit) => {
          return <CreatorCard key={hit.id} data={hit} />;
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

export function CreatorCard({ data }: { data: UserSearchIndexRecord }) {
  if (!data) return null;

  const stats = data.stats;
  const uploads = stats?.uploadCountAllTime;

  return (
    <Card p="xs" withBorder>
      <Card.Section py="xs" inheritPadding>
        <Stack spacing="xs">
          <UserAvatar
            size="sm"
            user={data}
            subText={`Joined ${formatDate(data.createdAt)}`}
            withUsername
            linkToProfile
          />
          {stats && (
            <Group spacing={8}>
              <RankBadge size="md" rank={data.rank} />
              <UserStatBadges
                rating={{ value: stats.ratingAllTime, count: stats.ratingCountAllTime }}
                uploads={uploads}
                followers={stats.followerCountAllTime}
                favorite={stats.favoriteCountAllTime}
                downloads={stats.downloadCountAllTime}
              />
            </Group>
          )}
        </Stack>
      </Card.Section>
      {data.links && data.links.length > 0 ? (
        <Card.Section
          withBorder
          inheritPadding
          sx={(theme) => ({
            background: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
          })}
          py={5}
        >
          <Group spacing={4}>
            {sortDomainLinks(data.links).map((link, index) => (
              <ActionIcon
                key={index}
                component="a"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                size="md"
              >
                <DomainIcon domain={link.domain} size={20} />
              </ActionIcon>
            ))}
          </Group>
        </Card.Section>
      ) : null}
    </Card>
  );
}

UserSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout indexName={USERS_SEARCH_INDEX}>{page}</SearchLayout>;
};
