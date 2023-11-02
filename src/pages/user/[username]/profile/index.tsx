import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { trpc } from '~/utils/trpc';
import { Center, Container, Loader, Stack, useMantineTheme } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { PopularModelsSection } from '~/components/Profile/Sections/PopularModelsSection';
import { PopularArticlesSection } from '~/components/Profile/Sections/PopularArticlesSection';
import { MyModelsSection } from '~/components/Profile/Sections/MyModelsSection';
import { MyImagesSection } from '~/components/Profile/Sections/MyImagesSection';
import { RecentReviewsSection } from '~/components/Profile/Sections/RecentReviewsSection';
import { constants } from '~/server/common/constants';

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

  if (!user || !user.username) {
    return <NotFound />;
  }

  const { profile } = user;

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
              <Stack mt="md">
                <PopularModelsSection user={{ id: user.id, username }} />
                <PopularArticlesSection user={{ id: user.id, username }} />
                <MyModelsSection user={{ id: user.id, username }} />
                <MyImagesSection user={{ id: user.id, username }} />
                <RecentReviewsSection user={{ id: user.id, username }} />
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
