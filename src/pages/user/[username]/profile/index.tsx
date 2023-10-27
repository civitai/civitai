import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { trpc } from '~/utils/trpc';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getInitials } from '~/utils/string-helpers';
import {
  ActionIcon,
  Avatar,
  Center,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { IconMapPin, IconRss } from '@tabler/icons-react';
import { sortDomainLinks } from '~/utils/domain-link';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { UserStats } from '~/components/Profile/UserStats';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useMemo } from 'react';
import { formatDate } from '~/utils/date-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx, features }) => {
    const { username } = userPageQuerySchema.parse(ctx.params);

    console.log(features);

    if (username) {
      if (!features?.profileOverhaul) {
        return {
          notFound: true,
        };
      } else {
        await ssg?.userProfile.get.prefetch({ username });
      }
    }

    if (!username) {
      return {
        notFound: true,
      };
    }

    return {
      props: {
        username,
      },
    };
  },
});

export function UserProfileOverview({ username }: { username: string }) {
  const currentUser = useCurrentUser();

  const { isLoading, data: user } = trpc.userProfile.get.useQuery({
    username,
  });

  const awards = useMemo(
    () =>
      !user
        ? []
        : user.cosmetics
            .map((c) => c.cosmetic)
            .filter((c) => c.type === 'Badge' && !!c.data)
            .slice(0, 4),
    [user]
  );

  if (isLoading) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  if (!user) {
    return <NotFound />;
  }

  const { profile, stats } = user;

  return (
    <>
      <SidebarLayout.Root>
        <SidebarLayout.Sidebar>
          <Stack>
            <Avatar
              src={
                user.image
                  ? getEdgeUrl(user.image, {
                      width: 88,
                      anim: currentUser
                        ? !currentUser.autoplayGifs
                          ? false
                          : undefined
                        : undefined,
                    })
                  : undefined
              }
              alt={`${user.username}'s Avatar` ?? undefined}
              radius="md"
              size={88}
              imageProps={{ loading: 'lazy' }}
              sx={{ backgroundColor: 'rgba(0,0,0,0.31)' }}
            >
              {user.username ? getInitials(user.username) : null}
            </Avatar>
            <RankBadge rank={user.rank} size="lg" withTitle />
            <Stack spacing={0}>
              <Text weight={700} size={24}>
                {user.username}
              </Text>
              <Group spacing="sm">
                <Text color="dimmed">Santiago, RD - TODO</Text>
                <IconMapPin size={16} />
              </Group>
            </Stack>
            {profile?.bio && <ContentClamp maxHeight={48}>{profile.bio}</ContentClamp>}
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
              <FollowUserButton
                userId={user.id}
                leftIcon={<IconRss size={16} />}
                size="md"
                sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
              />
            </Group>

            <Divider my="sm" />

            {stats && (
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

            <Divider my="sm" />

            {awards.length > 0 && (
              <Stack>
                <Text size="md" color="dimmed" weight={590}>
                  Awards
                </Text>
                <Group spacing="xs">
                  {awards.map((award) => {
                    const data = (award.data ?? {}) as { url?: string };
                    const url = (data.url ?? '') as string;

                    if (!url) {
                      return null;
                    }

                    return (
                      <Tooltip key={award.id} label={award.name} withinPortal>
                        <EdgeMedia src={url} width={56} />
                      </Tooltip>
                    );
                  })}
                </Group>
                <Divider my="sm" />
              </Stack>
            )}

            <Text color="dimmed">Joined {formatDate(user.createdAt)}</Text>
          </Stack>
        </SidebarLayout.Sidebar>
        <SidebarLayout.Content>My profiles</SidebarLayout.Content>
      </SidebarLayout.Root>
    </>
  );
}

UserProfileOverview.getLayout = (page: React.ReactElement) => <SidebarLayout>{page}</SidebarLayout>;

export default UserProfileOverview;
