import type { MantineSize } from '@mantine/core';
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Divider,
  Group,
  Popover,
  Stack,
  Text,
  useMantineTheme,
  Badge,
  UnstyledButton,
} from '@mantine/core';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import {
  IconAlertCircle,
  IconMapPin,
  IconExternalLink,
  IconPencilMinus,
  IconRss,
  IconShare3,
  IconInfoCircle,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useMemo, useState } from 'react';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { ChatUserButton } from '~/components/Chat/ChatUserButton';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';

import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { UserContextMenu } from '~/components/Profile/UserContextMenu';
import { UserStats } from '~/components/Profile/UserStats';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { Username } from '~/components/User/Username';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { formatDate } from '~/utils/date-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { trpc } from '~/utils/trpc';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import type { BadgeCosmetic } from '~/server/selectors/cosmetic.selector';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { openUserProfileEditModal } from '~/components/Dialog/dialog-registry';

const mapSize: Record<
  'mobile' | 'desktop',
  {
    avatar: number;
    username: MantineSize;
    text: MantineSize;
    spacing: MantineSize | number;
    button: MantineSize;
    rankBadge: MantineSize;
    icons: number;
    badges: number;
    bio: number;
    badgeCount: number;
  }
> = {
  mobile: {
    avatar: 72,
    icons: 24,
    username: 'sm',
    text: 'sm',
    spacing: 4,
    button: 'sm',
    rankBadge: 'md',
    badges: 40,
    bio: 24,
    badgeCount: 7,
  },
  desktop: {
    avatar: 144,
    icons: 24,
    username: 'xl',
    text: 'md',
    spacing: 'md',
    button: 'md',
    rankBadge: 'xl',
    badges: 56,
    bio: 48,
    badgeCount: 4 * 4,
  },
};

