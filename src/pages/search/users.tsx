import {
  Stack,
  Text,
  Box,
  Center,
  Loader,
  Title,
  ThemeIcon,
  useMantineTheme,
  Card,
  Group,
  Rating,
  ActionIcon,
} from '@mantine/core';
import { useInfiniteHits, useInstantSearch } from 'react-instantsearch';

import { SortBy } from '~/components/Search/CustomSearchComponents';
import { useInView } from 'react-intersection-observer';
import { useEffect } from 'react';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import {
  IconCloudOff,
  IconDownload,
  IconHeart,
  IconStar,
  IconUpload,
  IconUsers,
} from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { formatDate } from '~/utils/date-helpers';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { StatTooltip } from '~/components/Tooltips/StatTooltip';
import { abbreviateNumber, formatToLeastDecimals } from '~/utils/number-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';

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
          { label: 'Highest Rated', value: 'users:stats.weightedRating:desc' },
          { label: 'Most Followed', value: 'users:stats.followerCountAllTime:desc' },
          { label: 'Most Uploads', value: 'users:stats.uploadCountAllTime:desc' },
          { label: 'Newest', value: 'users:createdAt:desc' },
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
      <Box
        className={cx(classes.grid)}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(350px, 1fr))`,
        }}
      >
        {hits.map((hit) => {
          return <CreatorCard key={hit.id} data={hit} />;
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

export function CreatorCard({ data }: { data: UserSearchIndexRecord }) {
  const theme = useMantineTheme();

  if (!data) return null;

  const stats = data.stats;
  const iconBadgeSize = 'sm';

  const uploads = stats?.uploadCountAllTime;

  return (
    <Card p="xs" withBorder>
      <Card.Section py="xs" inheritPadding>
        <Stack spacing="xs">
          <Group align="center" position="apart">
            <UserAvatar
              size="sm"
              user={data}
              subText={`Joined ${formatDate(data.createdAt)}`}
              withUsername
              linkToProfile
            />
            <Group spacing="xs">
              <RankBadge size="md" rank={data.rank} />
            </Group>
          </Group>
          {stats && (
            <Group position="apart" spacing={0} noWrap>
              <IconBadge
                sx={{ userSelect: 'none' }}
                size={iconBadgeSize}
                icon={
                  <Rating
                    size="xs"
                    value={stats.ratingAllTime}
                    readOnly
                    emptySymbol={
                      theme.colorScheme === 'dark' ? (
                        <IconStar size={14} fill="rgba(255,255,255,.3)" color="transparent" />
                      ) : undefined
                    }
                  />
                }
                variant={
                  theme.colorScheme === 'dark' && stats.ratingCountAllTime > 0 ? 'filled' : 'light'
                }
                tooltip={
                  <StatTooltip
                    value={`${formatToLeastDecimals(stats.ratingAllTime)} (${
                      stats.ratingCountAllTime
                    })`}
                    label="Average Rating"
                  />
                }
              >
                <Text size="xs" color={stats.ratingCountAllTime > 0 ? undefined : 'dimmed'}>
                  {abbreviateNumber(stats.ratingCountAllTime)}
                </Text>
              </IconBadge>
              <Group spacing={4} noWrap>
                {!uploads || uploads === 0 ? null : (
                  <IconBadge
                    icon={<IconUpload size={14} />}
                    href={`/user/${data.username}`}
                    color="gray"
                    size={iconBadgeSize}
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    tooltip={<StatTooltip value={uploads} label="Uploads" />}
                    sx={(theme) => ({
                      [theme.fn.smallerThan('xs')]: {
                        display: 'none',
                      },
                    })}
                  >
                    <Text size="xs">{abbreviateNumber(uploads)}</Text>
                  </IconBadge>
                )}
                <IconBadge
                  icon={<IconUsers size={14} />}
                  href={`/user/${data.username}/followers`}
                  color="gray"
                  size={iconBadgeSize}
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                  tooltip={<StatTooltip value={stats.followerCountAllTime} label="Followers" />}
                >
                  <Text size="xs">{abbreviateNumber(stats.followerCountAllTime)}</Text>
                </IconBadge>
                <IconBadge
                  icon={<IconHeart size={14} />}
                  color="gray"
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                  size={iconBadgeSize}
                  tooltip={<StatTooltip value={stats.favoriteCountAllTime} label="Favorites" />}
                >
                  <Text size="xs">{abbreviateNumber(stats.favoriteCountAllTime)}</Text>
                </IconBadge>
                {uploads === 0 ? null : (
                  <IconBadge
                    icon={<IconDownload size={14} />}
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    size={iconBadgeSize}
                    tooltip={
                      <StatTooltip value={stats.downloadCountAllTime} label="Total Downloads" />
                    }
                  >
                    <Text size="xs">{abbreviateNumber(stats.downloadCountAllTime)}</Text>
                  </IconBadge>
                )}
              </Group>
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
  return <SearchLayout indexName="users">{page}</SearchLayout>;
};
