import { uniqBy } from 'lodash-es';
import type { CardProps } from '@mantine/core';
import {
  ActionIcon,
  BackgroundImage,
  Box,
  Card,
  Group,
  Stack,
  Text,
  Image,
  useMantineTheme,
  useComputedColorScheme,
} from '@mantine/core';
import { ChatUserButton } from '~/components/Chat/ChatUserButton';

import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { UserAvatar, UserProfileLink } from '~/components/UserAvatar/UserAvatar';
import { constants, creatorCardStats, creatorCardStatsDefaults } from '~/server/common/constants';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { formatDate } from '~/utils/date-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { trpc } from '~/utils/trpc';
import { TipBuzzButton } from '../Buzz/TipBuzzButton';
import { UserStatBadges, UserStatBadgesV2 } from '../UserStatBadges/UserStatBadges';
import type {
  BadgeCosmetic,
  ProfileBackgroundCosmetic,
  SimpleCosmetic,
} from '~/server/selectors/cosmetic.selector';
import { applyCosmeticThemeColors } from '~/libs/sx-helpers';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { BadgeDisplay, Username } from '../User/Username';
import type { UserPublicSettingsSchema } from '~/server/schema/user.schema';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { EdgeMedia, EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import classes from './CreatorCard.module.css';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function CreatorCard({
  user,
  tipBuzzEntityType,
  tipBuzzEntityId,
  withActions = true,
  tipsEnabled = true,
  subText,
  ...cardProps
}: Props) {
  const { data } = trpc.user.getCreator.useQuery(
    { id: user.id },
    { enabled: user.id !== constants.system.user.id }
  );
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const creator = data || {
    ...user,
    createdAt: null,
    _count: { models: 0 },
    rank: null,
    links: [],
    stats: {
      downloadCountAllTime: 0,
      thumbsUpCountAllTime: 0,
      followerCountAllTime: 0,
    },
  };

  const { models: uploads } = creator?._count ?? { models: 0 };
  const stats = creator?.stats;

  if (!creator || user.id === -1) return null;

  return (
    <Card p="xs" withBorder {...cardProps}>
      <Card.Section>
        <Stack gap="xs" p="xs">
          <Group align="center" justify="space-between">
            <UserAvatar
              size="sm"
              avatarProps={{ size: 32 }}
              user={creator}
              subText={
                subText ??
                (creator.createdAt ? `Joined ${formatDate(creator.createdAt)}` : undefined)
              }
              withUsername
              linkToProfile
            />
            {withActions && (
              <Group gap={8} wrap="nowrap">
                {tipsEnabled && (
                  <TipBuzzButton
                    toUserId={creator.id}
                    entityId={tipBuzzEntityId}
                    label=""
                    entityType={tipBuzzEntityType}
                    size="compact-xs"
                  />
                )}
                <ChatUserButton user={creator} label="" size="compact-xs" />
                <FollowUserButton userId={creator.id} size="compact-xs" />
              </Group>
            )}
          </Group>
          <Group gap={8}>
            <RankBadge size="md" rank={creator.rank} />
            {stats && (
              <UserStatBadges
                uploads={uploads}
                followers={stats.followerCountAllTime}
                favorites={stats.thumbsUpCountAllTime}
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
          style={{
            background: colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
          }}
          py={5}
        >
          <Group gap={4}>
            {sortDomainLinks(creator.links).map((link, index) => (
              <LegacyActionIcon
                key={index}
                component="a"
                href={link.url}
                target="_blank"
                rel="nofollow noreferrer"
                size={32}
              >
                <DomainIcon domain={link.domain} size={20} />
              </LegacyActionIcon>
            ))}
          </Group>
        </Card.Section>
      ) : null}
    </Card>
  );
}

export const CreatorCardV2 = ({
  user,
  tipBuzzEntityType,
  tipBuzzEntityId,
  withActions = true,
  tipsEnabled = true,
  cosmeticOverwrites,
  useEquippedCosmetics = true,
  statDisplayOverwrite,
  subText,
  ...cardProps
}: CreatorCardPropsV2) => {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { data } = trpc.user.getCreator.useQuery(
    { id: user.id },
    { enabled: user.id !== constants.system.user.id }
  );

  const defaultData = {
    ...user,
    createdAt: null,
    _count: { models: 0 },
    rank: null,
    links: [],
    stats: {
      downloadCountAllTime: 0,
      thumbsUpCountAllTime: 0,
      followerCountAllTime: 0,
      reactionCountAllTime: 0,
      generationCountAllTime: 0,
      uploadCountAllTime: 0,
    },
    publicSettings: {
      creatorCardStatsPreferences: [],
    },
  };

  const creator = data || defaultData;

  if (!creator || user.id === -1) return null;

  // Not compatible with multiple badges, but should work fine for our use-case
  const cosmetics = uniqBy(
    [
      ...(cosmeticOverwrites ?? []).map((c) => ({ cosmetic: c, data: {} })),
      ...(useEquippedCosmetics
        ? (creator?.cosmetics ?? []).filter(({ cosmetic }) => !!cosmetic)
        : []),
    ],
    'cosmetic.type'
  );

  const creatorWithCosmetics = {
    ...creator,
    cosmetics,
  };

  const backgroundImage = cosmetics.find(
    ({ cosmetic }) => cosmetic?.type === CosmeticType.ProfileBackground
  )?.cosmetic as Omit<ProfileBackgroundCosmetic, 'description' | 'obtainedAt'> | undefined;
  const isVideo = backgroundImage?.data?.type === 'video';

  const badge = cosmetics.find(({ cosmetic }) => cosmetic?.type === CosmeticType.Badge)?.cosmetic;
  const stats = creator?.stats;
  const displayStats = data
    ? statDisplayOverwrite ??
      ((data.publicSettings ?? {}) as UserPublicSettingsSchema)?.creatorCardStatsPreferences ??
      creatorCardStatsDefaults
    : // Avoid displaying stats until we load the data
      [];
  return (
    <Card p="md" withBorder {...cardProps}>
      <Card.Section style={{ position: 'relative' }}>
        {backgroundImage && backgroundImage.data.url ? (
          <EdgeMedia2
            src={backgroundImage.data.url}
            type={backgroundImage.data.type ?? 'image'}
            // transcode={isVideo}
            anim={true}
            width={450}
            wrapperProps={{
              style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
              },
            }}
            contain
            style={
              isVideo
                ? { height: '100%', objectFit: 'cover' }
                : {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }
            }
          />
        ) : (
          <Image
            src="/images/civitai-default-account-bg.png"
            alt="default creator card background decoration"
            pos="absolute"
            top={0}
            left={0}
            w="100%"
            h="100%"
            styles={{
              root: { objectFit: 'cover', height: '100% !important' },
            }}
          />
        )}
        <Stack p="md">
          <Group justify="space-between" align="flex-start" mih={60} style={{ zIndex: 1 }}>
            <Group>
              <Group gap={4}>
                <RankBadge size="md" rank={creator.rank} />
                {stats && displayStats.length > 0 && (
                  <UserStatBadgesV2
                    uploads={displayStats.includes('uploads') ? stats.uploadCountAllTime : null}
                    followers={
                      displayStats.includes('followers') ? stats.followerCountAllTime : null
                    }
                    favorites={displayStats.includes('likes') ? stats.thumbsUpCountAllTime : null}
                    downloads={
                      displayStats.includes('downloads') ? stats.downloadCountAllTime : null
                    }
                    reactions={
                      displayStats.includes('reactions') ? stats.reactionCountAllTime : null
                    }
                    generations={
                      displayStats.includes('generations') ? stats.generationCountAllTime : null
                    }
                    colorOverrides={backgroundImage?.data}
                  />
                )}
              </Group>
            </Group>
            <BadgeDisplay
              badge={badge ? (badge as BadgeCosmetic) : undefined}
              badgeSize={60}
              zIndex={1}
            />
          </Group>
          <Box className={classes.profileDetailsContainer}>
            <Stack gap="xs" className={classes.profileDetails} py={8} h="100%">
              <Group align="center" justify="space-between" wrap="nowrap">
                <UserProfileLink user={creator} linkToProfile>
                  <Group wrap="nowrap">
                    <Box className={classes.avatar}>
                      <UserAvatar
                        size="lg"
                        avatarProps={{
                          size: 60,
                          style: {
                            minHeight: '100%',
                            objectFit: 'cover',
                          },
                        }}
                        user={creatorWithCosmetics}
                      />
                    </Box>
                    <Stack gap={0} ml={70}>
                      <Username
                        username={creator?.username}
                        deletedAt={creator?.deletedAt}
                        cosmetics={cosmetics ?? []}
                        size="md"
                        badgeSize={0}
                      />
                      {!!subText ? (
                        <>{subText}</>
                      ) : (
                        <>
                          {creator.createdAt && (
                            <Text size="xs" lh={1} lineClamp={1} className="text-white/75">
                              Joined {formatDate(creator.createdAt)}
                            </Text>
                          )}
                        </>
                      )}
                    </Stack>
                  </Group>
                </UserProfileLink>
                {withActions && (
                  <Group gap={8} wrap="nowrap">
                    {tipsEnabled && (
                      <TipBuzzButton
                        toUserId={creator.id}
                        size="xs"
                        entityId={tipBuzzEntityId}
                        label=""
                        entityType={tipBuzzEntityType}
                        radius="xl"
                        color="gray"
                        variant="filled"
                        w={32}
                        h={32}
                      />
                    )}
                    <ChatUserButton
                      user={creator}
                      size="xs"
                      label=""
                      radius="xl"
                      color="gray"
                      variant="filled"
                      w={32}
                      h={32}
                    />
                    <FollowUserButton
                      userId={creator.id}
                      size="xs"
                      radius="xl"
                      variant="filled"
                      h={32}
                    />
                  </Group>
                )}
              </Group>
            </Stack>
          </Box>
        </Stack>
      </Card.Section>
      {creator.links && creator.links.length > 0 ? (
        <Card.Section
          withBorder
          inheritPadding
          style={{
            background: colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
          }}
          py={5}
        >
          <Group gap={4}>
            {sortDomainLinks(creator.links).map((link, index) => (
              <LegacyActionIcon
                key={index}
                component="a"
                href={link.url}
                target="_blank"
                rel="nofollow noreferrer"
                size={32}
              >
                <DomainIcon domain={link.domain} size={20} />
              </LegacyActionIcon>
            ))}
          </Group>
        </Card.Section>
      ) : null}
    </Card>
  );
};

type Props = {
  user: { id: number } & Partial<UserWithCosmetics>;
  tipBuzzEntityId?: number;
  tipBuzzEntityType?: string;
  withActions?: boolean;
  tipsEnabled?: boolean;
  subText?: React.ReactNode;
} & Omit<CardProps, 'children'>;

export type CreatorCardPropsV2 = Props & {
  user: { id: number } & Partial<UserWithCosmetics>;
  tipBuzzEntityId?: number;
  tipBuzzEntityType?: string;
  withActions?: boolean;
  cosmeticOverwrites?: SimpleCosmetic[];
  useEquippedCosmetics?: boolean;
  statDisplayOverwrite?: string[];
} & Omit<CardProps, 'children'>;

export const SmartCreatorCard = (props: CreatorCardPropsV2) => {
  const featureFlags = useFeatureFlags();

  if (featureFlags.cosmeticShop) {
    return <CreatorCardV2 {...props} />;
  }

  return <CreatorCard {...props} />;
};
