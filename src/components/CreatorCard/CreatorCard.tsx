import { ActionIcon, BackgroundImage, Card, Group, Stack } from '@mantine/core';
import { ChatUserButton } from '~/components/Chat/ChatUserButton';

import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { constants } from '~/server/common/constants';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { formatDate } from '~/utils/date-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { trpc } from '~/utils/trpc';
import { TipBuzzButton } from '../Buzz/TipBuzzButton';
import { UserStatBadges } from '../UserStatBadges/UserStatBadges';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ProfileBackgroundCosmetic } from '~/server/selectors/cosmetic.selector';

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

  const hasBackgroundImage = backgroundImage && backgroundImage.data.url;

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
              : ''
          }
        >
          <Stack spacing="xs" p="xs">
            <Group align="center" position="apart">
              <UserAvatar
                size="sm"
                avatarProps={{ size: 32 }}
                user={creator}
                subText={creator.createdAt ? `Joined ${formatDate(creator.createdAt)}` : undefined}
                withUsername
                linkToProfile
              />
              {withActions && (
                <Group spacing={8} noWrap>
                  <TipBuzzButton
                    toUserId={creator.id}
                    size="xs"
                    entityId={tipBuzzEntityId}
                    entityType={tipBuzzEntityType}
                    styles={
                      hasBackgroundImage
                        ? (theme) => ({
                            root: {
                              backgroundColor: theme.fn.rgba('#000', 0.31),
                            },
                          })
                        : undefined
                    }
                    compact
                  />
                  <ChatUserButton
                    user={creator}
                    size="xs"
                    styles={
                      hasBackgroundImage
                        ? (theme) => ({
                            root: {
                              backgroundColor: theme.fn.rgba('#000', 0.31),
                            },
                          })
                        : undefined
                    }
                    compact
                  />
                  <FollowUserButton
                    userId={creator.id}
                    size="xs"
                    styles={
                      hasBackgroundImage
                        ? (theme) => ({
                            root: {
                              backgroundColor: theme.fn.rgba('#000', 0.31),
                            },
                          })
                        : undefined
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

type Props = {
  user: UserWithCosmetics;
  tipBuzzEntityId?: number;
  tipBuzzEntityType?: string;
  withActions?: boolean;
};
