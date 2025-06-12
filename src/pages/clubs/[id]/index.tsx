import React from 'react';
import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import {
  Button,
  Center,
  Container,
  // createStyles,
  Divider,
  Grid,
  Group,
  Loader,
  LoadingOverlay,
  Stack,
  Text,
  Title,
  useStyles,
} from '@mantine/core';
import { constants } from '~/server/common/constants';
import { IconClock, IconClubs, IconPlus, IconSettings } from '@tabler/icons-react';
import { ClubFeedNavigation } from '~/components/Club/ClubFeedNavigation';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { useClubContributorStatus, useQueryClubPosts } from '~/components/Club/club.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ClubPostItem } from '~/components/Club/ClubPost/ClubFeed';
import { ClubMembershipStatus, ClubTierItem } from '~/components/Club/ClubTierItem';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { ClubAddContent } from '~/components/Club/ClubAddContent';
import { Meta } from '../../../components/Meta/Meta';
import { createServerSideProps } from '../../../server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.clubs) return { notFound: true };

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: false,
    //   },
    // };
  },
});

const Feed = () => {
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const { clubPosts, isLoading, fetchNextPage, hasNextPage, isRefetching } = useQueryClubPosts(id);
  const { data: club, isLoading: isLoadingClub } = trpc.club.getById.useQuery({ id });

  return (
    <>
      {isLoading || isLoadingClub ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!clubPosts.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <Stack gap="md" mt="md" align="center">
            {clubPosts.map((clubPost) => (
              <ClubPostItem key={clubPost.id} clubPost={clubPost} />
            ))}
          </Stack>
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isRefetching}
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" style={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
          {!hasNextPage && (
            <Stack mt="xl">
              <Divider
                size="sm"
                label={
                  <Group gap={4}>
                    <IconClock size={16} stroke={1.5} />
                    You are all caught up
                  </Group>
                }
                labelPosition="center"
              />
              <Text c="dimmed" align="center" size="sm">
                Looks like you&rsquo;re all caught up for now. Come back later and the owner might
                have added more stuff
              </Text>
            </Stack>
          )}
        </div>
      ) : (
        <Stack mt="xl">
          {(club?.stats?.clubPostCountAllTime ?? 0) > 0 ? (
            <Stack>
              <Divider
                size="sm"
                label={
                  <Group gap={4}>
                    <IconClubs size={16} stroke={1.5} />
                    This club has a total of {club?.stats?.clubPostCountAllTime} posts.
                  </Group>
                }
                labelPosition="center"
              />
              <Center>
                <Stack gap={0} align="center">
                  <Text size="sm" c="dimmed">
                    If you cannot see posts, it means you are not a member of this club or your
                    settings are hiding some of these posts.
                  </Text>
                </Stack>
              </Center>
            </Stack>
          ) : (
            <Stack>
              <Divider
                size="sm"
                label={
                  <Group gap={4}>
                    <IconClubs size={16} stroke={1.5} />
                    Looks like this club has not posted anything yet
                  </Group>
                }
                labelPosition="center"
              />
              <Center>
                <Stack gap={0} align="center">
                  <Text size="sm" c="dimmed">
                    Check back later and the owner might have posted something
                  </Text>
                </Stack>
              </Center>
            </Stack>
          )}
        </Stack>
      )}
    </>
  );
};

// const useStyles = createStyles<string, { hasHeaderImage: boolean }>(
//   (theme, { hasHeaderImage }) => ({
//     mainContainer: {
//       position: 'relative',
//       top: hasHeaderImage ? -constants.clubs.avatarDisplayWidth / 2 : undefined,

//       [containerQuery.smallerThan('sm')]: {
//         top: hasHeaderImage ? -constants.clubs.avatarDisplayWidth / 4 : undefined,
//       },
//     },

//     avatar: {
//       width: constants.clubs.avatarDisplayWidth,

//       [containerQuery.smallerThan('sm')]: {
//         margin: 'auto',
//       },
//     },
//   })
// );

export const FeedLayout = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const { data: club, isLoading: loading } = trpc.club.getById.useQuery({ id });
  const { isOwner, isModerator, isClubAdmin } = useClubContributorStatus({
    clubId: id,
  });

  // const { classes } = useStyles({ hasHeaderImage: !!club?.headerImage });
  const canPost = isOwner || isModerator || isClubAdmin;

  const { data: tiers = [] } = trpc.club.getTiers.useQuery(
    {
      clubId: club?.id as number,
      listedOnly: true,
      joinableOnly: true,
    },
    { enabled: !!club?.id }
  );

  if (loading) {
    return <PageLoader />;
  }

  if (!club) {
    return <NotFound />;
  }

  return (
    <AppLayout>
      {club && (
        <Meta
          title={`${club.name} - Club hosted by ${club.user.username}`}
          description={club.description ?? undefined}
        />
      )}
      <Container fluid p={0} mt={club.headerImage ? '-md' : ''}>
        {/* {club.headerImage && (
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
                            edgeImageProps={{ width: 1600 }}
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
        )} */}
        <Container size="xl">
          {/* {club.avatar && (
            <ImageCSSAspectRatioWrap aspectRatio={1} className={classes.avatar}>
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
          )} */}
          <Stack gap="md" mt="md">
            <Grid>
              <Grid.Col span={{ base: 12, md: 9 }}>
                <Stack gap="lg">
                  <Title order={1}>{club.name}</Title>
                  {club.description && (
                    <ContentClamp maxHeight={500}>
                      <RenderHtml html={club.description} />
                    </ContentClamp>
                  )}
                  <Group>
                    {canPost && (
                      <Button
                        onClick={() => {
                          dialogStore.trigger({
                            component: ClubAddContent,
                            props: {
                              clubId: club.id,
                            },
                          });
                        }}
                        leftSection={<IconPlus />}
                      >
                        Add content
                      </Button>
                    )}
                    {(isOwner || isClubAdmin || isModerator) && (
                      <Button
                        component={'a'}
                        href={`/clubs/manage/${club.id}`}
                        leftSection={<IconSettings />}
                        color="gray"
                      >
                        Manage
                      </Button>
                    )}
                  </Group>
                  <ClubFeedNavigation id={club.id} />
                </Stack>
                {children}
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 3 }}>
                <Stack>
                  <Title order={3}>Membership Tiers</Title>
                  <ClubMembershipStatus clubId={club.id} />
                  {tiers.length > 0 ? (
                    <>
                      {tiers.map((tier) => (
                        <ClubTierItem key={tier.id} clubTier={tier} />
                      ))}
                    </>
                  ) : (
                    <Text c="dimmed">The owner of this club has not added any club tiers yet.</Text>
                  )}
                </Stack>
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
