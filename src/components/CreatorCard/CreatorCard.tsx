import { ActionIcon, Card, Group, Stack } from '@mantine/core';

import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { sortDomainLinks } from '~/utils/domain-link';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import { UserStatBadges } from '../UserStatBadges/UserStatBadges';
import { TipBuzzButton } from '../Buzz/TipBuzzButton';

export function CreatorCard({ user, tipBuzzEntityType, tipBuzzEntityId }: Props) {
  const { data: creator } = trpc.user.getCreator.useQuery(
    { id: user.id },
    {
      placeholderData: {
        ...user,
        rank: null,
        stats: {
          downloadCountAllTime: 0,
          favoriteCountAllTime: 0,
          followerCountAllTime: 0,
          ratingAllTime: 0,
          ratingCountAllTime: 0,
        },
      },
    }
  );

  const { models: uploads } = creator?._count ?? { models: 0 };
  const stats = creator?.stats;

  if (!creator || user.id === -1) return null;

  return (
    <Card p="xs" withBorder>
      <Card.Section py="xs" inheritPadding>
        <Stack spacing="xs">
          <Group align="center" position="apart" noWrap>
            <UserAvatar
              size="sm"
              avatarProps={{ size: 32 }}
              user={creator}
              subText={`Joined ${formatDate(creator.createdAt)}`}
              withUsername
              linkToProfile
            />
            <Group spacing={8} noWrap>
              <TipBuzzButton
                toUserId={creator.id}
                size="xs"
                compact
                entityId={tipBuzzEntityId}
                entityType={tipBuzzEntityType}
              />
              <FollowUserButton userId={creator.id} size="xs" compact />
            </Group>
          </Group>
          <Group spacing={8}>
            <RankBadge size="md" rank={creator.rank} />
            {stats && (
              <UserStatBadges
                rating={{ value: stats.ratingAllTime, count: stats.ratingCountAllTime }}
                uploads={uploads}
                followers={stats.followerCountAllTime}
                favorite={stats.favoriteCountAllTime}
                downloads={stats.downloadCountAllTime}
              />
            )}
          </Group>
        </Stack>
      </Card.Section>
      {creator.links && creator.links.length > 0 ? (
        <Card.Section
          withBorder
          inheritPadding
          sx={(theme) => ({
            background: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
          })}
          py={5}
        >
          <Group spacing={4}>
            {sortDomainLinks(creator.links).map((link, index) => (
              <ActionIcon
                key={index}
                component="a"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                size={32}
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

type Props = {
  user: UserWithCosmetics;
  tipBuzzEntityId?: number;
  tipBuzzEntityType?: string;
};
