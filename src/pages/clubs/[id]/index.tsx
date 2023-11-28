import React, { useMemo } from 'react';
import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { Anchor, Button, Container, Grid, Group, Stack, Text, Title } from '@mantine/core';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { constants } from '~/server/common/constants';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import {
  IconAlertCircle,
  IconManualGearbox,
  IconPencilMinus,
  IconSettings,
} from '@tabler/icons-react';
import { ClubManagementNavigation } from '~/components/Club/ClubManagementNavigation';
import { ClubFeedNavigation } from '~/components/Club/ClubFeedNavigation';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const Feed = () => {
  return <div>Feed</div>;
};

export const FeedLayout = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const { data: club, isLoading: loading } = trpc.club.getById.useQuery({ id });
  const { data: userClubs = [], isLoading: isLoadingUserClubs } =
    trpc.club.userContributingClubs.useQuery();
  const currentUser = useCurrentUser();

  const canPost = useMemo(() => {
    return userClubs.some((c) => c.id === id);
  }, [userClubs]);

  const isOwner = currentUser && club?.userId === currentUser?.id;

  // const { data: tiers = [], isLoading: isLoadingTiers } = trpc.club.getTiers.useQuery(
  //   {
  //     clubId: club?.id as number,
  //     listedOnly: true,
  //     joinableOnly: true,
  //   },
  //   {
  //     enabled: !!club?.id,
  //   }
  // );

  if (loading) {
    return <PageLoader />;
  }

  if (!club) {
    return <NotFound />;
  }

  return (
    <AppLayout>
      <Container fluid p={0}>
        {club.headerImage && (
          <ImageCSSAspectRatioWrap
            aspectRatio={constants.clubs.headerImageAspectRatio}
            style={{ borderRadius: 0 }}
          >
            <ImageGuard
              images={[club.headerImage]}
              connect={{ entityId: club.headerImage.id, entityType: 'club' }}
              render={(image) => {
                return (
                  <ImageGuard.Content>
                    {({ safe }) => (
                      <>
                        {!safe ? (
                          <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                        ) : (
                          <ImagePreview
                            image={image}
                            edgeImageProps={{ width: 1200 }}
                            style={{ width: '100%', height: '100%' }}
                            aspectRatio={0}
                          />
                        )}
                        <div style={{ width: '100%', height: '100%' }}>
                          <ImageGuard.ToggleConnect position="top-left" />
                          <ImageGuard.Report withinPortal />
                        </div>
                      </>
                    )}
                  </ImageGuard.Content>
                );
              }}
            />
          </ImageCSSAspectRatioWrap>
        )}
        <Container
          size="xl"
          style={{
            position: 'relative',
            top: club.headerImage ? -constants.clubs.avatarDisplayWidth / 2 : undefined,
          }}
        >
          <Stack spacing="md">
            <Stack spacing="lg">
              {club.avatar && (
                <ImageCSSAspectRatioWrap
                  aspectRatio={1}
                  style={{ width: constants.clubs.avatarDisplayWidth }}
                >
                  <ImageGuard
                    images={[club.avatar]}
                    connect={{ entityId: club.avatar.id, entityType: 'club' }}
                    render={(image) => {
                      return (
                        <ImageGuard.Content>
                          {({ safe }) => (
                            <>
                              {!safe ? (
                                <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                              ) : (
                                <ImagePreview
                                  image={image}
                                  edgeImageProps={{ width: 450 }}
                                  radius="md"
                                  style={{ width: '100%', height: '100%' }}
                                  aspectRatio={0}
                                />
                              )}
                              <div style={{ width: '100%', height: '100%' }}>
                                <ImageGuard.ToggleConnect position="top-left" />
                                <ImageGuard.Report withinPortal />
                              </div>
                            </>
                          )}
                        </ImageGuard.Content>
                      );
                    }}
                  />
                </ImageCSSAspectRatioWrap>
              )}
              <Title order={1}>{club.name}</Title>
              {club.description && (
                <ContentClamp maxHeight={145}>
                  <RenderHtml html={club.description} />
                </ContentClamp>
              )}
              {(canPost || isOwner) && (
                <Group>
                  {canPost && (
                    <Button
                      component={'a'}
                      href={`/clubs/${club.id}/post`}
                      leftIcon={<IconPencilMinus />}
                    >
                      Post content
                    </Button>
                  )}
                  {isOwner && (
                    <Button
                      component={'a'}
                      href={`/clubs/manage/${club.id}`}
                      leftIcon={<IconSettings />}
                      color="gray"
                    >
                      Manage
                    </Button>
                  )}
                </Group>
              )}
              <ClubFeedNavigation id={club.id} />
            </Stack>
            <Grid>
              <Grid.Col xs={12} md={10}>
                {children}
              </Grid.Col>
              <Grid.Col xs={12} md={2}>
                <ClubManagementNavigation id={id} />
              </Grid.Col>
            </Grid>
          </Stack>
        </Container>
      </Container>
    </AppLayout>
  );
};

Feed.getLayout = function getLayout(page: React.ReactNode) {
  return <FeedLayout>{page}</FeedLayout>;
};

export default Feed;
