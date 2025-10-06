import { Button, Center, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { useQueryClub } from '~/components/Club/club.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import React, { useState } from 'react';
import { ClubManagementLayout } from '~/pages-old/clubs/manage/[id]/index';
import { ClubMembershipInfinite } from '~/components/Club/Infinite/ClubsMembershipInfinite';
import { ClubAdminPermission } from '~/shared/utils/prisma/enums';

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
    const canManageMemberships =
      clubAdmin?.permissions.includes(ClubAdminPermission.ManageMemberships) ?? false;

    if (!isOwner && !isModerator && !canManageMemberships)
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
      });
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

export default function ManageClubMembers({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { club, loading } = useQueryClub({ id });

  if (!loading && !club) return <NotFound />;
  if (loading) return <PageLoader />;

  return (
    <Stack gap="md">
      <Title order={2}>Manage Members</Title>
      <Text>
        You can see who has joined your club, how long they&apos;ve been a member, and the club tier
        they&apos;re in.
      </Text>
      <ClubMembershipInfinite clubId={id} />
    </Stack>
  );
}

ManageClubMembers.getLayout = function getLayout(page: React.ReactNode) {
  return <ClubManagementLayout>{page}</ClubManagementLayout>;
};
