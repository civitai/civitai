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
} from '@mantine/core';
import { ChatUserButton } from '~/components/Chat/ChatUserButton';

import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { UserAvatar, UserProfileLink } from '~/components/UserAvatar/UserAvatar';
import { constants } from '~/server/common/constants';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { formatDate } from '~/utils/date-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { trpc } from '~/utils/trpc';
import { TipBuzzButton } from '../Buzz/TipBuzzButton';
import { UserStatBadges } from '../UserStatBadges/UserStatBadges';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  BadgeCosmetic,
  ProfileBackgroundCosmetic,
  SimpleCosmetic,
} from '~/server/selectors/cosmetic.selector';
import { applyCosmeticThemeColors } from '~/libs/sx-helpers';
import { CosmeticType } from '@prisma/client';
import { isDefined } from '~/utils/type-guards';
import { BadgeDisplay, Username } from '../User/Username';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

const useStyles = createStyles((theme) => ({
  profileDetailsContainer: {
    background: theme.fn.rgba(theme.colors.dark[9], 0.6),
    margin: -theme.spacing.md,
    marginTop: 0,
    minHeight: 50,
    display: 'flex',
    justifyContent: 'center',
    flexDirection: 'column',
    color: theme.white,
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

  const backgroundImage = creator.cosmetics.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'ProfileBackground' : undefined
  )?.cosmetic as Omit<ProfileBackgroundCosmetic, 'description' | 'obtainedAt'>;

  return (
    <Card p="xs" withBorder>
      <Card.Section>
        <BackgroundImage
          sx={{
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right',
            backgroundSize: 'cover',
          }}
          src={
            backgroundImage && backgroundImage.data.url
              ? getEdgeUrl(backgroundImage.data.url, {
                  width: 'original',
                  transcode: false,
                })
              : '/images/civitai-default-account-bg.png'
          }
        >
          <Stack spacing="xs" p="xs">
            <Group align="center" position="apart">
              <UserAvatar
                size="sm"
                avatarProps={{ size: 32 }}
                user={creator}
                subText={creator.createdAt ? `Joined ${formatDate(creator.createdAt)}` : undefined}
                withOverlay={!!backgroundImage}
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
                    styles={
                      backgroundImage ? applyCosmeticThemeColors(backgroundImage.data) : undefined
                    }
                    compact
                  />
                  <ChatUserButton
                    user={creator}
                    size="xs"
                    label=""
                    styles={
                      backgroundImage ? applyCosmeticThemeColors(backgroundImage.data) : undefined
                    }
                    compact
                  />
                  <FollowUserButton
                    userId={creator.id}
                    size="xs"
                    styles={
                      backgroundImage ? applyCosmeticThemeColors(backgroundImage.data) : undefined
                    }
                    compact
                  />
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
                  colorOverrides={backgroundImage?.data}
                />
              )}
            </Group>
          </Stack>
        </BackgroundImage>
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
  fetchUser = true,
  ...cardProps
}: PropsV2) => {
  const { classes, theme } = useStyles();
  const { data } = trpc.user.getCreator.useQuery(
    { id: user.id },
    { enabled: user.id !== constants.system.user.id && fetchUser }
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

  if (!creator || user.id === -1) return null;

  // Not compatible with multiple badges, but should work fine for our use-case
  const cosmetics = uniqBy(
    [
      ...(cosmeticOverwrites ?? []).map((c) => ({ cosmetic: c, data: {} })),
      ...creator?.cosmetics?.filter(({ cosmetic }) => !!cosmetic),
    ],
    'cosmetic.type'
  );

  const creatorWithCosmetics = {
    ...creator,
    cosmetics,
  };

  const backgroundImage = cosmetics.find(
    ({ cosmetic }) => cosmetic?.type === CosmeticType.ProfileBackground
  )?.cosmetic as Omit<ProfileBackgroundCosmetic, 'description' | 'obtainedAt'>;

  const badge = cosmetics.find(({ cosmetic }) => cosmetic?.type === CosmeticType.Badge)?.cosmetic;

  return (
    <Card p="md" withBorder {...cardProps}>
      <Card.Section>
        <BackgroundImage
          sx={{
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right bottom',
            backgroundSize: 'cover',
            backgroundColor: theme.colors[theme.primaryColor][theme.fn.primaryShade()],
            padding: theme.spacing.md,
          }}
          src={
            backgroundImage && backgroundImage.data.url
              ? getEdgeUrl(backgroundImage.data.url, {
                  width: 'original',
                  transcode: false,
                })
              : '/images/civitai-default-account-bg.png'
          }
        >
          <Stack>
            <Group position="apart" align="flex-start" mih={60}>
              <Group>
                <Group spacing={8}>
                  <RankBadge size="md" rank={creator.rank} />
                </Group>
              </Group>
              <BadgeDisplay badge={badge ? (badge as BadgeCosmetic) : undefined} badgeSize={60} />
            </Group>
            <Box className={classes.profileDetailsContainer}>
              <Stack spacing="xs" className={classes.profileDetails} py={8} h="100%">
                <Group align="center" position="apart">
                  <UserProfileLink user={creator} linkToProfile>
                    <Group>
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
                        {creator.createdAt && (
                          <Text size="xs" lh={1} lineClamp={1} color="dimmed">
                            Joined {formatDate(creator.createdAt)}
                          </Text>
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
        </BackgroundImage>
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
  user: UserWithCosmetics;
  tipBuzzEntityId?: number;
  tipBuzzEntityType?: string;
  withActions?: boolean;
};

type PropsV2 = {
  user: UserWithCosmetics;
  tipBuzzEntityId?: number;
  tipBuzzEntityType?: string;
  withActions?: boolean;
  cosmeticOverwrites?: SimpleCosmetic[];
  fetchUser?: boolean;
} & Omit<CardProps, 'children'>;
