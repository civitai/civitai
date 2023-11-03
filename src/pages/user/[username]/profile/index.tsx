import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { trpc } from '~/utils/trpc';
import { Center, Container, Loader, Stack, Text, ThemeIcon, useMantineTheme } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { constants } from '~/server/common/constants';
import { useMemo } from 'react';
import {
  getAllAvailableProfileSections,
  ProfileSectionComponent,
  shouldDisplayUserNullState,
} from '~/components/Profile/profile.utils';
import { ProfileSectionSchema } from '~/server/schema/user-profile.schema';
import { IconCloudOff } from '@tabler/icons-react';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx, features }) => {
    const { username } = userPageQuerySchema.parse(ctx.params);

    if (username) {
      if (!features?.profileOverhaul) {
        return {
          notFound: true,
        };
      } else {
        await ssg?.userProfile.get.prefetch({ username });
        await ssg?.userProfile.overview.prefetch({ username });
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
  const { isLoading: isLoadingOverview, data: userOverview } = trpc.userProfile.overview.useQuery({
    username,
  });

  console.log(userOverview);

  const sections = useMemo(
    () =>
      !user
        ? []
        : getAllAvailableProfileSections(
            user.profile?.profileSectionsSettings as ProfileSectionSchema[]
          ).filter((section) => section.enabled),
    [user]
  );

  if (isLoading || isLoadingOverview) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  if (!user || !user.username || !userOverview) {
    return <NotFound />;
  }

  const { profile } = user;

  const shouldDisplayUserNullStateBool = shouldDisplayUserNullState({
    overview: userOverview,
    userWithProfile: user,
  });

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
                    // 5 / 17 aspect ratio
                    paddingBottom: `${(constants.profile.coverImageAspectRatio * 100).toFixed(3)}%`,
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
              {shouldDisplayUserNullStateBool ? (
                <Stack mt="md">
                  <Stack align="center" py="lg">
                    <ThemeIcon size={128} radius={100}>
                      <IconCloudOff size={80} />
                    </ThemeIcon>
                    <Text size="lg" maw={600} align="center">
                      Whoops! Looks like this user doesn&rsquo;t have any content yet or has chosen
                      not to display anything. Check back later!
                    </Text>
                  </Stack>
                </Stack>
              ) : (
                <Stack mt="md">
                  {sections.map((section) => {
                    const Section = ProfileSectionComponent[section.key];

                    return (
                      <Section
                        key={section.key}
                        // Keep typescript happy.
                        user={{ ...user, username: user.username as string }}
                      />
                    );
                  })}
                </Stack>
              )}
            </Container>
          </Center>
        </SidebarLayout.Content>
      </SidebarLayout.Root>
    </>
  );
}

UserProfileOverview.getLayout = (page: React.ReactElement) => <SidebarLayout>{page}</SidebarLayout>;

export default UserProfileOverview;
