import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { trpc } from '~/utils/trpc';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getInitials } from '~/utils/string-helpers';
import {
  ActionIcon,
  AspectRatio,
  Avatar,
  Center,
  Container,
  Divider,
  Group,
  Indicator,
  Loader,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { IconInfoCircle, IconMapPin, IconRss } from '@tabler/icons-react';
import { sortDomainLinks } from '~/utils/domain-link';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { UserStats } from '~/components/Profile/UserStats';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useMemo } from 'react';
import { formatDate } from '~/utils/date-helpers';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';
import { Carousel } from '@mantine/carousel';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { ImageSort } from '~/server/common/enums';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { Reactions } from '~/components/Reaction/Reactions';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { PopularModelsSection } from '~/components/Profile/Sections/PopularModelsSection';

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
  const theme = useMantineTheme();
  const { isLoading, data: user } = trpc.userProfile.get.useQuery({
    username,
  });

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

  const { profile } = user;

  console.log(profile);

  return (
    <>
      <SidebarLayout.Root>
        <SidebarLayout.Sidebar>
          <ProfileSidebar username={username} />
        </SidebarLayout.Sidebar>
        <SidebarLayout.Content>
          <Center>
            <Container size="xl" w="100%">
              {profile?.coverImage && (
                <div
                  style={{
                    position: 'relative',
                    width: '100%',
                    overflow: 'hidden',
                    height: 0,
                    paddingBottom: '29.412%',
                    background: 'red',
                    borderRadius: theme.radius.md,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <ImageGuard
                    images={[profile.coverImage]}
                    connect={{ entityId: profile.coverImage.id, entityType: 'user' }}
                    render={(image) => {
                      return (
                        <ImageGuard.Content>
                          {({ safe }) => (
                            <div style={{ width: '100%' }}>
                              <ImageGuard.ToggleConnect position="top-left" />
                              <ImageGuard.Report />

                              {!safe ? (
                                <MediaHash {...image} />
                              ) : (
                                <ImagePreview
                                  image={image}
                                  edgeImageProps={{ width: 816 }}
                                  radius="md"
                                  style={{ width: '100%' }}
                                />
                              )}
                            </div>
                          )}
                        </ImageGuard.Content>
                      );
                    }}
                  />
                </div>
              )}
              <Stack mt="md">
                <PopularModelsSection user={user} />
              </Stack>
            </Container>
          </Center>
        </SidebarLayout.Content>
      </SidebarLayout.Root>
    </>
  );
}

UserProfileOverview.getLayout = (page: React.ReactElement) => <SidebarLayout>{page}</SidebarLayout>;

export default UserProfileOverview;
