import { useShowEventCosmetics } from '~/providers/BrowserSettingsProvider';
import type { MantineSize } from '@mantine/core';
import {
  Anchor,
  Box,
  Button,
  Divider,
  Group,
  Stack,
  Text,
  Badge,
  UnstyledButton,
  useComputedColorScheme,
} from '@mantine/core';
import { Popover } from '~/components/MantineOverlays';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import {
  IconAlertCircle,
  IconMapPin,
  IconExternalLink,
  IconPencilMinus,
  IconRss,
  IconShare3,
  IconInfoCircle,
  IconShoppingBag,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import clsx from 'clsx';
import React, { useMemo, useState } from 'react';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { ChatUserButton } from '~/components/Chat/ChatUserButton';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DomainLinkIcons } from '~/components/DomainIcon/DomainLinkIcons';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { AnnouncementMuteToggle } from '~/components/Announcements/AnnouncementMuteToggle';
import { NextLink } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { UserContextMenu } from '~/components/Profile/UserContextMenu';
import { SidebarBackgroundArt } from '~/components/Profile/SidebarBackgroundArt';
import { UserStats } from '~/components/Profile/UserStats';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { Username } from '~/components/User/Username';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import {
  avatarHatOverhang,
  isShowcaseHatShowing,
} from '~/components/Cosmetics/EventDecoration/AvatarHat';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import type { PrivacySettingsSchema } from '~/server/schema/user-profile.schema';
import type { SidebarBackgroundCosmetic } from '~/server/selectors/cosmetic.selector';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { openUserProfileEditModal } from '~/components/Dialog/triggers/user-profile-edit';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useBuzzCurrencyConfig } from '../Currency/useCurrencyConfig';
import { LegendStatusLine } from '~/components/CreatorJourney/LegendStatusLine';
import { MemorialBadge, MemorialBanner } from '~/components/Profile/MemorialBanner';
import { getBadgeImageUrl, splitProfileBadges } from '~/shared/utils/badge-visibility';
import { useAvailableBuzz } from '../Buzz/useAvailableBuzz';
import { useQueryCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { useQueryShopServices } from '~/components/CreatorShop/Services/creator-service.util';
import {
  sectionIcons,
  storefrontSectionId,
  storefrontShowsServices,
} from '~/components/CreatorShop/section-meta';

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
  const colorScheme = useComputedColorScheme('dark');
  const isMobile = useContainerSmallerThan('sm');
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const showEventCosmetics = useShowEventCosmetics();
  const { data: user } = trpc.userProfile.get.useQuery({
    username,
  });
  const isCurrentUser = currentUser?.id === user?.id;
  const muted = !!user?.muted;
  const memorial = user?.memorial ?? null;
  const [showAllBadges, setShowAllBadges] = useState<boolean>(false);
  const [enlargedBadge, setEnlargedBadge] = useState<number | null>(null);
  const sizeOpts = mapSize[isMobile ? 'mobile' : 'desktop'];
  // Mobile renders this inside ProfileHeader with its own action row, so only desktop changes.
  const redesign = !!features.profileRedesign && !isMobile;
  const [mainBuzzColor] = useAvailableBuzz();
  const buzzColorConfig = useBuzzCurrencyConfig(mainBuzzColor);

  const hasPublicShop = !!features.creatorShop && !!user?.creatorShopEnabled;
  const { offerings: services } = useQueryShopServices(
    user?.id ?? 0,
    redesign && hasPublicShop && !!features.creatorServices
  );
  const { shop } = useQueryCreatorShop(redesign && services.length > 0 ? user?.id : undefined);
  const showServicesBtn = storefrontShowsServices(shop, services.length, features);

  const badges = useMemo(
    () =>
      !user
        ? []
        : user.cosmetics
            .map((c) => c.cosmetic)
            .filter((c) => c.type === CosmeticType.Badge && !!getBadgeImageUrl(c))
            .reverse(),
    [user]
  );

  if (!user) {
    return null;
  }

  const { profile, stats } = user;
  const shouldDisplayStats = stats && !!Object.values(stats).find((stat) => stat !== 0);
  const equippedCosmetics = user?.cosmetics.filter((c) => !!c.equippedAt);
  const sidebarBackground = redesign
    ? equippedCosmetics.find((c) => c.cosmetic.type === CosmeticType.SidebarBackground)?.cosmetic
    : undefined;

  const privacy = profile.privacySettings as PrivacySettingsSchema | null | undefined;
  const { highlightedBadges, otherBadges } = splitProfileBadges(badges, privacy, getBadgeImageUrl);

  const renderBadge = (award: (typeof badges)[number]) => {
    const url = getBadgeImageUrl(award);
    if (!url) return null;
    const isEnlarged = enlargedBadge === award.id;
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
        onChange={(opened) =>
          setEnlargedBadge((curr) => (opened ? award.id : curr === award.id ? null : curr))
        }
      >
        <Popover.Target>
          <Box style={style}>
            <EdgeMedia src={url} alt={award.name} optimized />
          </Box>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap={0}>
            <Text size="sm" align="center" fw={500}>
              {award.name}
            </Text>
            {award.videoUrl && (
              <Anchor href={award.videoUrl} size="xs" opacity={0.9} mt={4} target="_blank">
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  How it was made <IconExternalLink size={14} style={{ marginLeft: 4 }} />
                </span>
              </Anchor>
            )}
          </Stack>
        </Popover.Dropdown>
      </Popover>
    );
  };
  const editProfileBtn = isCurrentUser && (
    <Button
      leftSection={isMobile ? undefined : <IconPencilMinus size={16} />}
      size={sizeOpts.button}
      onClick={() => openUserProfileEditModal()}
      style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
      radius="xl"
      fullWidth
    >
      Customize profile
    </Button>
  );
  const followUserBtn = !isCurrentUser && (
    <Group gap={4} wrap="nowrap" className="flex-1">
      <FollowUserButton
        userId={user.id}
        checkFollowsYou
        leftSection={isMobile ? undefined : <IconRss size={16} />}
        size={sizeOpts.button}
        style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5, flex: 1 }}
        variant={isMobile ? 'filled' : undefined}
      />
      <AnnouncementMuteToggle creatorId={user.id} creatorName={user.username} solid={redesign} />
    </Group>
  );

  const TipBuzzBtn = ({ label }: { label?: string }) => (
    <TipBuzzButton
      toUserId={user.id}
      size={sizeOpts.button}
      variant={isMobile ? 'filled' : 'light'}
      color={buzzColorConfig.color}
      label={label}
      style={{ fontSize: '14px', fontWeight: 590 }}
    />
  );

  const ChatBtn = ({ label }: { label?: string }) => (
    <ChatUserButton
      user={{ ...user, cosmetics: equippedCosmetics }}
      label={label}
      size={sizeOpts.button}
      color="success.9"
      style={{ fontSize: '14px', fontWeight: 590, lineHeight: 1.5 }}
    />
  );

  const shareBtn = (
    <ShareButton url={router.asPath} title={user.username ? `${user.username} Profile` : undefined}>
      <LegacyActionIcon
        size={30}
        radius="xl"
        color="gray"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        ml="auto"
      >
        <IconShare3 size={16} />
      </LegacyActionIcon>
    </ShareButton>
  );

  // Shown when the user has a live, public Creator Shop.
  const shopBtn = features.creatorShop && user.creatorShopEnabled && (
    <Button
      component={NextLink}
      href={`/user/${username}/shop`}
      variant={isMobile ? 'filled' : 'light'}
      color="yellow"
      size={sizeOpts.button}
      radius="xl"
      leftSection={<IconShoppingBag size={16} />}
      style={{ fontSize: 14, fontWeight: 590, lineHeight: 1.5 }}
      fullWidth
    >
      Visit shop
    </Button>
  );

  const ServicesIcon = sectionIcons.services;
  const servicesBtn = showServicesBtn && (
    <Button
      component={NextLink}
      href={`/user/${username}/shop#${storefrontSectionId('services')}`}
      variant="light"
      color="yellow"
      size={sizeOpts.button}
      radius="xl"
      leftSection={<ServicesIcon size={16} />}
      style={{ fontSize: 14, fontWeight: 590, lineHeight: 1.5 }}
    >
      Services
    </Button>
  );

  const mutedAlert = isCurrentUser && muted && (
    <AlertWithIcon icon={<IconAlertCircle />} iconSize="sm">
      You cannot edit your profile because your account has been restricted
    </AlertWithIcon>
  );

  // The sidebar scrolls, so it clips a showcase hat reaching above the avatar unless it makes room.
  const hatRoom =
    showEventCosmetics && isShowcaseHatShowing(user.showcaseHat)
      ? avatarHatOverhang(user.showcaseHat, sizeOpts.avatar)
      : 0;
  // Redesign: a hat gets just enough room for itself and its drop shadow, never less than the
  // no-hat padding.
  const hatPaddingTop = !hatRoom
    ? undefined
    : redesign
    ? `max(var(--mantine-spacing-md), ${hatRoom + 4}px)`
    : `calc(var(--mantine-spacing-md) + ${hatRoom}px)`;

  const avatar = (
    <UserAvatar
      avatarSize={sizeOpts.avatar}
      user={{ ...user, cosmetics: equippedCosmetics }}
      size={sizeOpts.username}
      // Oversized radius to make it always a circle
      radius={1000}
      withShowcaseHat
    />
  );
  const rankBadge = <RankBadge rank={user.rank} size={sizeOpts.rankBadge} withTitle />;
  const identity = (
    <Stack
      gap={0}
      align={redesign ? 'center' : undefined}
      maw={redesign ? '100%' : undefined}
      ta={redesign ? 'center' : undefined}
    >
      <Username {...user} cosmetics={equippedCosmetics} size="xl" />
      <Text c="dimmed" size="sm">
        Joined {formatDate(user.createdAt)}
      </Text>
      {memorial && (
        <Group mt={4}>
          <MemorialBadge />
        </Group>
      )}
      {features.creatorJourney && <LegendStatusLine userId={user.id} />}
      {currentUser?.isModerator && (
        <CopyButton value={String(user.id)}>
          {({ copied, copy, color }) => (
            <Text c={copied ? color : 'dimmed'} size="sm" className="cursor-pointer" onClick={copy}>
              {copied ? 'Copied!' : `User ID: ${user.id}`}
            </Text>
          )}
        </CopyButton>
      )}
      {user?.bannedAt && (
        <Group>
          <Popover withArrow>
            <Popover.Target>
              <UnstyledButton>
                <Badge
                  color="red"
                  style={{
                    height: 'auto',
                    whiteSpace: 'normal',
                    padding: '4px 8px',
                  }}
                >
                  <Group gap={4} wrap="nowrap" align="flex-start">
                    <Text style={{ whiteSpace: 'normal', lineHeight: 1.3, textAlign: 'left' }}>
                      {user?.banReason ? `Banned: ${user?.banReason}` : 'Banned'}
                    </Text>
                    {user?.bannedReasonDetails && (
                      <IconInfoCircle size={16} style={{ flexShrink: 0 }} />
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
  );

  return (
    <Stack
      // Isolated so the sidebar art can sit behind the header without leaving the sidebar.
      className={clsx(className, redesign && 'isolate')}
      gap={sizeOpts.spacing}
      p="md"
      pt={hatPaddingTop}
      pos={redesign ? 'relative' : undefined}
      data-profile-redesign={redesign || undefined}
    >
      {sidebarBackground && (
        <SidebarBackgroundArt
          data={sidebarBackground.data as SidebarBackgroundCosmetic['data']}
          className="absolute inset-x-0 top-0 -z-10 h-60"
        />
      )}
      {redesign ? (
        <>
          <Group
            gap="xs"
            wrap="nowrap"
            pos="absolute"
            top="var(--mantine-spacing-md)"
            right="var(--mantine-spacing-md)"
            className="z-10"
          >
            {shareBtn}
            <UserContextMenu username={username} />
          </Group>
          <Stack gap={sizeOpts.spacing} align="center">
            {avatar}
            {rankBadge}
            {identity}
          </Stack>
        </>
      ) : (
        <>
          <Group wrap="nowrap" justify="space-between">
            <Group align="flex-start" justify="space-between" w={!isMobile ? '100%' : undefined}>
              {avatar}

              {!isMobile && (
                <Group>
                  {shareBtn}
                  <UserContextMenu username={username} />
                </Group>
              )}
            </Group>
            {isMobile && (
              <Group wrap="nowrap" gap={4}>
                {muted ? mutedAlert : editProfileBtn}
                {!user?.bannedAt && (
                  <>
                    {followUserBtn}
                    {!memorial && <TipBuzzBtn label="" />}
                    {!memorial && <ChatBtn label="" />}
                  </>
                )}
                {shareBtn}
                <UserContextMenu username={username} />
              </Group>
            )}
          </Group>
          {rankBadge}
          {identity}
        </>
      )}

      {profile.location && !muted && (
        <Group gap="sm" wrap="nowrap">
          <IconMapPin size={16} style={{ flexShrink: 0 }} />
          <Text c="dimmed" truncate size={sizeOpts.text}>
            {profile.location}
          </Text>
        </Group>
      )}
      {profile?.bio && !muted && (
        <ContentClamp
          maxHeight={sizeOpts.bio}
          style={{ wordWrap: 'break-word', whiteSpace: 'pre-line' }}
        >
          {profile.bio}
        </ContentClamp>
      )}
      {!muted && (
        <Group gap={4}>
          <DomainLinkIcons links={user.links} size={24} iconSize={sizeOpts.icons} />
        </Group>
      )}
      {memorial && user.username && (
        <MemorialBanner username={user.username} tributes={memorial.tributes} />
      )}
      {redesign && !user?.bannedAt && (
        <Stack gap="xs">
          {isCurrentUser ? (
            muted ? (
              mutedAlert
            ) : (
              editProfileBtn
            )
          ) : (
            <>
              {followUserBtn}
              {!memorial && (
                <Group grow wrap="nowrap" gap="xs">
                  <TipBuzzBtn />
                  <ChatBtn />
                </Group>
              )}
            </>
          )}
          {shopBtn && (
            <Group grow wrap="nowrap" gap="xs">
              {shopBtn}
              {servicesBtn}
            </Group>
          )}
        </Stack>
      )}
      {!isMobile && !redesign && !user?.bannedAt && (
        <>
          <Group grow>
            {muted ? mutedAlert : editProfileBtn}
            {followUserBtn}
          </Group>
          {!memorial && <TipBuzzBtn />}
          {!memorial && <ChatBtn />}
          {shopBtn}
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

      {badges.length > 0 && profile.privacySettings?.showBadges !== false && (
        <Stack gap={sizeOpts.spacing}>
          {highlightedBadges.length > 0 && (
            <Stack gap={sizeOpts.spacing}>
              <Text size={sizeOpts.text} c="dimmed" fw={590}>
                Highlighted
              </Text>
              <Group gap="xs">{highlightedBadges.map(renderBadge)}</Group>
            </Stack>
          )}
          {otherBadges.length > 0 && (
            <Stack gap={sizeOpts.spacing}>
              <Text size={sizeOpts.text} c="dimmed" fw={590}>
                {highlightedBadges.length > 0 ? 'More badges' : 'Badges'}
              </Text>
              <Group gap="xs">
                {(showAllBadges ? otherBadges : otherBadges.slice(0, sizeOpts.badgeCount)).map(
                  renderBadge
                )}
                {otherBadges.length > sizeOpts.badgeCount && (
                  <Button
                    color="gray"
                    variant="light"
                    onClick={() => setShowAllBadges((prev) => !prev)}
                    size="xs"
                    style={{ fontSize: 12, fontWeight: 600 }}
                    fullWidth
                  >
                    {showAllBadges ? 'Show less' : `Show all (${otherBadges.length})`}
                  </Button>
                )}
              </Group>
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
}
