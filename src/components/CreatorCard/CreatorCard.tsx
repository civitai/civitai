import { uniqBy } from 'lodash-es';
import {
  ActionIcon,
  BackgroundImage,
  Box,
  Card,
  Group,
  Stack,
  Text,
  CardProps,
  Image,
  BoxProps,
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
import {
  BadgeCosmetic,
  ProfileBackgroundCosmetic,
  SimpleCosmetic,
} from '~/server/selectors/cosmetic.selector';
import { applyCosmeticThemeColors } from '~/libs/sx-helpers';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { BadgeDisplay, Username } from '../User/Username';
import { UserPublicSettingsSchema } from '~/server/schema/user.schema';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { EdgeMedia, EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import classes from './CreatorCard.module.scss';
import React, { forwardRef } from 'react';
import styles from './CreatorCard.module.scss';

export interface CreatorCardProps extends BoxProps {
  hasBackground?: boolean;
  hasVideo?: boolean;
  hasDefaultBackground?: boolean;
}

export const CreatorCard = forwardRef<HTMLDivElement, CreatorCardProps>((props, ref) => {
  const { hasBackground, hasVideo, hasDefaultBackground, className, ...others } = props;

  return (
    <Box
      className={`${styles.cardSection} ${hasBackground ? styles.backgroundImage : ''} ${
        hasVideo ? styles.backgroundImageVideo : ''
      } ${hasDefaultBackground ? styles.defaultBackground : ''} ${className}`}
      {...others}
      ref={ref}
    />
  );
});

CreatorCard.displayName = 'CreatorCard';

export function CreatorCardV2({
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
}: CreatorCardPropsV2) {
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
      <Card.Section className={classes.cardSection}>
        {backgroundImage && backgroundImage.data.url ? (
          <EdgeMedia2
            src={backgroundImage.data.url}
            type={backgroundImage.data.type ?? 'image'}
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
            className={isVideo ? classes.backgroundImageVideo : classes.backgroundImage}
          />
        ) : (
          <Image
            src="/images/civitai-default-account-bg.png"
            alt="default creator card background decoration"
            className={classes.defaultBackground}
          />
        )}
        <Stack p="md">
          <Group position="apart" align="flex-start" mih={60} style={{ zIndex: 1 }}>
            <Group>
              <Group spacing={4}>
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
                            <Text size="xs" lh={1} lineClamp={1} className={classes.joinedText}>
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
        <Card.Section withBorder inheritPadding className={classes.linksSection} py={5}>
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


