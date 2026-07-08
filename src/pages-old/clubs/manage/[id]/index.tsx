import {
  Alert,
  Anchor,
  Button,
  Container,
  Divider,
  Grid,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconAlertCircle, IconArrowLeft, IconTrash } from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import React from 'react';
import * as z from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import {
  useClubContributorStatus,
  useMutateClub,
  useQueryClub,
} from '~/components/Club/club.utils';
import { ClubManagementNavigation } from '~/components/Club/ClubManagementNavigation';
import { ClubUpsertForm } from '~/components/Club/ClubUpsertForm';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ClubAdminPermission } from '~/shared/utils/prisma/enums';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import classes from '~/components/Club/ClubPost/ClubFeed.module.scss';

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

    const clubAdmin = await dbRead.clubAdmin.findFirst({
      where: { clubId: id, userId: session.user?.id },
    });

    const isModerator = session.user?.isModerator ?? false;
    const isOwner = club.userId === session.user?.id || isModerator;
    const isAdmin = !!clubAdmin;

    if (!isOwner && !isModerator && !isAdmin)
      return {
        redirect: {
          destination: `/clubs/${id}`,
          permanent: false,
        },
      };

    if (ssg) await ssg.club.getById.prefetch({ id });

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: true,
    //   },
    // };

    return { props: { id } };
  },
});

export default function ManageClub({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const { club, loading } = useQueryClub({ id });
  const { deleteClub, deletingClub } = useMutateClub();
  const { isOwner, isModerator, permissions } = useClubContributorStatus({ clubId: id });

  if (!loading && !club) return <NotFound />;
  if (loading || deletingClub) return <PageLoader />;
  const onDelete = () => {
    const handleDelete = async () => {
      await deleteClub({ id });
      showSuccessNotification({
        title: 'Club deleted',
        message: 'Your club has been deleted successfully',
      });
      router.push(`/clubs`);
    };

    openConfirmModal({
      centered: true,
      title: 'Delete club',
      children: (
        <Stack>
          <Text>Are you sure you want to delete this club?</Text>
          <Text>
            Buzz in this club will be transfered to your account, but will not be refunded to your
            members.
          </Text>
          <Text c="red" fw="bold">
            This action is not reversible
          </Text>
        </Stack>
      ),
      labels: { cancel: `Cancel`, confirm: `Delete Club` },
      confirmProps: { color: 'red' },
      closeOnConfirm: true,
      onConfirm: handleDelete,
    });
  };

  const canUpdateClub =
    isOwner || isModerator || permissions.includes(ClubAdminPermission.ManageClub);

  return (
    <Stack>
      <Title order={2}>General Settings</Title>
      <Paper className={classes.feedContainer}>
        {canUpdateClub ? (
          <ClubUpsertForm
            club={club}
            onSave={() => {
              showSuccessNotification({
                title: 'Club updated',
                message: 'Your club has been updated successfully',
              });
            }}
          />
        ) : (
          <Alert title="You cannot update club settings" color="transparent">
            You have permission to manage some aspects of this club, but club description and
            general settings are not among those.
          </Alert>
        )}
      </Paper>
      {(isOwner || isModerator) && (
        <>
          <Divider labelPosition="center" label="Danger zone" color="red" />
          <Paper className={classes.feedContainer}>
            <Stack gap="lg">
              <Title order={3}>Delete this club</Title>
              <Text>
                By deleting this club, all resources in it will be automatically be made publicly
                available, meaning users will not lose access to the resources, however, Buzz will
                not be refunded to any of your members, so use with care.
              </Text>
              <Button color="red" mt="lg" fullWidth onClick={onDelete} leftSection={<IconTrash />}>
                Delete this club
              </Button>
            </Stack>
          </Paper>
        </>
      )}
    </Stack>
  );
}

export const ClubManagementLayout = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const { data: club, isLoading: loading } = trpc.club.getById.useQuery({ id });

  if (loading) {
    return <PageLoader />;
  }

  if (!club) {
    return <NotFound />;
  }

  const setupIncomplete = !club.hasTiers || !club.hasPosts;

  return (
    <AppLayout>
      <Container size="xl">
        <Stack gap="md">
          <Stack gap="md">
            <Link legacyBehavior href={`/clubs/${club.id}`} passHref shallow>
              <Anchor size="sm">
                <Group gap={4}>
                  <IconArrowLeft />
                  <Text inherit>Back to clubs feed page</Text>
                </Group>
              </Anchor>
            </Link>
            {/* {club.avatar && (
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
            )} */}
            <Title order={1}>{club.name}</Title>
            {setupIncomplete && (
              <AlertWithIcon color="yellow" iconColor="yellow" icon={<IconAlertCircle />}>
                Looks like your club is not complete and will not show up in the clubs feed for
                others to join. In order to complete your setup, you should:
                <ul>
                  {!club.hasTiers && (
                    <li>
                      <Anchor href={`/clubs/manage/${club.id}/tiers`}>
                        Setup one joinable tier
                      </Anchor>
                    </li>
                  )}
                  {!club.hasPosts && (
                    <li>
                      <Anchor href={`/clubs/${club.id}`}>Make at least one post </Anchor>
                    </li>
                  )}
                </ul>
              </AlertWithIcon>
            )}
          </Stack>
          <Grid>
            <Grid.Col span={{ base: 12, md: 2 }}>
              <ClubManagementNavigation id={id} />
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 10 }}>{children}</Grid.Col>
          </Grid>
        </Stack>
      </Container>
    </AppLayout>
  );
};

ManageClub.getLayout = function getLayout(page: React.ReactNode) {
  return <ClubManagementLayout>{page}</ClubManagementLayout>;
};
