import {
  ActionIcon,
  Avatar,
  Divider,
  Group,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { IconMapPin, IconRss } from '@tabler/icons-react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getInitials } from '~/utils/string-helpers';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { sortDomainLinks } from '~/utils/domain-link';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { UserStats } from '~/components/Profile/UserStats';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { formatDate } from '~/utils/date-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { useMemo } from 'react';

export function ProfileSidebar({ username }: { username: string }) {
  const currentUser = useCurrentUser();
  const { data: user } = trpc.userProfile.get.useQuery({
    username,
  });

  const awards = useMemo(
    () =>
      !user
        ? []
        : user.cosmetics
            .map((c) => c.cosmetic)
            .filter((c) => c.type === 'Badge' && !!c.data)
            .slice(0, 4),
    [user]
  );

  if (!user) {
    return null;
  }

  const { profile, stats } = user;

  return (
    <Stack>
      <Avatar
        src={
          user.image
            ? getEdgeUrl(user.image, {
                width: 88,
                anim: currentUser ? (!currentUser.autoplayGifs ? false : undefined) : undefined,
              })
            : undefined
        }
        alt={`${user.username}'s Avatar` ?? undefined}
        radius="md"
        size={88}
        imageProps={{ loading: 'lazy' }}
        sx={{ backgroundColor: 'rgba(0,0,0,0.31)' }}
      >
        {user.username ? getInitials(user.username) : null}
      </Avatar>
      <RankBadge rank={user.rank} size="lg" withTitle />
      <Stack spacing={0}>
        <Text weight={700} size={24}>
          {user.username}
        </Text>
        <Group spacing="sm">
          <Text color="dimmed">Santiago, RD - TODO</Text>
          <IconMapPin size={16} />
        </Group>
      </Stack>
      {profile?.bio && <ContentClamp maxHeight={48}>{profile.bio}</ContentClamp>}
      <Group spacing={4}>
        {sortDomainLinks(user.links).map((link, index) => (
          <ActionIcon
            key={index}
            component="a"
            href={link.url}
            target="_blank"
            rel="nofollow noreferrer"
            size={24}
          >
            <DomainIcon domain={link.domain} size={24} />
          </ActionIcon>
        ))}
      </Group>
      <Group grow>
        <FollowUserButton
          userId={user.id}
          leftIcon={<IconRss size={16} />}
          size="md"
          sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
        />
      </Group>

      <Divider my="sm" />

      {stats && (
        <UserStats
          rating={{ value: stats.ratingAllTime, count: stats.ratingCountAllTime }}
          followers={stats.followerCountAllTime}
          favorites={stats.favoriteCountAllTime}
          downloads={stats.downloadCountAllTime}
        />
      )}
      <TipBuzzButton
        toUserId={user.id}
        size="md"
        variant="light"
        color="yellow.7"
        label="Tip buzz"
        sx={{ fontSize: '14px', fontWeight: 590 }}
      />

      <Divider my="sm" />

      {awards.length > 0 && (
        <Stack>
          <Text size="md" color="dimmed" weight={590}>
            Awards
          </Text>
          <Group spacing="xs" position="apart">
            {awards.map((award) => {
              const data = (award.data ?? {}) as { url?: string };
              const url = (data.url ?? '') as string;

              if (!url) {
                return null;
              }

              return (
                <Tooltip key={award.id} label={award.name} withinPortal>
                  <EdgeMedia src={url} width={56} />
                </Tooltip>
              );
            })}
          </Group>
          <Divider my="sm" />
        </Stack>
      )}

      <Text color="dimmed">Joined {formatDate(user.createdAt)}</Text>
    </Stack>
  );
}
