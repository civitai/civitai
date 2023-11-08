import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  HoverCard,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { IconMapPin, IconPencilMinus, IconRss } from '@tabler/icons-react';

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
import React, { useMemo, useState } from 'react';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { openUserProfileEditModal } from '~/components/Modals/UserProfileEditModal';
import { CosmeticType } from '@prisma/client';
import { Username } from '~/components/User/Username';

export function ProfileSidebar({ username, className }: { username: string; className?: string }) {
  const currentUser = useCurrentUser();
  const { data: user } = trpc.userProfile.get.useQuery({
    username,
  });
  const isCurrentUser = currentUser?.id === user?.id;
  const theme = useMantineTheme();
  const [showAllBadges, setShowAllBadges] = useState<boolean>(false);

  const badges = useMemo(
    () =>
      !user
        ? []
        : user.cosmetics
            .map((c) => c.cosmetic)
            .filter((c) => c.type === CosmeticType.Badge && !!c.data),
    [user]
  );

  if (!user) {
    return null;
  }

  const { profile, stats } = user;
  const shouldDisplayStats = stats && !!Object.values(stats).find((stat) => stat !== 0);
  const equippedCosmetics = user?.cosmetics.filter((c) => !!c.equippedAt);

  return (
    <Stack className={className}>
      <UserAvatar avatarSize={144} user={user} size="xl" radius="md" />
      <RankBadge rank={user.rank} size="lg" withTitle />
      <Stack spacing={0}>
        <Username {...user} cosmetics={equippedCosmetics} size="xl" />
        <Text color="dimmed" size="sm">
          Joined {formatDate(user.createdAt)}
        </Text>
      </Stack>
      {profile.location && (
        <Group spacing="sm" noWrap>
          <IconMapPin size={16} style={{ flexShrink: 0 }} />
          <Text color="dimmed" truncate>
            {profile.location}
          </Text>
        </Group>
      )}
      {profile?.bio && (
        <ContentClamp maxHeight={48} style={{ wordWrap: 'break-word' }}>
          {profile.bio}
        </ContentClamp>
      )}
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
        {isCurrentUser && (
          <Button
            leftIcon={<IconPencilMinus size={16} />}
            size="md"
            onClick={() => {
              openUserProfileEditModal({});
            }}
            sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
            radius="xl"
            fullWidth
          >
            Edit profile
          </Button>
        )}
        {!isCurrentUser && (
          <FollowUserButton
            userId={user.id}
            leftIcon={<IconRss size={16} />}
            size="md"
            sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
          />
        )}
      </Group>

      <Divider my="sm" />

      {shouldDisplayStats && (
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

      {(!isCurrentUser || shouldDisplayStats) && <Divider my="sm" />}

      {badges.length > 0 && (
        <Stack>
          <Text size="md" color="dimmed" weight={590}>
            Badges
          </Text>
          <Group spacing="xs">
            {(showAllBadges ? badges : badges.slice(0, 4)).map((award) => {
              const data = (award.data ?? {}) as { url?: string };
              const url = (data.url ?? '') as string;

              if (!url) {
                return null;
              }

              return (
                <HoverCard key={award.id} withArrow width={200} openDelay={500} position="top">
                  <HoverCard.Target>
                    <Box>
                      <EdgeMedia src={url} width={56} />
                    </Box>
                  </HoverCard.Target>
                  <HoverCard.Dropdown>
                    <Stack spacing={0}>
                      <Text size="sm" align="center" weight={500}>
                        {award.name}
                      </Text>
                    </Stack>
                  </HoverCard.Dropdown>
                </HoverCard>
              );
            })}
            {badges.length > 4 && (
              <Button
                color="gray"
                variant="light"
                onClick={() => setShowAllBadges((prev) => !prev)}
                size="xs"
                sx={{ fontSize: 12, fontWeight: 600 }}
                fullWidth
              >
                {showAllBadges ? 'Show less' : `Show all (${badges.length})`}
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
