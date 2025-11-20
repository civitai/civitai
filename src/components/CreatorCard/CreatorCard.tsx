import type { CardProps } from '@mantine/core';
import { Card, Group, Stack, useMantineTheme, useComputedColorScheme } from '@mantine/core';
import { ChatUserButton } from '~/components/Chat/ChatUserButton';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { constants } from '~/server/common/constants';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { formatDate } from '~/utils/date-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { trpc } from '~/utils/trpc';
import { TipBuzzButton } from '../Buzz/TipBuzzButton';
import { UserStatBadges } from '../UserStatBadges/UserStatBadges';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { CreatorCardSimpleProps } from '~/components/CreatorCard/CreatorCardSimple';
import { CreatorCardSimple } from '~/components/CreatorCard/CreatorCardSimple';

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

  ...cardProps
}: CreatorCardPropsV2) => {
  return (
    <CreatorCardSimple
      {...cardProps}
      user={user}
      actions={
        withActions
          ? (creator) => (
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
            )
          : undefined
      }
    />
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

export type CreatorCardPropsV2 = Omit<CreatorCardSimpleProps, 'actions'> & {
  tipBuzzEntityId?: number;
  tipBuzzEntityType?: string;
  withActions?: boolean;
  tipsEnabled?: boolean;
  subText?: React.ReactNode;
} & Omit<CardProps, 'children'>;

export const SmartCreatorCard = (props: CreatorCardPropsV2) => {
  const featureFlags = useFeatureFlags();

  if (featureFlags.cosmeticShop) {
    return <CreatorCardV2 {...props} />;
  }

  return <CreatorCard {...props} />;
};
