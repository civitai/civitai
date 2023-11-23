import {
  Anchor,
  Box,
  Button,
  Center,
  Container,
  Grid,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
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
import React, { useState } from 'react';
import { ClubUpsertForm } from '~/components/Club/ClubUpsertForm';
import { trpc } from '~/utils/trpc';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { IconAlertCircle } from '@tabler/icons-react';
import { ClubManagementLayout } from '~/pages/clubs/manage/[id]/index';
import { ClubTierUpsertForm } from '~/components/Club/ClubTierUpsertForm';
import { ClubTierManageItem } from '~/components/Club/ClubTierManageItem';

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

    if (ssg) {
      await ssg.club.getById.prefetch({ id });
      await ssg.club.getTiers.prefetch({
        clubId: id,
        joinableOnly: false,
        listedOnly: false,
        include: ['membershipsCount'],
      });
    }

    return { props: { id } };
  },
});

export default function ManageClubTiers({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { club, loading } = useQueryClub({ id });
  const {
    data: tiers = [],
    isLoading: isLoadingTiers,
    isRefetching,
  } = trpc.club.getTiers.useQuery({
    clubId: id,
    joinableOnly: false,
    listedOnly: false,
    include: ['membershipsCount'],
  });

  const [addNewTier, setAddNewTier] = useState<boolean>(false);

  if (!loading && !club) return <NotFound />;
  if (loading || isLoadingTiers) return <PageLoader />;

  return (
    <Stack spacing="md">
      <Title order={2}>Manage Club&rsquo;s Tiers</Title>
      <Text>
        Tiers are a way for you to offer different perks to your members. You can create as many
        tiers as you want.
      </Text>

      {tiers.map((tier) => (
        <ClubTierManageItem clubTier={tier} key={tier.id} />
      ))}
      {isRefetching && (
        <Center>
          <Loader />
        </Center>
      )}
      {tiers.length === 0 && !isRefetching && (
        <Center>
          <Text color="dimmed">It looks like you have not added any tiers yet.</Text>
        </Center>
      )}
      {club && (
        <>
          {addNewTier ? (
            <Paper withBorder p="md">
              <ClubTierUpsertForm
                clubId={club.id}
                onCancel={() => setAddNewTier(false)}
                onSuccess={() => {
                  setAddNewTier(false);
                }}
              />
            </Paper>
          ) : (
            <Button onClick={() => setAddNewTier(true)} loading={isRefetching}>
              Add new tier
            </Button>
          )}
        </>
      )}
    </Stack>
  );
}

ManageClubTiers.getLayout = ClubManagementLayout;
