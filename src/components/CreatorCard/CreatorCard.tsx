import { ActionIcon, Card, Group, Rating, Stack, Text, useMantineTheme } from '@mantine/core';
import { IconDownload, IconHeart, IconUpload, IconUsers, IconStar } from '@tabler/icons';

import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { sortDomainLinks } from '~/utils/domain-link';
import { formatDate } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export function CreatorCard({ user }: Props) {
  const theme = useMantineTheme();

  const { data: creator } = trpc.user.getCreator.useQuery(
    { username: user.username ?? '' },
    {
      initialData: {
        ...user,
        stats: {
          downloadCountAllTime: 0,
          favoriteCountAllTime: 0,
          followerCountAllTime: 0,
          ratingAllTime: 0,
          ratingCountAllTime: 0,
        },
      },
      staleTime: 0,
    }
  );

  const { models: uploads } = creator?._count ?? { models: 0 };
  const stats = creator?.stats;

  if (!creator) return null;

  return (
    <Card p="xs" withBorder>
      <Card.Section py="xs" inheritPadding>
        <Stack spacing="xs">
          <Group align="center" position="apart">
            <UserAvatar
              size="md"
              user={creator}
              subText={`Member since ${formatDate(creator.createdAt)}`}
              withUsername
              linkToProfile
            />
            <Group spacing="xs">
              <RankBadge size="lg" rank={creator.rank?.leaderboardRank} />
              <FollowUserButton userId={creator.id} size="sm" compact />
            </Group>
          </Group>
          {stats && (
            <Group position="apart">
              <IconBadge
                tooltip="Average Rating"
                sx={{ userSelect: 'none' }}
                size="lg"
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
              >
                <Text size="xs" color={stats.ratingCountAllTime > 0 ? undefined : 'dimmed'}>
                  {abbreviateNumber(stats.ratingCountAllTime)}
                </Text>
              </IconBadge>
              <Group spacing={4} noWrap>
                <IconBadge
                  tooltip="Uploads"
                  icon={<IconUpload size={14} />}
                  color="gray"
                  size="lg"
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                >
                  <Text size="xs">{abbreviateNumber(uploads)}</Text>
                </IconBadge>
                <IconBadge
                  tooltip="Followers"
                  icon={<IconUsers size={14} />}
                  href={`${creator.username}/followers`}
                  color="gray"
                  size="lg"
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                >
                  <Text size="xs">{abbreviateNumber(stats.followerCountAllTime)}</Text>
                </IconBadge>
                <IconBadge
                  tooltip="Favorites"
                  icon={<IconHeart size={14} />}
                  color="gray"
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                  size="lg"
                >
                  <Text size="xs">{abbreviateNumber(stats.favoriteCountAllTime)}</Text>
                </IconBadge>
                <IconBadge
                  tooltip="Downloads"
                  icon={<IconDownload size={14} />}
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                  size="lg"
                >
                  <Text size="xs">{abbreviateNumber(stats.downloadCountAllTime)}</Text>
                </IconBadge>
              </Group>
            </Group>
          )}
        </Stack>
      </Card.Section>
      {creator.links && creator.links.length > 0 ? (
        <Card.Section py="xs" withBorder inheritPadding>
          <Group spacing={4}>
            {sortDomainLinks(creator.links).map((link, index) => (
              <ActionIcon
                key={index}
                component="a"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                size="md"
              >
                <DomainIcon domain={link.domain} size={22} />
              </ActionIcon>
            ))}
          </Group>
        </Card.Section>
      ) : null}
    </Card>
  );
}

type Props = {
  user: UserWithCosmetics;
};
