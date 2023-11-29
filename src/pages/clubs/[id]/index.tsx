import React, { useMemo } from 'react';
import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import {
  Anchor,
  Button,
  Center,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  LoadingOverlay,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { constants } from '~/server/common/constants';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import {
  IconAlertCircle,
  IconClock,
  IconClubs,
  IconManualGearbox,
  IconPencilMinus,
  IconSettings,
} from '@tabler/icons-react';
import { ClubManagementNavigation } from '~/components/Club/ClubManagementNavigation';
import { ClubFeedNavigation } from '~/components/Club/ClubFeedNavigation';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useQueryClubPosts } from '~/components/Club/club.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { ClubPostUpsertForm } from '~/components/Club/ClubPostUpsertForm';
import { useClubFeedStyles } from '~/components/Club/ClubFeed';

const Feed = () => {
  const utils = trpc.useContext();
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const { clubPosts, isLoading, fetchNextPage, hasNextPage, isRefetching } = useQueryClubPosts(id);
  const { data: userClubs = [], isLoading: isLoadingUserClubs } =
    trpc.club.userContributingClubs.useQuery();
  const currentUser = useCurrentUser();
  const { classes } = useClubFeedStyles();

  const canPost = useMemo(() => {
    return userClubs.some((c) => c.id === id);
  }, [userClubs]);

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!clubPosts.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isRefetching}
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" sx={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
          {!hasNextPage && <EndOfFeed />}
        </div>
      ) : (
        <Stack mt="xl">
          <Divider
            size="sm"
            label={
              <Group spacing={4}>
                <IconClubs size={16} stroke={1.5} />
                Looks like this club has not posted anything yet
              </Group>
            }
            labelPosition="center"
            labelProps={{ size: 'sm' }}
          />
          <Center>
            <Stack spacing={0} align="center">
              <Text size="sm" color="dimmed">
                Check back later and the owner might have posted something
              </Text>
            </Stack>
          </Center>
        </Stack>
      )}
      {canPost && (
        <>
          <Divider
            size="sm"
            labelProps={{ size: 'sm' }}
            label="Create a new post"
            labelPosition="center"
            my="md"
          />
          <Paper className={classes.feedContainer}>
            <ClubPostUpsertForm
              clubId={id}
              onSuccess={() => {
                utils.club.getInfiniteClubPosts.invalidate({ clubId: id });
              }}
            />
          </Paper>
        </>
      )}
    </>
  );
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
          <Stack spacing="md" mt="md">
            <Grid>
              <Grid.Col xs={12} md={10}>
                <Stack spacing="lg">
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
