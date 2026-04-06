import { uniqBy } from 'lodash-es';
import type { CardProps } from '@mantine/core';
import {
  Box,
  Card,
  Group,
  Stack,
  Text,
  Image,
  useMantineTheme,
  useComputedColorScheme,
} from '@mantine/core';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { UserAvatar, UserProfileLink } from '~/components/UserAvatar/UserAvatar';
import { constants, creatorCardStatsDefaults } from '~/server/common/constants';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { formatDate } from '~/utils/date-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { trpc } from '~/utils/trpc';
import { UserStatBadgesV2 } from '../UserStatBadges/UserStatBadges';
import type {
  BadgeCosmetic,
  ProfileBackgroundCosmetic,
  SimpleCosmetic,
} from '~/server/selectors/cosmetic.selector';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { BadgeDisplay, Username } from '../User/Username';
import type { UserPublicSettingsSchema } from '~/server/schema/user.schema';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { MetricSubscriptionProvider, useLiveMetrics } from '~/components/Metrics';
import classes from './CreatorCard.module.css';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { UserCreator } from '~/server/services/user.service';

export const CreatorCardSimple = (props: CreatorCardSimpleProps) => (
  <MetricSubscriptionProvider entityType="User" entityId={props.user.id}>
    <CreatorCardSimpleContent {...props} />
  </MetricSubscriptionProvider>
);

const CreatorCardSimpleContent = ({
  user,
  cosmeticOverwrites,
  useEquippedCosmetics = true,
  statDisplayOverwrite,
  subText,
  actions,
  ...cardProps
}: CreatorCardSimpleProps) => {
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
  } as unknown as UserCreator;

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

  // Live metrics for user stats
  const liveStats = useLiveMetrics('User', user.id, {
    uploadCount: stats?.uploadCountAllTime ?? 0,
    followerCount: stats?.followerCountAllTime ?? 0,
    thumbsUpCount: stats?.thumbsUpCountAllTime ?? 0,
    downloadCount: stats?.downloadCountAllTime ?? 0,
    reactionCount: stats?.reactionCountAllTime ?? 0,
    generationCount: stats?.generationCountAllTime ?? 0,
  });

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
                    uploads={displayStats.includes('uploads') ? liveStats.uploadCount : null}
                    followers={displayStats.includes('followers') ? liveStats.followerCount : null}
                    favorites={displayStats.includes('likes') ? liveStats.thumbsUpCount : null}
                    downloads={displayStats.includes('downloads') ? liveStats.downloadCount : null}
                    reactions={displayStats.includes('reactions') ? liveStats.reactionCount : null}
                    generations={
                      displayStats.includes('generations') ? liveStats.generationCount : null
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
                {actions ? actions(creator) : null}
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

export type CreatorCardSimpleProps = {
  user: { id: number } & Partial<UserWithCosmetics>;
  subText?: React.ReactNode;
  cosmeticOverwrites?: SimpleCosmetic[];
  useEquippedCosmetics?: boolean;
  statDisplayOverwrite?: string[];
  actions?: (creator: UserCreator) => React.ReactElement;
} & Omit<CardProps, 'children'>;