export function ProfileSidebar({ username, className }: { username: string; className?: string }) {
  const router = useRouter();
  const theme = useMantineTheme();
  const isMobile = useContainerSmallerThan('sm');
  const currentUser = useCurrentUser();
  const { data: user } = trpc.userProfile.get.useQuery({
    username,
  });
  const isCurrentUser = currentUser?.id === user?.id;
  const muted = !!user?.muted;
  const [showAllBadges, setShowAllBadges] = useState<boolean>(false);
  const [enlargedBadge, setEnlargedBadge] = useState<number | null>(null);
  const sizeOpts = mapSize[isMobile ? 'mobile' : 'desktop'];

  const badges = useMemo(
    () =>
      !user
        ? []
        : user.cosmetics
            .map((c) => c.cosmetic)
            .filter((c) => c.type === CosmeticType.Badge && !!c.data)
            .reverse(),
    [user]
  );

  if (!user) {
    return null;
  }

  const { profile, stats } = user;
  const shouldDisplayStats = stats && !!Object.values(stats).find((stat) => stat !== 0);
  const equippedCosmetics = user?.cosmetics.filter((c) => !!c.equippedAt);
  const editProfileBtn = isCurrentUser && (
    <Button
      leftIcon={isMobile ? undefined : <IconPencilMinus size={16} />}
      size={sizeOpts.button}
      onClick={() => openUserProfileEditModal()}
      sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
      radius="xl"
      fullWidth
    >
      Customize profile
    </Button>
  );
  const followUserBtn = !isCurrentUser && (
    <FollowUserButton
      userId={user.id}
      leftIcon={isMobile ? undefined : <IconRss size={16} />}
      size={sizeOpts.button}
      sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
      variant={isMobile ? 'filled' : undefined}
    />
  );

  const TipBuzzBtn = ({ label }: { label?: string }) => (
    <TipBuzzButton
      toUserId={user.id}
      size={sizeOpts.button}
      variant={isMobile ? 'filled' : 'light'}
      color="yellow.7"
      label={label}
      sx={{ fontSize: '14px', fontWeight: 590 }}
    />
  );

  const ChatBtn = ({ label }: { label?: string }) => (
    <ChatUserButton
      user={user}
      label={label}
      size={sizeOpts.button}
      color="success.9"
      sx={{ fontSize: '14px', fontWeight: 590, lineHeight: 1.5 }}
    />
  );

  const shareBtn = (
    <ShareButton url={router.asPath} title={`${user.username} Profile`}>
      <ActionIcon
        size={30}
        radius="xl"
        color="gray"
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        ml="auto"
      >
        <IconShare3 size={16} />
      </ActionIcon>
    </ShareButton>
  );

  const mutedAlert = isCurrentUser && muted && (
    <AlertWithIcon icon={<IconAlertCircle />} iconSize="sm">
      You cannot edit your profile because your account has been restricted
    </AlertWithIcon>
  );

  return (
    <Stack className={className} spacing={sizeOpts.spacing} p="md">
      <Group noWrap position="apart">
        <Group align="flex-start" position="apart" w={!isMobile ? '100%' : undefined}>
          <UserAvatar
            avatarSize={sizeOpts.avatar}
            user={{ ...user, cosmetics: equippedCosmetics }}
            size={sizeOpts.username}
            // Oversized radius to make it always a circle
            radius={1000}
          />

          {!isMobile && (
            <Group>
              {shareBtn}
              <UserContextMenu username={username} />
            </Group>
          )}
        </Group>
        {isMobile && (
          <Group noWrap spacing={4}>
            {muted ? mutedAlert : editProfileBtn}
            {!user?.bannedAt && (
              <>
                {followUserBtn}
                <TipBuzzBtn label="" />
                <ChatBtn label="" />
              </>
            )}
            {shareBtn}
            <UserContextMenu username={username} />
          </Group>
        )}
      </Group>
      <RankBadge rank={user.rank} size={sizeOpts.rankBadge} withTitle />
      <Stack spacing={0}>
        <Username {...user} cosmetics={equippedCosmetics} size="xl" />
        <Text color="dimmed" size="sm">
          Joined {formatDate(user.createdAt)}
        </Text>
        {user?.bannedAt && (
          <Group>
            <Popover withArrow>
              <Popover.Target>
                <UnstyledButton>
                  <Badge color="red">
                    <Group spacing={0}>
                      <Text>{user?.banReason ? `Banned: ${user?.banReason}` : 'Banned'}</Text>
                      {user?.bannedReasonDetails && (
                        <IconInfoCircle size={16} style={{ marginLeft: 4 }} />
                      )}
                    </Group>
                  </Badge>
                </UnstyledButton>
              </Popover.Target>
              <Popover.Dropdown maw={350}>
                {user?.bannedReasonDetails ? (
                  <RenderHtml html={user?.bannedReasonDetails} style={{ fontSize: '14px' }} />
                ) : (
                  <Text>This user has been banned from the site.</Text>
                )}
              </Popover.Dropdown>
            </Popover>
          </Group>
        )}
      </Stack>

      {profile.location && !muted && (
        <Group spacing="sm" noWrap>
          <IconMapPin size={16} style={{ flexShrink: 0 }} />
          <Text color="dimmed" truncate size={sizeOpts.text}>
            {profile.location}
          </Text>
        </Group>
      )}
      {profile?.bio && !muted && (
        <ContentClamp maxHeight={sizeOpts.bio} style={{ wordWrap: 'break-word' }}>
          {profile.bio}
        </ContentClamp>
      )}
      {!muted && (
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
              <DomainIcon domain={link.domain} size={sizeOpts.icons} />
            </ActionIcon>
          ))}
        </Group>
      )}
      {!isMobile && !user?.bannedAt && (
        <>
          <Group grow>
            {muted ? mutedAlert : editProfileBtn}
            {followUserBtn}
          </Group>
          <TipBuzzBtn />
          <ChatBtn />
        </>
      )}

      <Divider my={sizeOpts.spacing} />

      {shouldDisplayStats && (
        <UserStats
          followers={stats.followerCountAllTime}
          favorites={stats.thumbsUpCountAllTime}
          downloads={stats.downloadCountAllTime}
          generations={stats.generationCountAllTime}
        />
      )}

      {(!isCurrentUser || shouldDisplayStats) && <Divider my={sizeOpts.spacing} />}

      {badges.length > 0 && (
        <Stack spacing={sizeOpts.spacing}>
          <Text size={sizeOpts.text} color="dimmed" weight={590}>
            Badges
          </Text>
          <Group spacing="xs">
            {(showAllBadges ? badges : badges.slice(0, sizeOpts.badgeCount)).map((award) => {
              const data = (award.data ?? {}) as BadgeCosmetic['data'];
              const url = (data.url ?? '') as string;
              const isEnlarged = enlargedBadge === award.id;

              if (!url) {
                return null;
              }

              const style = {
                transition: 'transform 0.1s',
                cursor: 'pointer',
                width: sizeOpts.badges,
                transform: isEnlarged ? 'scale(2)' : undefined,
                zIndex: isEnlarged ? 100 : undefined,
                filter: isEnlarged ? 'drop-shadow(0px 0px 3px #000000)' : undefined,
              };

              return (
                <Popover
                  key={award.id}
                  withArrow
                  width={200}
                  position="top"
                  offset={35}
                  onChange={(opened) => {
                    if (opened) {
                      setEnlargedBadge(award.id);
                    } else {
                      setEnlargedBadge((curr) => (curr === award.id ? null : curr));
                    }
                  }}
                >
                  <Popover.Target>
                    {data.animated ? (
                      <Box style={style}>
                        <EdgeMedia src={url} alt={award.name} />
                      </Box>
                    ) : (
                      <Box style={style}>
                        <EdgeMedia src={url} alt={award.name} />
                      </Box>
                    )}
                  </Popover.Target>
                  <Popover.Dropdown>
                    <Stack spacing={0}>
                      <Text size="sm" align="center" weight={500}>
                        {award.name}
                      </Text>
                      {award.videoUrl && (
                        <Anchor
                          href={award.videoUrl}
                          size="xs"
                          opacity={0.9}
                          mt={4}
                          target="_blank"
                        >
                          <span style={{ display: 'flex', alignItems: 'center' }}>
                            How it was made <IconExternalLink size={14} style={{ marginLeft: 4 }} />
                          </span>
                        </Anchor>
                      )}
                    </Stack>
                  </Popover.Dropdown>
                </Popover>
              );
            })}
            {badges.length > sizeOpts.badgeCount && (
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
