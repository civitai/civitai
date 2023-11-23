import { Box, Center, Container, Grid, Loader, Paper, Stack, Title } from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import { z } from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useQueryBounty } from '~/components/Bounty/bounty.utils';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { BountyGetById } from '~/types/router';
import { ClubManagementNavigation } from '~/components/Club/ClubManagementNavigation';
import { InputText } from '~/libs/form';
import { useRouter } from 'next/router';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';
import UserProfileEntry from '~/pages/user/[username]';
import { useQueryClub } from '~/components/Club/club.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import React from 'react';
import { ClubUpsertForm } from '~/components/Club/ClubUpsertForm';

const querySchema = z.object({ id: z.coerce.number() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ session, features, ctx, ssg }) => {
    if (!features?.clubs) return { notFound: true };

    if (!session)
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };

    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };

    const { id } = result.data;
    const club = await dbRead.club.findUnique({
      where: { id },
      select: { userId: true },
    });

    if (!club) return { notFound: true };

    const isModerator = session.user?.isModerator ?? false;
    const isOwner = club.userId === session.user?.id || isModerator;
    if (!isOwner && !isModerator)
      return {
        redirect: {
          destination: `/clubs/${id}`,
          permanent: false,
        },
      };

    if (ssg) await ssg.club.getById.prefetch({ id });

    return { props: { id } };
  },
});

export default function ManageClub({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { club, loading } = useQueryClub({ id });

  if (!loading && !club) return <NotFound />;
  if (loading) return <PageLoader />;

  return (
    <Stack>
      <Title order={2}>General Settings</Title>
      <Paper withBorder p="md">
        <ClubUpsertForm club={club} />
      </Paper>
    </Stack>
  );
}

export const ClubManagementLayout = (page: React.ReactElement) => {
  const router = useRouter();
  const { id: stringId } = router.query as { id: string };
  const id = Number(stringId);
  const { club, loading } = useQueryClub({ id });

  if (loading) {
    return <PageLoader />;
  }

  if (!club) {
    return <NotFound />;
  }

  return (
    <AppLayout>
      <Container size="xl">
        <Stack spacing="md">
          <Stack spacing={4}>
            {club.avatar && (
              <Box
                style={{
                  width: 124,
                  height: 124,
                  position: 'relative',
                  borderRadius: '8px',
                  overflow: 'hidden',
                }}
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
                                edgeImageProps={{ width: 1200 }}
                                radius="md"
                                style={{ width: '100%' }}
                              />
                            )}
                            <div style={{ width: '100%', height: '100%' }}>
                              <ImageGuard.ToggleConnect position="top-left" />
                              <ImageGuard.Report />
                            </div>
                          </>
                        )}
                      </ImageGuard.Content>
                    );
                  }}
                />
              </Box>
            )}
            <Title order={1}>{club.name}</Title>
          </Stack>
          <Grid>
            <Grid.Col xs={12} md={3}>
              <ClubManagementNavigation id={id} />
            </Grid.Col>
            <Grid.Col xs={12} md={9}>
              {page}
            </Grid.Col>
          </Grid>
        </Stack>
      </Container>
    </AppLayout>
  );
};

ManageClub.getLayout = ClubManagementLayout;
