import { Anchor, Button, Group, Stack, Title } from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import { z } from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { useClubContributorStatus, useQueryClub } from '~/components/Club/club.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import React, { useState } from 'react';
import { ClubManagementLayout } from '~/pages/clubs/manage/[id]/index';
import { BuzzDashboardOverview } from '~/components/Buzz/Dashboard/BuzzDashboardOverview';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { ClubAdminPermission } from '@prisma/client';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ClubWithdrawFunds } from '~/components/Club/ClubWithdrawFunds';
import { NextLink } from '@mantine/next';
import { ClubDepositFunds } from '../../../../components/Club/ClubDepositFunds';

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
    const canViewRevenue =
      clubAdmin?.permissions.includes(ClubAdminPermission.ViewRevenue) ?? false;

    if (!isOwner && !isModerator && !canViewRevenue)
      return {
        redirect: {
          destination: `/clubs/${id}`,
          permanent: false,
        },
      };

    if (ssg) {
      await ssg.club.getById.prefetch({ id });
    }

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: true,
    //   },
    // };

    return { props: { id } };
  },
});

export default function Revenue({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { club, loading } = useQueryClub({ id });
  const { balance } = useBuzz(id, 'Club');
  const { isOwner, permissions } = useClubContributorStatus({
    clubId: id,
  });
  const hasBalance = (balance ?? 0) > 0;
  const canWithdraw =
    hasBalance && (isOwner || permissions.includes(ClubAdminPermission.WithdrawRevenue));
  const canDeposit = isOwner;

  if (loading) return <PageLoader />;
  if (!club) return <NotFound />;

  return (
    <Stack spacing="md">
      <Group position="apart">
        <Title order={2}>Club Revenue</Title>

        <Group>
          {canWithdraw && (
            <Button
              size="sm"
              onClick={() => {
                dialogStore.trigger({
                  component: ClubWithdrawFunds,
                  props: { clubId: id },
                });
              }}
            >
              Withdraw funds
            </Button>
          )}
          {canDeposit && (
            <Button
              size="sm"
              onClick={() => {
                dialogStore.trigger({
                  component: ClubDepositFunds,
                  props: { clubId: id },
                });
              }}
            >
              Deposit funds
            </Button>
          )}
        </Group>
      </Group>
      <Anchor size="sm" target="_blank" href="/content/buzz/terms">
        Buzz Agreement
      </Anchor>
      <BuzzDashboardOverview accountId={club.id} accountType="Club" />
    </Stack>
  );
}

Revenue.getLayout = function getLayout(page: React.ReactNode) {
  return <ClubManagementLayout>{page}</ClubManagementLayout>;
};
