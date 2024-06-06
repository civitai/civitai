import { uniqBy } from 'lodash-es';
import {
  ActionIcon,
  BackgroundImage,
  Box,
  Card,
  Group,
  Stack,
  createStyles,
  Text,
  CardProps,
  Image,
} from '@mantine/core';
import { ChatUserButton } from '~/components/Chat/ChatUserButton';

import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { UserAvatar, UserProfileLink } from '~/components/UserAvatar/UserAvatar';
import { constants, creatorCardStats, creatorCardStatsDefaults } from '~/server/common/constants';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { formatDate } from '~/utils/date-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { trpc } from '~/utils/trpc';
import { TipBuzzButton } from '../Buzz/TipBuzzButton';
import { UserStatBadges, UserStatBadgesV2 } from '../UserStatBadges/UserStatBadges';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  BadgeCosmetic,
  ProfileBackgroundCosmetic,
  SimpleCosmetic,
} from '~/server/selectors/cosmetic.selector';
import { applyCosmeticThemeColors } from '~/libs/sx-helpers';
import { CosmeticType } from '@prisma/client';
import { BadgeDisplay, Username } from '../User/Username';
import { UserPublicSettingsSchema } from '~/server/schema/user.schema';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

const useStyles = createStyles((theme) => ({
  profileDetailsContainer: {
    background: theme.fn.rgba(theme.colors.dark[9], 0.8),
    margin: -theme.spacing.md,
    marginTop: 0,
    minHeight: 50,
    display: 'flex',
    justifyContent: 'center',
    flexDirection: 'column',
    color: theme.white,
    zIndex: 10,
  },

  profileDetails: {
    padding: theme.spacing.md,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.xs,
    position: 'relative',
  },
  avatar: {
    position: 'absolute',
    bottom: 4,
    overflow: 'visible',
  },
}));

export function CreatorCard({
  user,
  tipBuzzEntityType,
  tipBuzzEntityId,
  withActions = true,
  subText,
  ...cardProps
}: Props) {
  const { data } = trpc.user.getCreator.useQuery(
    { id: user.id },
    { enabled: user.id !== constants.system.user.id }
  );

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
        <Stack spacing="xs" p="xs">
          <Group align="center" position="apart">
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
              <Group spacing={8} noWrap>
                <TipBuzzButton
                  toUserId={creator.id}
                  size="xs"
                  entityId={tipBuzzEntityId}
                  label=""
                  entityType={tipBuzzEntityType}
                  compact
                />
                <ChatUserButton user={creator} size="xs" label="" compact />
                <FollowUserButton userId={creator.id} size="xs" compact />
              </Group>
            )}
          </Group>
          <Group spacing={8}>
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
                rel="nofollow noreferrer"
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

export const CreatorCardV2 = ({
  user,
  tipBuzzEntityType,
  tipBuzzEntityId,
  withActions = true,
  cosmeticOverwrites,
  useEquippedCosmetics = true,
  startDisplayOverwrite,
  subText,
  ...cardProps
}: PropsV2) => {
  const { classes, theme } = useStyles();
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
  const { models: uploads } = creator?._count ?? { models: 0 };
  const displayStats = data
    ? startDisplayOverwrite ??
      ((data.publicSettings ?? {}) as UserPublicSettingsSchema)?.creatorCardStatsPreferences ??
      creatorCardStatsDefaults
    : // Avoid displaying stats until we load the data
      [];
  return (
    <Card p="md" withBorder {...cardProps}>
      <Card.Section style={{ position: 'relative' }}>
        {backgroundImage && backgroundImage.data.url ? (
          <EdgeMedia
            src={backgroundImage.data.url}
            type={backgroundImage.data.type ?? 'image'}
            transcode={isVideo}
            anim={true}
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
              figure: { height: '100%' },
              imageWrapper: { height: '100%' },
              image: { objectFit: 'cover', height: '100% !important' },
            }}
          />
        )}
        <Stack p="md">
          <Group position="apart" align="flex-start" mih={60} style={{ zIndex: 1 }}>
            <Group>
              <Group spacing={4}>
                <RankBadge size="md" rank={creator.rank} />
                {stats && displayStats.length > 0 && (
                  <UserStatBadgesV2
                    uploads={displayStats.includes('uploads') ? uploads : null}
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
            <Stack spacing="xs" className={classes.profileDetails} py={8} h="100%">
              <Group align="center" position="apart" noWrap>
                <UserProfileLink user={creator} linkToProfile>
                  <Group noWrap>
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
                    <Stack spacing={0} ml={70}>
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
                            <Text
                              size="xs"
                              lh={1}
                              lineClamp={1}
                              style={{ color: theme.fn.rgba(theme.white, 0.75) }}
                            >
                              Joined {formatDate(creator.createdAt)}
                            </Text>
                          )}
                        </>
                      )}
                    </Stack>
                  </Group>
                </UserProfileLink>
                {withActions && (
                  <Group spacing={8} noWrap>
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
                rel="nofollow noreferrer"
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
};

type Props = {
  user: { id: number } & Partial<UserWithCosmetics>;
  tipBuzzEntityId?: number;
  tipBuzzEntityType?: string;
  withActions?: boolean;
  subText?: React.ReactNode;
} & Omit<CardProps, 'children'>;

type PropsV2 = Props & {
  user: { id: number } & Partial<UserWithCosmetics>;
  tipBuzzEntityId?: number;
  tipBuzzEntityType?: string;
  withActions?: boolean;
  cosmeticOverwrites?: SimpleCosmetic[];
  useEquippedCosmetics?: boolean;
  startDisplayOverwrite?: string[];
} & Omit<CardProps, 'children'>;

export const SmartCreatorCard = (props: PropsV2) => {
  const featureFlags = useFeatureFlags();

  if (featureFlags.cosmeticShop) {
    return <CreatorCardV2 {...props} />;
  }

  return <CreatorCard {...props} />;
};
